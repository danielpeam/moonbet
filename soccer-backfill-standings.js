/**
 * soccer-backfill-standings.js
 *
 * Fills in missing seasons in `public.soccer_standings` from API-Football,
 * for the 122 domestic leagues in SELECTED_LEAGUE_IDS below (the merged
 * union of your moonbet_domestic_leagues.xlsx shortlist and
 * soccer-sync-fixtures-odds.js's live cron list), going back to 2009,
 * without re-fetching (or re-paying API calls for) seasons you already
 * have. Existing rows are never touched.
 *
 * If domestic-leagues.json (from list-domestic-leagues.js) is present in
 * this folder, it's used to skip any league/season combo the API itself has
 * no standings coverage for, and to fill in league names. It's optional -
 * the SELECTED_LEAGUE_IDS list below is what actually drives which leagues
 * get processed.
 *
 * How it decides what to fetch:
 *   1. Loops over SELECTED_LEAGUE_IDS (122 merged domestic leagues).
 *   2. For each league, reads which seasons already exist in the DB.
 *   3. For every season from START_SEASON (2009) to the current year that
 *      is NOT already in the DB for that league (and, if
 *      domestic-leagues.json is present, that the API has coverage for),
 *      calls the API-Football /standings endpoint and upserts the rows.
 *   4. The current season is always re-fetched (config below), since it
 *      changes week to week - everything before it is only fetched once.
 *   5. Upsert is on (league_id, season, team_id) with ignoreDuplicates,
 *      matching the existing `unique_league_season_team` constraint, so
 *      even if a season is re-run nothing gets overwritten or duplicated.
 *
 * Setup:
 *   npm install @supabase/supabase-js dotenv
 *   cp .env.example .env   (fill in the three values)
 *   node soccer-backfill-standings.js
 *
 * Notes:
 *   - Uses Node's built-in fetch (Node 18+). If you're on an older Node,
 *     `npm install node-fetch` and it'll be used automatically as a fallback.
 *   - Network errors (dropped connections, "premature close", etc.) are
 *     retried with backoff INSIDE the same request.
 *   - REQUEST_DELAY_MS throttles calls; PROGRESS_FILE lets you stop and
 *     resume without re-doing work already completed in this run.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// ---------- CONFIG ----------

// Union of your reviewed 57-league shortlist (moonbet_domestic_leagues.xlsx)
// AND the 95 leagues already hardcoded in soccer-sync-fixtures-odds.js (the
// live GitHub cron). 122 unique leagues, 30 of which overlapped. Keeping all
// three scripts (this one, soccer-backfill-results.js,
// soccer-sync-fixtures-odds.js) on the exact same list so standings/results
// history and live fixtures/odds never drift apart again.
const SELECTED_LEAGUE_IDS = [
  39, 40, 41, 42, 43, 44, 61, 62, 63, 71, 72, 78, 79, 80, 88, 89, 94, 95, 98,
  99, 103, 104, 106, 107, 110, 111, 113, 114, 119, 120, 128, 129, 132, 135,
  136, 140, 141, 144, 145, 164, 169, 170, 172, 173, 179, 180, 183, 184, 186,
  187, 188, 191, 197, 200, 203, 204, 207, 208, 210, 211, 218, 219, 233, 234,
  239, 240, 244, 245, 250, 253, 254, 258, 261, 262, 265, 268, 269, 271, 272,
  280, 281, 283, 284, 286, 287, 299, 300, 301, 306, 310, 311, 312, 318, 319,
  322, 326, 328, 329, 332, 333, 344, 345, 355, 357, 358, 361, 364, 370, 373,
  380, 381, 387, 388, 390, 392, 393, 406, 407, 408, 419, 568, 570,
];

const START_SEASON = 2009;
const END_SEASON = new Date().getFullYear(); // current year, adjust if needed
const REFETCH_CURRENT_SEASON = true; // always refresh END_SEASON even if present
const REQUEST_DELAY_MS = 900; // be polite to the API / stay under rate limits
const REQUEST_TIMEOUT_MS = 20000; // abort a hung request after 20s
const PROGRESS_FILE = './backfill-progress.json';
const MAX_RETRIES = 5;
const DOMESTIC_LEAGUES_FILE = './domestic-leagues.json';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !API_FOOTBALL_KEY) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or API_FOOTBALL_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Node 18+ ships a built-in fetch; fall back to node-fetch if it's missing
// (older Node versions, or if global fetch was somehow disabled).
let _fetchPromise = null;
function getFetch() {
  if (!_fetchPromise) {
    _fetchPromise =
      typeof fetch !== 'undefined'
        ? Promise.resolve(fetch)
        : import('node-fetch').then((m) => m.default);
  }
  return _fetchPromise;
}

// ---------- PROGRESS TRACKING (so you can Ctrl+C and resume) ----------
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}
function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches one league/season of standings. Any failure - a bad HTTP status,
 * a malformed JSON body, or a raw network error like "Premature close" -
 * is caught HERE and retried with backoff, instead of escaping the retry
 * loop (that was the bug in the previous version).
 */
