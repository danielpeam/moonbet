/**
 * soccer-backfill-results.js
 *
 * Same approach as soccer-backfill-standings.js, applied to
 * `public.soccer_results`: fills in missing seasons for the 122 merged
 * domestic leagues in SELECTED_LEAGUE_IDS (union of your
 * moonbet_domestic_leagues.xlsx shortlist and
 * soccer-sync-fixtures-odds.js's live cron list), going back to 2009,
 * without re-fetching seasons you already have. Existing rows are never
 * touched.
 *
 * Row shape matches the current `soccer_results` table AFTER home_mg/away_mg
 * were dropped (those now live in a separate view, out of scope for this
 * script).
 *
 * How it decides what to fetch:
 *   1. Loops over SELECTED_LEAGUE_IDS (same 122 leagues as the standings
 *      backfill).
 *   2. For each league, reads which seasons already exist in
 *      `soccer_results`.
 *   3. For every season from START_SEASON (2009) to the current year that
 *      is NOT already in the DB for that league, calls the API-Football
 *      /fixtures endpoint (one call returns the WHOLE season's fixtures)
 *      and upserts the rows.
 *   4. Each league's ACTUAL current season is looked up dynamically from
 *      API-Football (not assumed to be "this calendar year" - European
 *      leagues span two calendar years, so from Jan-Jul the in-progress
 *      season is still labelled by the previous year). That season is
 *      always re-fetched, since matches keep being played - everything
 *      before it is only fetched once. This costs one extra API call per
 *      league per run (a /leagues lookup), on top of whatever /fixtures
 *      calls are actually needed.
 *   5. Upsert is on `fixture_id` (the table's existing unique constraint)
 *      with ignoreDuplicates: true, so re-running never overwrites a row
 *      that's already there - including on the current season, where only
 *      genuinely NEW fixtures get inserted; existing ones (even if their
 *      status has since changed, e.g. NS -> FT) are left as-is. If you
 *      later want "refresh recent results" behaviour instead, that needs a
 *      different script - this one is strictly additive, matching how the
 *      standings backfill works.
 *
 * Fields NOT populated by this script (left absent from the upsert so
 * existing values, if any, are never touched): home_yellow, away_yellow,
 * home_red, away_red, home_corners, away_corners. The bulk /fixtures
 * endpoint doesn't return match statistics - those need a separate
 * per-fixture call (/fixtures/statistics) and were never populated by the
 * historical loader either.
 *
 * Setup:
 *   npm install @supabase/supabase-js dotenv
 *   cp .env.example .env   (reuse the same .env as the standings backfill)
 *   node soccer-backfill-results.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// ---------- CONFIG ----------

// Same 122 merged leagues as soccer-backfill-standings.js and
// soccer-sync-fixtures-odds.js.
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
const FALLBACK_END_SEASON = new Date().getFullYear(); // only used if the /leagues lookup fails
const REFETCH_CURRENT_SEASON = true; // always re-check each league's actual current season
const REQUEST_DELAY_MS = 900; // be polite to the API / stay under rate limits
const REQUEST_TIMEOUT_MS = 20000; // abort a hung request after 20s
const PROGRESS_FILE = './backfill-results-progress.json';
const MAX_RETRIES = 5;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !API_FOOTBALL_KEY) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or API_FOOTBALL_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Node 18+ ships a built-in fetch; fall back to node-fetch if it's missing.
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
 * Fetches one league/season of fixtures. Any failure - bad HTTP status,
 * malformed JSON, or a raw network error like "Premature close" - is
 * caught and retried with backoff inside this function (not left to
 * escape the retry loop, which was the bug in an earlier version of the
 * standings script).
 */
