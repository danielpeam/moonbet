/**
 * Sync next-7-days fixtures + 1X2 odds into Supabase `fixtures`.
 * Keeps ONLY today..+7 days in the table (API = source of truth).
 *
 * Env (.env):
 *  SUPABASE_URL=
 *  SUPABASE_SERVICE_KEY=
 *  API_FOOTBALL_KEY=
 *
 * Run:
 *  node sync_fixtures_odds.js
 */

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ================== CONFIG ==================
const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const TIMEZONE = 'Europe/London';

const PREFERRED_BOOKMAKER_IDS = [6, 3, 1]; // bet365, Pinnacle, William Hill
const SLEEP_MS = 180;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DYNAMIC_LEAGUES = false;
const LEAGUE_IDS = [
  39, 40, 41, 42, 43, 44, 61, 62, 63, 71, 72, 78, 79, 80, 88, 89, 94, 95, 98, 99,
  103, 104, 106, 107, 110, 111, 113, 114, 119, 120, 128, 129, 135, 136, 140, 141,
  144, 145, 164, 169, 170, 172, 173, 179, 180, 183, 184, 188, 197, 200, 203, 204,
  207, 208, 210, 211, 218, 219, 233, 239, 240, 244, 245, 250, 253, 254, 258, 261,
  262, 265, 268, 271, 280, 281, 283, 284, 286, 287, 318, 319, 328, 332, 333, 344,
  345, 355, 357, 358, 361, 364, 373, 392, 393, 407, 408
];

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);

function extract1X2(bookmakers) {
  if (!bookmakers || !Array.isArray(bookmakers)) return { home: null, draw: null, away: null };

  const sorted = [...bookmakers].sort((a, b) => {
    const ia = PREFERRED_BOOKMAKER_IDS.indexOf(a.id);
    const ib = PREFERRED_BOOKMAKER_IDS.indexOf(b.id);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  for (const bm of sorted) {
    if (!bm?.bets) continue;
    for (const bet of bm.bets) {
      const name = (bet.name || '').toLowerCase();
      const is1x2 = name.includes('match winner') || name === 'winner' || name.includes('1x2');
      if (!is1x2 || !Array.isArray(bet.values)) continue;

      let home = null, draw = null, away = null;
      for (const v of bet.values) {
        const label = (v.value || '').toLowerCase();
        const odd = v.odd != null ? Number(v.odd) : null;
        if (odd == null || Number.isNaN(odd)) continue;
        if (label === 'home' || label === '1') home = odd;
        else if (label === 'draw' || label === 'x') draw = odd;
        else if (label === 'away' || label === '2') away = odd;
      }
      if (home || draw || away) return { home: home ?? null, draw: draw ?? null, away: away ?? null };
    }
  }
  return { home: null, draw: null, away: null };
}

// ---------- API wrappers ----------
async function getCurrentSeason(leagueId) {
  const url = `${API_BASE}/leagues?id=${leagueId}`;
  const { data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } });
  const seasons = data?.response?.[0]?.seasons || [];
  const current = seasons.find(s => s.current) || seasons[seasons.length - 1];
  return current?.year;
}

async function fetchFixturesForLeague(leagueId, fromISO, toISO) {
  const season = await getCurrentSeason(leagueId);
  let url = `${API_BASE}/fixtures?league=${leagueId}&season=${season}&from=${fromISO}&to=${toISO}&timezone=${encodeURIComponent(TIMEZONE)}`;
  let { data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } });
  let res = data?.response || [];

  // fallback: use next and filter locally
  if (res.length === 0) {
    url = `${API_BASE}/fixtures?league=${leagueId}&season=${season}&next=50&timezone=${encodeURIComponent(TIMEZONE)}`;
    ({ data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } }));
    const allNext = data?.response || [];
    res = allNext.filter(f => {
      const d = new Date(f.fixture?.date).toISOString().slice(0, 10);
      return d >= fromISO && d <= toISO;
    });
  }

  return res;
}

async function fetchOddsForFixture(fixtureId) {
  const url = `${API_BASE}/odds?fixture=${fixtureId}&timezone=${encodeURIComponent(TIMEZONE)}`;
  const { data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } });
  const bookmakers = data?.response?.[0]?.bookmakers || [];
  return extract1X2(bookmakers);
}