async function fetchStandings(leagueId, season) {
  const doFetch = await getFetch();
  const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await doFetch(url, {
        headers: { 'x-apisports-key': API_FOOTBALL_KEY },
        signal: controller.signal,
      });

      if (res.status === 429) {
        const waitMs = 5000 * attempt;
        console.warn(`  Rate limited on league ${leagueId} season ${season}, waiting ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();

      if (json.errors && Array.isArray(json.errors) ? json.errors.length > 0 : Object.keys(json.errors || {}).length > 0) {
        console.warn(`  API error for league ${leagueId} season ${season}:`, json.errors);
        return [];
      }

      return json.response || [];
    } catch (err) {
      lastErr = err;
      const waitMs = 1500 * attempt;
      console.warn(
        `  Attempt ${attempt}/${MAX_RETRIES} failed for league ${leagueId} season ${season} (${err.message}). Retrying in ${waitMs}ms...`
      );
      await sleep(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Gave up after ${MAX_RETRIES} retries: league ${leagueId} season ${season}: ${lastErr?.message}`);
}

// API-Football nests standings as response[0].league.standings[groupIndex][teamIndex]
// (groups exist for leagues split into pools/conferences).
function flattenStandingsResponse(apiResponse, fallbackLeagueId, fallbackSeason) {
  const rows = [];
  for (const entry of apiResponse) {
    const league = entry.league;
    if (!league || !league.standings) continue;
    const leagueId = league.id ?? fallbackLeagueId;
    const leagueName = league.name ?? null;
    const season = league.season ?? fallbackSeason;

    for (const group of league.standings) {
      for (const team of group) {
        rows.push({
          league_id: leagueId,
          league_name: leagueName,
          season,
          team_id: team.team?.id ?? null,
          team_name: team.team?.name ?? null,
          rank: team.rank ?? null,
          points: team.points ?? null,
          matches_played: team.all?.played ?? null,
          wins: team.all?.win ?? null,
          draws: team.all?.draw ?? null,
          losses: team.all?.lose ?? null,
        });
      }
    }
  }
  return rows;
}

/**
 * Returns the list of leagues to backfill - always exactly
 * SELECTED_LEAGUE_IDS. If domestic-leagues.json is present, each league is
 * enriched with its proper name and the set of seasons the API actually has
 * standings coverage for (so we skip calls we know will come back empty).
 * Without that file, every league still gets processed, just with every
 * season in range attempted (no coverage pre-filtering) and no name until
 * the API call returns one.
 */
async function getTargetLeagues() {
  let coverageById = new Map();

  if (fs.existsSync(DOMESTIC_LEAGUES_FILE)) {
    const leagues = JSON.parse(fs.readFileSync(DOMESTIC_LEAGUES_FILE, 'utf8'));
    for (const l of leagues) {
      coverageById.set(l.league_id, {
        league_name: l.league_name,
        seasonsWithCoverage: new Set(l.seasons_with_standings || []),
      });
    }
    console.log(`Loaded coverage data for ${coverageById.size} domestic leagues from ${DOMESTIC_LEAGUES_FILE}.`);
  } else {
    console.warn(
      `${DOMESTIC_LEAGUES_FILE} not found - proceeding without season-coverage pre-filtering (every season 2009-${END_SEASON} will be attempted for each league).`
    );
  }

  const missing = SELECTED_LEAGUE_IDS.filter((id) => !coverageById.has(id));
  if (missing.length > 0 && coverageById.size > 0) {
    console.warn(`Note: ${missing.length} of your selected league IDs weren't found in ${DOMESTIC_LEAGUES_FILE}: ${missing.join(', ')}`);
  }

  return SELECTED_LEAGUE_IDS.map((league_id) => {
    const info = coverageById.get(league_id);
    return {
      league_id,
      league_name: info?.league_name ?? `league_${league_id}`,
      seasonsWithCoverage: info?.seasonsWithCoverage ?? null,
    };
  });
}

async function getExistingSeasons(leagueId) {
  const { data, error } = await supabase.from('soccer_standings').select('season').eq('league_id', leagueId);
  if (error) throw error;
  return new Set(data.map((r) => r.season));
}

async function upsertRows(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase.from('soccer_standings').upsert(rows, {
    onConflict: 'league_id,season,team_id',
    ignoreDuplicates: true, // never touch rows that already exist
  });
  if (error) throw error;
}

async function main() {
  console.log(`Backfilling standings from ${START_SEASON} to ${END_SEASON}...`);

  const leagues = await getTargetLeagues();
  const progress = loadProgress();

  for (const { league_id, league_name, seasonsWithCoverage } of leagues) {
    const existingSeasons = await getExistingSeasons(league_id);

    for (let season = START_SEASON; season <= END_SEASON; season++) {
      // Skip seasons the API has no standings coverage for (saves a wasted call).
      if (seasonsWithCoverage && !seasonsWithCoverage.has(season)) continue;

      const key = `${league_id}:${season}`;
      const alreadyDone = progress[key] === 'done';
      const alreadyInDb = existingSeasons.has(season);
      const isCurrentSeason = season === END_SEASON;

      if (alreadyDone) continue;
      if (alreadyInDb && !(isCurrentSeason && REFETCH_CURRENT_SEASON)) {
        progress[key] = 'done';
        continue;
      }

      try {
        const apiResponse = await fetchStandings(league_id, season);
        const rows = flattenStandingsResponse(apiResponse, league_id, season);

        if (rows.length === 0) {
          console.log(`  ${league_name} (${league_id}) ${season}: no data`);
        } else {
          await upsertRows(rows);
          console.log(`  ${league_name} (${league_id}) ${season}: upserted ${rows.length} rows`);
        }

        progress[key] = 'done';
        saveProgress(progress);
      } catch (err) {
        console.error(`  FAILED ${league_name} (${league_id}) ${season}: ${err.message}`);
        // leave progress unmarked so it's retried on next run
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log('Done. Re-run any time - completed league/season pairs are skipped via backfill-progress.json.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
