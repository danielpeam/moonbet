// load-league-catalog.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const leagues = JSON.parse(fs.readFileSync('./leagues.json', 'utf8'));

  // Map to table columns
  const rows = leagues.map(l => ({
    league_id: l.id,
    league_name: l.name,
    country: l.country || null
  }));

  // Upsert in chunks to avoid payload limits
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await supabase
      .from('league_catalog')
      .upsert(slice, { onConflict: 'league_id' });
    if (error) {
      console.error('Upsert error at chunk', i, error);
      process.exit(1);
    }
  }

  console.log('✅ league_catalog upsert complete');
})();