// ---------- Supabase ----------
async function upsertFixtures(rows) {
  if (!rows.length) return;

  // Dedupe by fixture_id (last write wins)
  const byId = new Map();
  for (const r of rows) {
    if (r.fixture_id == null) continue;
    byId.set(r.fixture_id, r);
  }
  const deduped = Array.from(byId.values());

  const { error } = await supabase
    .from('fixtures')
    // explicitly DO NOT ignore duplicates => update existing rows
    .upsert(deduped, { onConflict: 'fixture_id', ignoreDuplicates: false });

  if (error) {
    console.error('Supabase upsert error:', error);
    throw error;
  }
}

/**
 * Enforce the window and API truth:
 * 1) Inside the window: keep only fixtures returned by API this run.
 * 2) Outside the window: delete everything (for the selected leagues).
 */
async function enforceWindowAndDeleteMissing(fromISO, toISO, leagueIds, keepIds) {
  const fromTs = `${fromISO}T00:00:00.000Z`;
  const toTs   = `${toISO}T23:59:59.999Z`;

  // 1) Inside window: delete anything NOT in keepIds
  let { error } = await supabase
    .from('fixtures')
    .delete()
    .gte('date', fromTs)
    .lte('date', toTs)
    .in('league_id', leagueIds)
    .not('fixture_id', 'in', `(${keepIds.join(',') || 'NULL'})`);
  if (error) console.error('❌ Cleanup (inside window) failed:', error.message);

  // 2) Outside window: delete everything for these leagues
  ({ error } = await supabase
    .from('fixtures')
    .delete()
    .in('league_id', leagueIds)
    .or(`date.lt.${fromTs},date.gt.${toTs}`));
  if (error) console.error('❌ Cleanup (outside window) failed:', error.message);
  else console.log('🧹 Window enforced: fixtures table now only has today..+7 days for selected leagues.');
}

// ---------- Jobs ----------
async function syncUpcomingFixturesAndOdds() {
  const now = new Date();
  const fromISO = isoDate(now);
  const toISO = isoDate(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  console.log(`Fetching fixtures from ${fromISO} to ${toISO} (${TIMEZONE})...`);

  const leagues = DYNAMIC_LEAGUES ? await loadLeagueIdsFromSupabase() : LEAGUE_IDS;
  const all = [];

  for (const lid of leagues) {
    try {
      const fx = await fetchFixturesForLeague(lid, fromISO, toISO);
      console.log(`League ${lid}: ${fx.length} fixtures`);
      all.push(...fx);
      await sleep(120);
    } catch (e) {
      console.warn(`Failed league ${lid}:`, e?.response?.data || e.message);
    }
  }

  if (!all.length) {
    console.log('No fixtures returned for the window.');
    // Still enforce the window so anything lingering is removed.
    await enforceWindowAndDeleteMissing(fromISO, toISO, leagues, []);
    return;
  }

  const rows = [];
  const keepSet = new Set();

  for (const f of all) {
    const fixture = f.fixture || {};
    const league = f.league || {};
    const teams = f.teams || {};
    const home = teams.home || {};
    const away = teams.away || {};

    let homeodds = null, drawodds = null, awayodds = null;
    try {
      const odds = await fetchOddsForFixture(fixture.id);
      homeodds = odds.home;
      drawodds = odds.draw;
      awayodds = odds.away;
    } catch (e) {
      console.warn(`No odds for fixture ${fixture.id}:`, e?.response?.data || e.message);
    }

    if (fixture.id != null) keepSet.add(fixture.id);

    rows.push({
      fixture_id: fixture.id ?? null,
      league_id: league.id ?? null,
      league_name: league.name ?? null,
      season: league.season ?? null,
      date: fixture.date ? new Date(fixture.date).toISOString() : null,
      status: fixture.status?.short ?? null,
      venue: fixture.venue?.name ?? null,
      home_team_id: home.id ?? null,
      home_team_name: home.name ?? null,
      away_team_id: away.id ?? null,
      away_team_name: away.name ?? null,
      homeodds, drawodds, awayodds,
      updated_at: new Date().toISOString(),
    });

    await sleep(SLEEP_MS);
  }

  await upsertFixtures(rows);
  console.log(`✅ Upserted ${rows.length} fixtures (with odds)`);

  await enforceWindowAndDeleteMissing(fromISO, toISO, leagues, Array.from(keepSet));
}

// ---------- entry ----------
(async () => {
  try {
    await syncUpcomingFixturesAndOdds(); // ONLY upcoming fixtures; no results updates.
    console.log('Done.');
  } catch (err) {
    console.error('Fatal error:', err?.response?.data || err);
    process.exit(1);
  }
})();
