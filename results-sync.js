require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const apiKey = process.env.API_FOOTBALL_KEY;

// --- helpers ---------------------------------------------------------------
async function loadAllLeagues() {
  const { data, error } = await supabase
    .from('league_catalog')
    .select('league_id, league_name, country, enabled')
    .eq('enabled', true)                    // ⭐ ONLY use enabled leagues
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

async function fetchAndStoreResults(leagueId, leagueName, season) {
  try {
    const { data } = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': apiKey },
      params: {
        league: leagueId,
        season,
        from: '2025-12-01',
        to: '2025-12-31'
      }
    });

    const fixtures = data?.response || [];
    if (!fixtures.length) {
      console.warn(`⚠️ No fixtures for ${leagueName} December ${season}`);
      return;
    }

    const rows = fixtures.map(f => ({
      fixture_id: f.fixture.id,
      league_id: leagueId,
      league_name: leagueName,
      season,
      date: f.fixture.date,
      home_team_id: f.teams.home.id,
      home_team_name: f.teams.home.name,
      away_team_id: f.teams.away.id,
      away_team_name: f.teams.away.name,
      home_goals: f.goals.home,
      away_goals: f.goals.away,
      status: f.fixture.status.short,
      home_yellow: null,
      away_yellow: null,
      home_red: null,
      away_red: null,
      home_corners: null,
      away_corners: null
    }));

    const { error } = await supabase.from('results').upsert(rows, { onConflict: ['fixture_id'] });
    if (error) console.error(`❌ Insert error ${leagueName} ${season}:`, error.message);
    else console.log(`✅ ${leagueName} December ${season}: ${rows.length} fixtures upserted`);
  } catch (err) {
    console.error(`🔥 API error ${leagueName} December ${season}:`, err.message);
  }
}

(async () => {
  let leagues = [];
  try {
    leagues = await loadAllLeagues();
    console.log(`📚 Loaded ${leagues.length} enabled leagues from league_catalog`);
  } catch (e) {
    console.error('❌ Could not load leagues:', e.message);
    process.exit(1);
  }

  // only run for 2025 (December)
  const year = 2025;
  for (const league of leagues) {
    await fetchAndStoreResults(league.id, league.name, year);
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('🏁 Done.');
})();
