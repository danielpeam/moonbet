/**
 * list-domestic-leagues.js
 *
 * Calls API-Football's /leagues endpoint ONCE and builds a definitive list
 * of domestic league-table competitions (type === "League"), excluding cups,
 * qualifiers, and international tournaments (World Cup, Euros, Nations
 * League, Champions League, etc. are all type === "Cup" in this API).
 *
 * For each domestic league, it also records which seasons actually have
 * standings coverage (league.seasons[].coverage.standings === true), so the
 * backfill script never wastes a call on a season the API doesn't have.
 *
 * Output: domestic-leagues.json, shaped like:
 * [
 *   { "league_id": 39, "league_name": "Premier League", "country": "England",
 *     "seasons_with_standings": [2010, 2011, ..., 2025] },
 *   ...
 * ]
 *
 * Also prints:
 *   - how many domestic leagues were found
 *   - which of your old hand-picked IDs (see OLD_LEAGUE_IDS below) turned out
 *     to NOT be type "League" (i.e. were actually cups)
 *   - how many "new" domestic leagues weren't in your old list
 *
 * Usage: node list-domestic-leagues.js
 */

require('dotenv').config();
const fs = require('fs');

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
if (!API_FOOTBALL_KEY) {
  console.error('Missing API_FOOTBALL_KEY in .env');
  process.exit(1);
}

// The league IDs you'd previously curated by hand for the results sync.
// Kept here only so this script can flag differences for you - it is not
// used to filter the output.
const OLD_LEAGUE_IDS = [
  39, 40, 41, 42, 43, 44, 61, 62, 63, 71, 72, 78, 79, 80, 88, 89, 94, 95, 98,
  99, 103, 104, 106, 107, 110, 111, 113, 114, 119, 120, 128, 129, 135, 136,
  140, 141, 144, 145, 164, 169, 170, 172, 173, 179, 180, 183, 184, 188, 197,
  200, 203, 204, 207, 208, 210, 211, 218, 219, 233, 239, 240, 244, 245, 250,
  253, 254, 258, 261, 262, 265, 268, 271, 280, 281, 283, 284, 286, 287, 318,
  319, 328, 332, 333, 344, 345, 355, 357, 358, 361, 364, 373, 392, 393, 407,
  408,
];

// Node 18+ ships a built-in fetch; fall back to node-fetch if it's missing.
async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  const mod = await import('node-fetch');
  return mod.default;
}

async function main() {
  const doFetch = await getFetch();

  console.log('Fetching full league list from API-Football...');
  const res = await doFetch('https://v3.football.api-sports.io/leagues', {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching /leagues`);
  }

  const json = await res.json();
  const all = json.response || [];
  console.log(`API returned ${all.length} total competitions (leagues + cups).`);

  const domestic = all.filter((entry) => entry.league?.type === 'League');
  console.log(`${domestic.length} are domestic league tables (type === "League").`);

  const output = domestic.map((entry) => {
    const seasonsWithStandings = (entry.seasons || [])
      .filter((s) => s.coverage?.standings === true)
      .map((s) => s.year)
      .sort((a, b) => a - b);

    return {
      league_id: entry.league.id,
      league_name: entry.league.name,
      country: entry.country?.name ?? null,
      seasons_with_standings: seasonsWithStandings,
    };
  });

  fs.writeFileSync('./domestic-leagues.json', JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.length} domestic leagues to domestic-leagues.json`);

  // ---- diff against your old hand-picked list, just for visibility ----
  const domesticIds = new Set(output.map((l) => l.league_id));
  const notDomestic = OLD_LEAGUE_IDS.filter((id) => !domesticIds.has(id));
  const newlyFound = output.filter((l) => !OLD_LEAGUE_IDS.includes(l.league_id));

  if (notDomestic.length > 0) {
    console.log(`\n${notDomestic.length} of your old league IDs are NOT type "League" (cups/other):`);
    for (const id of notDomestic) {
      const match = all.find((e) => e.league.id === id);
      console.log(`  ${id}: ${match ? `${match.league.name} (${match.league.type})` : 'not found in API at all'}`);
    }
  }

  console.log(`\n${newlyFound.length} domestic leagues were NOT in your old hand-picked list (new to you):`);
  for (const l of newlyFound.slice(0, 30)) {
    console.log(`  ${l.league_id}: ${l.league_name} (${l.country})`);
  }
  if (newlyFound.length > 30) {
    console.log(`  ...and ${newlyFound.length - 30} more (see domestic-leagues.json for the full list)`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
