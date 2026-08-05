/**
 * Refreshes `soccer_current_standings` with each league's live table for
 * its current season. Meant to run on a schedule (cron) so the "current"
 * standings never go stale.
 *
 * Changes from the previous version (2026-08-05):
 *  1. LEAGUE_IDS updated to the same 122-league merged list used by
 *     soccer-backfill-standings.js, soccer-backfill-results.js, and
 *     soccer-sync-fixtures-odds.js (union of the original 95-league cron
 *     list and the 57-league shortlist from moonbet_domestic_leagues.xlsx).
 *     Keep all four scripts on this same list going forward.
 *  2. Was: wipe the ENTIRE table up front, then insert league-by-league.
 *     If any league failed partway through (network blip, rate limit),
 *     every league after it was left completely empty until the next
 *     successful run - there was no retry, so a single "Premature close"
 *     style error could blank out most of the table.
 *     Now: each league's old rows are deleted and replaced individually,
 *     immediately after a successful fetch for that league. A failure on
 *     one league leaves every other league's data (from its last
 *     successful run) untouched.
 *  3. Added retry-with-backoff around both API calls per league (season
 *     lookup + standings fetch), matching the pattern used in
 *     soccer-backfill-standings.js.
 *
 * Note: soccer_current_standings.points2top / mooncentile / moongrade are
 * left alone by this script (as before) - those live in
 * soccer_current_standings_grades, a separate view. This script only
 * refreshes the raw table.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY, API_FOOTBALL_KEY
 * Run: node soccer-update-current-standings.js
 */

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ================== CONFIG ==================
const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const SLEEP_MS = 200; // small delay to be nice to the API
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 20000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// If you decide to pull from DB later, set DYNAMIC_LEAGUES=true and implement load from Supabase.
const DYNAMIC_LEAGUES = false;

// Same 122 merged leagues as soccer-backfill-standings.js,
// soccer-backfill-results.js, and soccer-sync-fixtures-odds.js.
const LEAGUE_IDS = [
  39, 40, 41, 42, 43, 44, 61, 62, 63, 71, 72, 78, 79, 80, 88, 89, 94, 95, 98,
  99, 103, 104, 106, 107, 110, 111, 113, 114, 119, 120, 128, 129, 132, 135,
  136, 140, 141, 144, 145, 164, 169, 170, 172, 173, 179, 180, 183, 184, 186,
  187, 188, 191, 197, 200, 203, 204, 207, 208, 210, 211, 218, 219, 233, 234,
  239, 240, 244, 245, 250, 253, 254, 258, 261, 262, 265, 268, 269, 271, 272,
  280, 281, 283, 284, 286, 287, 299, 300, 301, 306, 310, 311, 312, 318, 319,
  322, 326, 328, 329, 332, 333, 344, 345, 355, 357, 358, 361, 364, 370, 373,
  380, 381, 387, 388, 390, 392, 393, 406, 407, 408, 419, 568, 570,
];

// =============== helpers ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps an axios GET with retry + backoff, so a dropped connection or a
 * transient 429/5xx doesn't kill the whole run - it just retries that one
 * call before giving up on that league.
 */
async function getWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers: { 'x-apisports-key': API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
      });
      return data;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const isRateLimited = status === 429;
      const waitMs = isRateLimited ? 5000 * attempt : 1500 * attempt;
      console.warn(
        `  Attempt ${attempt}/${MAX_RETRIES} failed for ${url} (${err?.response?.data ? JSON.stringify(err.response.data) : err.message}). Retrying in ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }
  throw new Error(`Gave up after ${MAX_RETRIES} retries: ${url}: ${lastErr?.message}`);
}

async function getCurrentSeason(leagueId) {
  try {
    const data = await getWithRetry(`${API_BASE}/leagues?id=${leagueId}`);
    const seasons = data?.response?.[0]?.seasons || [];
    const current = seasons.find((s) => s.current) || seasons[seasons.length - 1];
    return current?.year ?? null;
  } catch (e) {
    console.warn(`⚠️ season lookup failed for league ${leagueId}:`, e.message);
    return null;
  }
}

async function loadLeagueIdsFromSupabase() {
  // Optional: if you later add active_leagues view
  const { data, error } = await supabase.from('active_leagues').select('league_id');
  if (error) throw error;
  return (data || []).map((r) => r.league_id);
}

/**
 * Replaces one league's rows: delete what's there, then insert the fresh
 * set. Scoped to a single league_id so a failure on a later league can
 * never touch this one's already-committed data.
 */
async function replaceLeagueRows(leagueId, rows) {
  const { error: delErr } = await supabase.from('soccer_current_standings').delete().eq('league_id', leagueId);
  if (delErr) throw new Error(`delete failed: ${delErr.message}`);

  if (rows.length === 0) return; // league had no standings this run - leave it empty, not stale

  const { error: insErr } = await supabase.from('soccer_current_standings').insert(rows);
  if (insErr) throw new Error(`insert failed: ${insErr.message}`);
}

// =============== main job ===================
async function updateCurrentStandings() {
  console.log('🔵 RUNNING: update soccer_current_standings for selected leagues');

  const leagueIds = DYNAMIC_LEAGUES ? await loadLeagueIdsFromSupabase() : LEAGUE_IDS;
  console.log(`📚 Processing ${leagueIds.length} leagues`);

  let succeeded = 0;
  let failed = 0;

  for (const leagueId of leagueIds) {
    try {
      const season = await getCurrentSeason(leagueId);
      if (!season) {
        console.warn(`⚠️ Skipping league ${leagueId}: no season found (leaving existing rows as-is)`);
        failed++;
        await sleep(SLEEP_MS);
        continue;
      }

      const data = await getWithRetry(`${API_BASE}/standings?league=${leagueId}&season=${season}`);

      const respLeague = data?.response?.[0]?.league;
      const leagueName = respLeague?.name ?? `League ${leagueId}`;
      const standings = respLeague?.standings?.[0];

      if (!standings?.length) {
        console.warn(`⚠️ No standings for ${leagueName} (${leagueId}) ${season} (leaving existing rows as-is)`);
        await sleep(SLEEP_MS);
        continue;
      }

      const rows = standings.map((row) => ({
        league_id: leagueId,
        league_name: leagueName,
        season,
        team_id: row.team?.id ?? null,
        team_name: row.team?.name ?? null,
        rank: row.rank ?? null,
        points: row.points ?? null,
        matches_played: row.all?.played ?? null,
        wins: row.all?.win ?? null,
        draws: row.all?.draw ?? null,
        losses: row.all?.lose ?? null,
        updated_at: new Date().toISOString(),
      }));

      await replaceLeagueRows(leagueId, rows);
      console.log(`✅ ${leagueName} (${leagueId}) ${season}: replaced with ${rows.length} rows`);
      succeeded++;

      await sleep(SLEEP_MS);
    } catch (err) {
      console.error(`🔥 Failed league ${leagueId} (leaving existing rows as-is):`, err.message);
      failed++;
      await sleep(SLEEP_MS);
    }
  }

  console.log(`🏁 Done. ${succeeded} leagues refreshed, ${failed} failed/skipped (their previous data was left untouched).`);
}

updateCurrentStandings();