async function fetchFixtures(leagueId, season) {
  const doFetch = await getFetch();
  const url = `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}`;

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

      const hasErrors = Array.isArray(json.errors) ? json.errors.length > 0 : Object.keys(json.errors || {}).length > 0;
      if (hasErrors) {
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

/**
 * Looks up the league's actual current season from API-Football (the
 * `seasons[].current === true` flag), instead of assuming it's whatever
 * calendar year the script happens to run in. Falls back to
 * FALLBACK_END_SEASON if the lookup fails for any reason, so a single bad
 * call never stops the whole league from being processed.
 */
async function getCurrentSeason(leagueId) {
  const doFetch = await getFetch();
  const url = `https://v3.football.api-sports.io/leagues?id=${leagueId}`;

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
        console.warn(`  Rate limited on season lookup for league ${leagueId}, waiting ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const seasons = json?.response?.[0]?.seasons || [];
      const current = seasons.find((s) => s.current) || seasons[seasons.length - 1];
      if (current?.year) return current.year;

      console.warn(`  No season data for league ${leagueId}, falling back to ${FALLBACK_END_SEASON}`);
      return FALLBACK_END_SEASON;
    } catch (err) {
      lastErr = err;
      const waitMs = 1500 * attempt;
      console.warn(`  Attempt ${attempt}/${MAX_RETRIES} failed for season lookup on league ${leagueId} (${err.message}). Retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  console.warn(`  Gave up on season lookup for league ${leagueId} after ${MAX_RETRIES} retries (${lastErr?.message}), falling back to ${FALLBACK_END_SEASON}`);
  return FALLBACK_END_SEASON;
}

function mapFixturesToRows(apiResponse, fallbackLeagueId, fallbackLeagueName, fallbackSeason) {
  return apiResponse.map((f) => ({
    fixture_id: f.fixture?.id,
    league_id: f.league?.id ?? fallbackLeagueId,
    league_name: f.league?.name ?? fallbackLeagueName,
    season: f.league?.season ?? fallbackSeason,
    date: f.fixture?.date ?? null,
    home_team_id: f.teams?.home?.id ?? null,
    home_team_name: f.teams?.home?.name ?? null,
    away_team_id: f.teams?.away?.id ?? null,
    away_team_name: f.teams?.away?.name ?? null,
    home_goals: f.goals?.home ?? null,
    away_goals: f.goals?.away ?? null,
    status: f.fixture?.status?.short ?? null,
    // home_yellow / away_yellow / home_red / away_red / home_corners /
    // away_corners intentionally omitted - not returned by this endpoint,
    // and omitting them (rather than sending null) means an upsert never
    // clobbers a value some other process may have set.
  }));
}

async function getExistingSeasons(leagueId) {
  const { data, error } = await supabase.from('soccer_results').select('season').eq('league_id', leagueId);
  if (error) throw error;
  return new Set(data.map((r) => r.season));
}

async function upsertRows(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase.from('soccer_results').upsert(rows, {
    onConflict: 'fixture_id',
    ignoreDuplicates: true, // never touch rows that already exist
  });
  if (error) throw error;
}

async function main() {
  console.log(`Backfilling results from ${START_SEASON} onward for ${SELECTED_LEAGUE_IDS.length} leagues...`);

  const progress = loadProgress();

  for (const league_id of SELECTED_LEAGUE_IDS) {
    const [existingSeasons, currentSeason] = await Promise.all([
      getExistingSeasons(league_id),
      getCurrentSeason(league_id),
    ]);
    let leagueName = null;

    for (let season = START_SEASON; season <= currentSeason; season++) {
      const key = `${league_id}:${season}`;
      const alreadyDone = progress[key] === 'done';
      const alreadyInDb = existingSeasons.has(season);
      const isCurrentSeason = season === currentSeason;

      if (alreadyDone) continue;
      if (alreadyInDb && !(isCurrentSeason && REFETCH_CURRENT_SEASON)) {
        progress[key] = 'done';
        continue;
      }

      try {
        const apiResponse = await fetchFixtures(league_id, season);

        if (apiResponse.length === 0) {
          console.log(`  league ${league_id} ${season}: no data`);
        } else {
          leagueName = apiResponse[0]?.league?.name ?? leagueName;
          const rows = mapFixturesToRows(apiResponse, league_id, leagueName, season);
          await upsertRows(rows);
          console.log(`  ${leagueName ?? league_id} (${league_id}) ${season}: upserted ${rows.length} fixtures`);
        }

        progress[key] = 'done';
        saveProgress(progress);
      } catch (err) {
        console.error(`  FAILED league ${league_id} season ${season}: ${err.message}`);
        // leave progress unmarked so it's retried on next run
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log('Done. Re-run any time - completed league/season pairs are skipped via backfill-results-progress.json.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
