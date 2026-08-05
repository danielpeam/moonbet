-- Backup of view definitions dropped by the CASCADE on 2026-08-04 when the
-- ppg / points2top / mooncentile / moongrade columns were removed from
-- public.standings. Keep this until the picks pipeline is rebuilt on the
-- new grades view.
--
-- Drop order (dependency chain, deepest first when it existed):
-- standings.ppg/mooncentile/moongrade
--   -> current_standings_with_grades
--     -> fixtures_with_grades_and_stats_v
--       -> home_picks_all
--         -> home_picks
--         -> home_picks_condensed
--         -> glengarry

-- 1. current_standings_with_grades
-- For each row in current_standings (live season), finds the historical
-- standings row in the same league with the closest ppg, and borrows that
-- row's mooncentile/moongrade as the team's live grade.
CREATE VIEW public.current_standings_with_grades AS
SELECT cs.id,
    cs.league_id,
    cs.league_name,
    cs.season,
    cs.team_id,
    cs.team_name,
    cs.rank,
    cs.points,
    cs.matches_played,
    cs.wins,
    cs.draws,
    cs.losses,
    cs.points2top,
    cs.mooncentile,
    cs.moongrade,
    cs.ppg,
    s_best.mooncentile AS percentile,
    s_best.moongrade AS moongrade_match
FROM current_standings cs
LEFT JOIN LATERAL (
    SELECT s.mooncentile, s.moongrade
    FROM standings s          -- <-- this is the dependency that was removed
    WHERE s.league_id = cs.league_id
    ORDER BY (abs(s.ppg - cs.ppg)), s.rank   -- <-- s.ppg no longer exists
    LIMIT 1
) s_best ON true;

-- 2. fixtures_with_grades_and_stats_v
CREATE VIEW public.fixtures_with_grades_and_stats_v AS
SELECT f.id,
    f.fixture_id,
    f.league_id,
    unaccent(f.league_name) AS league_name,
    f.season,
    f.date,
    f.status,
    unaccent(f.venue) AS venue,
    f.home_team_id,
    unaccent(f.home_team_name) AS home_team_name,
    f.away_team_id,
    unaccent(f.away_team_name) AS away_team_name,
    f.updated_at,
    f.homeodds,
    f.awayodds,
    f.drawodds,
    f.date_ddmmyy,
    hg.moongrade_match AS home_moongrade,
    ag.moongrade_match AS away_moongrade,
    s.total_games,
    s.home_win_pct,
    s.away_win_pct,
    s.draw_pct,
    CASE WHEN s.home_win_pct > 54.0 AND COALESCE(f.homeodds, 0::numeric) > 1.99 THEN 1 ELSE 0 END::smallint AS home_prediction,
    CASE WHEN s.away_win_pct > 54.0 AND COALESCE(f.awayodds, 0::numeric) > 1.99 THEN 1 ELSE 0 END::smallint AS away_prediction,
    CASE WHEN s.draw_pct > 49.0 AND COALESCE(f.drawodds, 0::numeric) > 2.99 THEN 1 ELSE 0 END::smallint AS draw_prediction,
    home_cs.matches_played AS home_team_matches_played,
    away_cs.matches_played AS away_team_matches_played
FROM fixtures f
LEFT JOIN current_standings_with_grades hg ON hg.league_id = f.league_id AND hg.team_id = f.home_team_id
LEFT JOIN current_standings_with_grades ag ON ag.league_id = f.league_id AND ag.team_id = f.away_team_id
LEFT JOIN statistics s ON s.league_id = f.league_id::bigint AND s.home_grade = hg.moongrade_match AND s.away_grade = ag.moongrade_match
LEFT JOIN current_standings home_cs ON home_cs.league_id = f.league_id AND home_cs.team_id = f.home_team_id
LEFT JOIN current_standings away_cs ON away_cs.league_id = f.league_id AND away_cs.team_id = f.away_team_id;

-- 3. home_picks_all
CREATE VIEW public.home_picks_all AS
SELECT id, fixture_id, league_id, league_name, season, date, status, venue,
    home_team_id, home_team_name, away_team_id, away_team_name, updated_at,
    homeodds, awayodds, drawodds, date_ddmmyy, home_moongrade, away_moongrade,
    total_games, home_win_pct, away_win_pct, draw_pct, home_prediction,
    away_prediction, draw_prediction, home_team_matches_played, away_team_matches_played
FROM fixtures_with_grades_and_stats_v v
WHERE home_prediction = 1 AND date::date >= CURRENT_DATE AND date::date <= (CURRENT_DATE + '2 days'::interval);

-- 4. home_picks
CREATE VIEW public.home_picks AS
SELECT id, fixture_id, league_id, league_name, season, date, status, venue,
    home_team_id, home_team_name, away_team_id, away_team_name, updated_at,
    homeodds, awayodds, drawodds, date_ddmmyy, home_moongrade, away_moongrade,
    total_games, home_win_pct, away_win_pct, draw_pct, home_prediction,
    away_prediction, draw_prediction, home_team_matches_played, away_team_matches_played
FROM fixtures_with_grades_and_stats_v
WHERE home_prediction = 1;

-- 5. home_picks_condensed
CREATE VIEW public.home_picks_condensed AS
SELECT home_team_name, away_team_name, homeodds, awayodds, date_ddmmyy
FROM home_picks_all;

-- 6. glengarry
CREATE VIEW public.glengarry AS
SELECT id, fixture_id, league_id, league_name, season, date, status, venue,
    home_team_id, home_team_name, away_team_id, away_team_name, updated_at,
    homeodds, awayodds, drawodds, date_ddmmyy, home_moongrade, away_moongrade,
    total_games, home_win_pct, away_win_pct, draw_pct, home_prediction,
    away_prediction, draw_prediction, home_team_matches_played, away_team_matches_played,
    GREATEST(0::numeric, floor(EXTRACT(epoch FROM date - now()) / 60::numeric))::integer AS minutes_to_kickoff
FROM home_picks_all hpa
WHERE homeodds >= 2.2 AND homeodds <= 2.60;

-- NOTE: none of this will run as-is anymore, because standings.ppg,
-- standings.mooncentile and standings.moongrade are gone. When you rebuild
-- the grading logic as its own view (e.g. standings_grades), repoint the
-- LEFT JOIN LATERAL in current_standings_with_grades at that view instead
-- of `standings`.
