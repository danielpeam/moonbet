-- ============================================================================
-- Migration: create_standings_grades_view
-- Project: BettingMoon (rvqvylbyfllageyflagq)
-- Applied: 2026-08-04
--
-- Recreates the ppg / points2top / mooncentile / moongrade columns that were
-- removed from public.standings, as a plain (non-materialized) view. Because
-- it's a normal view, Postgres recomputes it on every query -- no refresh,
-- trigger, or manual re-run needed when new rows land in `standings`.
--
-- Logic (unchanged from the original standings-table columns):
--   ppg          = points / matches_played, rounded to 2dp
--   points2top   = (highest ppg ever recorded in that league, all seasons)
--                  minus the team's ppg
--   mooncentile  = points2top / (highest points2top ever recorded in that
--                  league, all seasons) * 100
--   moongrade    = letter bucket on mooncentile:
--                    < 11        -> A
--                    11 - 20.99  -> B
--                    21 - 30.99  -> C
--                    31 - 40.99  -> D
--                    41 - 50.99  -> E
--                    51 - 60.99  -> F
--                    61 - 70.99  -> G
--                    71 - 80.99  -> H
--                    81 - 90.99  -> I
--                    91+         -> J
-- ============================================================================

create or replace view public.standings_grades as
with base as (
  select
    s.id,
    s.league_id,
    s.league_name,
    s.season,
    s.team_id,
    s.team_name,
    s.rank,
    s.points,
    s.matches_played,
    s.wins,
    s.draws,
    s.losses,
    round(s.points::numeric / nullif(s.matches_played, 0), 2) as ppg
  from public.standings s
),
league_max_ppg as (
  select league_id, max(ppg) as max_ppg
  from base
  where ppg is not null
  group by league_id
),
with_p2t as (
  select
    b.*,
    round(lmp.max_ppg - b.ppg, 2) as points2top
  from base b
  join league_max_ppg lmp on lmp.league_id = b.league_id
  where b.ppg is not null
),
league_max_p2t as (
  select league_id, max(points2top) as max_points2top
  from with_p2t
  where points2top is not null
  group by league_id
),
with_mooncentile as (
  select
    w.*,
    round((w.points2top / nullif(lmp2.max_points2top, 0)) * 100, 2) as mooncentile
  from with_p2t w
  join league_max_p2t lmp2 on lmp2.league_id = w.league_id
)
select
  id,
  league_id,
  league_name,
  season,
  team_id,
  team_name,
  rank,
  points,
  matches_played,
  wins,
  draws,
  losses,
  ppg,
  points2top,
  mooncentile,
  case
    when mooncentile >= 91 then 'J'
    when mooncentile >= 81 then 'I'
    when mooncentile >= 71 then 'H'
    when mooncentile >= 61 then 'G'
    when mooncentile >= 51 then 'F'
    when mooncentile >= 41 then 'E'
    when mooncentile >= 31 then 'D'
    when mooncentile >= 21 then 'C'
    when mooncentile >= 11 then 'B'
    else 'A'
  end as moongrade
from with_mooncentile;

-- ============================================================================
-- Migration: fix_standings_grades_view_grants
-- Matches the base table's permission posture: standings itself only grants
-- to authenticated/service_role, not anon, so the view shouldn't either.
-- ============================================================================

grant select on public.standings_grades to authenticated, anon;
revoke select on public.standings_grades from anon;

-- ============================================================================
-- (For reference) Migration: drop_derived_columns_from_standings_cascade
-- Ran earlier the same day -- removes the 4 columns from the base table now
-- that this view supersedes them.
-- ============================================================================

-- alter table public.standings
--   drop column if exists ppg cascade,
--   drop column if exists points2top cascade,
--   drop column if exists mooncentile cascade,
--   drop column if exists moongrade cascade;
