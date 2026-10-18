-- ===========================================================================
-- 31 -- The draw is random, and uniformly so
-- ===========================================================================
-- Spec: "Draw rules" ("The result is uniformly random among valid draws").
-- Scenarios RAND-01..04 in tests/SCENARIOS.md.
--
-- Statistics, so the thresholds are chosen to be effectively flake-free:
--   * 3 members have exactly 2 valid draws (the two 3-cycles). P(one of them
--     never appears in 200 fair runs) = 2 * 2^-200.
--   * 4 members have 9 valid draws: 6 four-cycles and 3 "two mutual pairs".
--     450 fair runs give each about 50 (sd ~6.7). Requiring 20..90 per draw is
--     ~4.5 sd below and ~6 sd above; P(false failure) is about 3e-5.
--     A "one big loop" shuffle (Sattolo's algorithm, or "everyone gives to the
--     next person in a shuffled list") never produces the 3 two-pair draws and
--     fails here; a biased "fix up collisions" approach skews counts and fails
--     the 20..90 band.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(9);

select pg_temp.mk_elf('elf');
select pg_temp.mk_circle('R3', 'elf');
select pg_temp.mk_members('R3', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_circle('R4', 'elf');
select pg_temp.mk_members('R4', 'Dan', 'Eli', 'Fay', 'Gus');

select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('R3'))$$, 'RAND setup: 3-member circle draws');
select lives_ok($$select public.start_draw(pg_temp.id('R4'))$$, 'RAND setup: 4-member circle draws');
select pg_temp.as_postgres();

-- RAND-01 reshuffle, 3 members ------------------------------------------------
select pg_temp.collect_draws('r3_reshuffle', 'elf', 'R3', 200, 'reshuffle');
select is(
  array(select distinct sig from pg_temp.t_draws where tag = 'r3_reshuffle' order by 1),
  array['Ava>Ben,Ben>Cy,Cy>Ava', 'Ava>Cy,Ben>Ava,Cy>Ben'],
  'RAND-01 with 3 members, both possible draws appear across 200 reshuffles');

-- RAND-02 undo + start_draw, 3 members ----------------------------------------
select pg_temp.collect_draws('r3_redraw', 'elf', 'R3', 200, 'redraw');
select is(
  array(select distinct sig from pg_temp.t_draws where tag = 'r3_redraw' order by 1),
  array['Ava>Ben,Ben>Cy,Cy>Ava', 'Ava>Cy,Ben>Ava,Cy>Ben'],
  'RAND-02 with 3 members, both possible draws appear across 200 undo + draw cycles');

-- RAND-03 uniform over the 9 valid 4-member draws -----------------------------
select pg_temp.collect_draws('r4', 'elf', 'R4', 450, 'reshuffle');
select is((select count(distinct sig) from pg_temp.t_draws where tag = 'r4'), 9::bigint,
          'RAND-03 all 9 valid 4-member draws appear across 450 reshuffles');
select is((select count(distinct sig) from pg_temp.t_draws where tag = 'r4' and mutual), 3::bigint,
          'RAND-03 ... including all 3 "two mutual pairs" draws');
select cmp_ok((select min(n) from (select count(*) n from pg_temp.t_draws where tag = 'r4' group by sig) s),
              '>=', 20::bigint, 'RAND-03 no valid draw is starved (each appears at least 20 times of ~50)');
select cmp_ok((select max(n) from (select count(*) n from pg_temp.t_draws where tag = 'r4' group by sig) s),
              '<=', 90::bigint, 'RAND-03 no valid draw is favoured (each appears at most 90 times of ~50)');

-- RAND-04 every collected draw was valid --------------------------------------
select is((select count(*) from pg_temp.t_draws where verdict <> 'ok' or verdict is null), 0::bigint,
          'RAND-04 every one of the 850 draws was valid');

select * from finish();
rollback;
