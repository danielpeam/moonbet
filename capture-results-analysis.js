/**
 * capture-results-analysis.js
 *
 * Appends newly-finished results into `results_analysis` - a permanent,
 * insert-only log for backtesting/analysis. Each row freezes, at the
 * moment it's captured:
 *   - the match itself (teams, goals, status, date)
 *   - each team's moongrade at that time (from results_with_grades)
 *   - each team's matches played so far this season (from current_standings)
 *   - the odds that were on the match (from fixtures, if still there)
 *   - the full grade-matchup stats for that league (from statistics_v):
 *     total_games, home/away/draw win %, avg goals, over/under 1.5-4.5 %
 *
 * Once a row is written it is NEVER updated - re-running this script only
 * adds fixtures that aren't in results_analysis yet (enforced by both a
 * unique constraint on fixture_id and a NOT EXISTS check inside the
 * capture_results_analysis() Postgres function this script calls).
 *
 * capture_results_analysis() joins against statistics_mv - a materialized
 * snapshot of statistics_v - rather than the live view, because computing
 * statistics_v from scratch means aggregating the full results table
 * (1M+ rows and growing) on every run, which was blowing the statement
 * timeout. After capturing, this script refreshes statistics_mv so the
 * next cron cycle (and anything else reading it) has current grade-matchup
 * stats. This means today's captured rows use stats current as of the
 * previous cycle (up to ~30 min stale) - fine given standings only change
 * 1-2x/year and results shift these percentages gradually.
 *
 * IMPORTANT - cron ordering: this must run AFTER results-sync (so the
 * final score has landed in `results`) and BEFORE sync_fixtures_odds
 * (which deletes any fixture whose date is in the past - odds are only
 * available here if this runs before that cleanup happens, same day the
 * match finished).
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Run: node capture-results-analysis.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

(async () => {
  const { data, error } = await supabase.rpc('capture_results_analysis');

  if (error) {
    console.error('❌ Failed to capture results analysis:', error.message);
    process.exit(1);
  }

  console.log(`✅ Captured ${data} new result(s) into results_analysis.`);

  const { error: refreshError } = await supabase.rpc('refresh_statistics_mv');
  if (refreshError) {
    console.error('⚠️  Failed to refresh statistics_mv:', refreshError.message);
    process.exit(1);
  }

  console.log('✅ Refreshed statistics_mv.');
})();
