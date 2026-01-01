require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const apiKey = process.env.API_FOOTBALL_KEY;

// --- helpers ---------------------------------------------------------------
async function loadAllLeagues() {
  const { data, error } = await supabase
    .from('league_catalog')
    .select('league_id, league_name, country')
    .order('league_id', { ascending: true })
    .limit(2000);

  if (error) throw new Error(`Failed to load league catalog: ${error.message}`);

  return data.map(l => ({
    id: l.league_id,
    name: l.league_name,
    country: l.country || null,
  }));
}
// ---------------------------------------------------------------------------

async function fetchAndStore(leagueId, leagueName, season) {
  try {
    const { data } = await axios.get('https://v3.football.api-sports.io/standings', {
      headers: { 'x-apisports-key': apiKey },
      params: { league: leagueId, season }
    });

    const standings = data?.response?.[0]?.league?.standings?.[0];
    if (!standings) {
      console.warn(`⚠️ No standings for ${leagueName} ${season}`);
      return;
    }

    const rows = standings.map(team => ({
      league_id: leagueId,
      league_name: leagueName,
      season,
      team_id: team.team.id,
      team_name: team.team.name,
      rank: team.rank,
      points: team.points,
      matches_played: team.all.played,
      wins: team.all.win,
      draws: team.all.draw,
      losses: team.all.lose
    }));

    const { error } = await supabase
      .from('standings')
      .upsert(rows, { onConflict: ['league_id', 'season', 'team_id'] });

    if (error) console.error(`❌ Insert error: ${leagueName} ${season}`, error.message);
    else console.log(`✅ ${leagueName} ${season}: ${rows.length} rows inserted`);
  } catch (err) {
    console.error(`🔥 API error: ${leagueName} ${season}: ${err.message}`);
  }
}

(async () => {
  let leagues = [];
  try {
    leagues = await loadAllLeagues();
    console.log(`📚 Loaded ${leagues.length} leagues from league_catalog`);
  } catch (e) {
    console.error('❌ Could not load leagues:', e.message);
    process.exit(1);
  }

  for (const league of leagues) {
    for (let year = 1995; year <= new Date().getFullYear(); year++) {
      await fetchAndStore(league.id, league.name, year);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  console.log('🏁 Done.');
})();
