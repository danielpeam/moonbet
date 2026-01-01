require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ================== CONFIG ==================
const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const SLEEP_MS = 200; // small delay to be nice to the API

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// If you decide to pull from DB later, set DYNAMIC_LEAGUES=true and implement load from Supabase.
const DYNAMIC_LEAGUES = false;

// 👇 Paste the SAME list you use in your fixtures/odds scripts
const LEAGUE_IDS = [
  39, 40, 41, 42, 43, 44, 61, 62, 63, 71, 72, 78, 79, 80, 88, 89, 94, 95, 98, 99,
  103, 104, 106, 107, 110, 111, 113, 114, 119, 120, 128, 129, 135, 136, 140, 141,
  144, 145, 164, 169, 170, 172, 173, 179, 180, 183, 184, 188, 197, 200, 203, 204,
  207, 208, 210, 211, 218, 219, 233, 239, 240, 244, 245, 250, 253, 254, 258, 261,
  262, 265, 268, 271, 280, 281, 283, 284, 286, 287, 318, 319, 328, 332, 333, 344,
  345, 355, 357, 358, 361, 364, 373, 392, 393, 407, 408
];

// =============== helpers ====================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getCurrentSeason(leagueId) {
  try {
    const url = `${API_BASE}/leagues?id=${leagueId}`;
    const { data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } });
    const seasons = data?.response?.[0]?.seasons || [];
    const current = seasons.find(s => s.current) || seasons[seasons.length - 1];
    return current?.year ?? null;
  } catch (e) {
    console.warn(`⚠️ season lookup failed for league ${leagueId}:`, e?.response?.data || e.message);
    return null;
  }
}

async function loadLeagueIdsFromSupabase() {
  // Optional: if you later add active_leagues view
  const { data, error } = await supabase.from('active_leagues').select('league_id');
  if (error) throw error;
  return (data || []).map(r => r.league_id);
}

// =============== main job ===================
async function updateCurrentStandings() {
  console.log('🔵 RUNNING: update current_standings for selected leagues');

  // Clear table (keeps schema/PKs)
  console.log('🧽 Clearing current_standings…');
  const { error: delErr } = await supabase.from('current_standings').delete().neq('league_id', -1);
  if (delErr) {
    console.error('❌ Failed to clear current_standings:', delErr.message);
    process.exit(1);
  }

  const leagueIds = DYNAMIC_LEAGUES ? await loadLeagueIdsFromSupabase() : LEAGUE_IDS;
  console.log(`📚 Processing ${leagueIds.length} leagues`);

  for (const leagueId of leagueIds) {
    try {
      const season = await getCurrentSeason(leagueId);
      if (!season) {
        console.warn(`⚠️ Skipping league ${leagueId}: no season found`);
        continue;
      }

      const url = `${API_BASE}/standings?league=${leagueId}&season=${season}`;
      const { data } = await axios.get(url, { headers: { 'x-apisports-key': API_KEY } });

      const respLeague = data?.response?.[0]?.league;
      const leagueName = respLeague?.name ?? `League ${leagueId}`;
      const standings = respLeague?.standings?.[0];

      if (!standings?.length) {
        console.warn(`⚠️ No standings for ${leagueName} (${leagueId}) ${season}`);
        await sleep(SLEEP_MS);
        continue;
      }

      const rows = standings.map(row => ({
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

      const { error } = await supabase.from('current_standings').insert(rows);
      if (error) {
        console.error(`❌ Insert failed for ${leagueName} (${leagueId}) ${season}:`, error.message);
      } else {
        console.log(`✅ ${leagueName} (${leagueId}) ${season}: inserted ${rows.length} rows`);
      }

      await sleep(SLEEP_MS);
    } catch (err) {
      console.error(`🔥 API error for league ${leagueId}:`, err?.response?.data || err.message);
      await sleep(SLEEP_MS);
    }
  }

  console.log('🏁 Done.');
}

updateCurrentStandings();
