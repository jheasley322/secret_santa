-- ===========================================================================
-- 30 -- The draw rules
-- ===========================================================================
-- Spec: "Draw rules", "Do-not-pair", "Error messages".
-- Scenarios DRAW-01..09 in tests/SCENARIOS.md.
--
-- pg_temp.draw_verdict() (fixtures.sql) checks a circle's matches against
-- every rule in the spec's Draw rules list and returns 'ok' or the first
-- rule broken.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(27);

select pg_temp.mk_elf('elf');

select pg_temp.mk_circle('C0', 'elf');
select pg_temp.mk_circle('C2', 'elf');
select pg_temp.mk_members('C2', 'Pip', 'Pia');
select pg_temp.mk_circle('CND', 'elf');
select pg_temp.mk_members('CND', 'Nia', 'Ned');
select pg_temp.mk_member('Nat', 'CND', p_done => false);

select pg_temp.mk_circle('C3', 'elf');
select pg_temp.mk_members('C3', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_circle('C4', 'elf');
select pg_temp.mk_members('C4', 'Dan', 'Eli', 'Fay', 'Gus');
select pg_temp.mk_circle('C5', 'elf');
select pg_temp.mk_members('C5', 'Hal', 'Ida', 'Jo', 'Kai', 'Lu');
select pg_temp.mk_circle('C8', 'elf');
select pg_temp.mk_members('C8', 'Mo', 'Nel', 'Oz', 'Pam', 'Quin', 'Rae', 'Sid', 'Tia');
select pg_temp.mk_circle('C6', 'elf');
select pg_temp.mk_members('C6', 'Uma', 'Vic', 'Wyn', 'Xan', 'Yul', 'Zed');

select pg_temp.mk_circle('CNP', 'elf');
select pg_temp.mk_members('CNP', 'Ann', 'Bo', 'Cal', 'Dot');
select pg_temp.mk_no_pair('CNP', 'Ann', 'Bo');

select pg_temp.mk_circle('CIMP', 'elf');
select pg_temp.mk_members('CIMP', 'Ed', 'Flo', 'Gil');
select pg_temp.mk_no_pair('CIMP', 'Ed', 'Flo');

select pg_temp.mk_circle('CIMP2', 'elf');
select pg_temp.mk_members('CIMP2', 'Kim', 'Lars', 'Mei', 'Noor');
select pg_temp.mk_no_pair('CIMP2', 'Kim', 'Lars');
select pg_temp.mk_no_pair('CIMP2', 'Kim', 'Mei');
select pg_temp.mk_no_pair('CIMP2', 'Kim', 'Noor');

select pg_temp.mk_circle('CTIGHT', 'elf');
select pg_temp.mk_members('CTIGHT', 'Oli', 'Pat', 'Ria', 'Sam');
select pg_temp.mk_no_pair('CTIGHT', 'Oli', 'Pat');
select pg_temp.mk_no_pair('CTIGHT', 'Ria', 'Sam');

select pg_temp.mk_circle('CMUT', 'elf');
select pg_temp.mk_members('CMUT', 'Tom', 'Uli', 'Val', 'Wil');

-- DRAW-01 at least 3 members --------------------------------------------------
select pg_temp.act_as('elf');
select throws_ok($$select public.start_draw(pg_temp.id('C0'))$$, null, 'need at least 3 members',
                 'DRAW-01 a circle with no members cannot draw');
select throws_ok($$select public.start_draw(pg_temp.id('C2'))$$, null, 'need at least 3 members',
                 'DRAW-01 a circle with 2 members cannot draw');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('C2') || '|' || pg_temp.match_count('C2'), 'open|0',
          'DRAW-01 ... and nothing changes (still open, no matches)');

-- DRAW-02 every list done -----------------------------------------------------
select pg_temp.act_as('elf');
select throws_ok($$select public.start_draw(pg_temp.id('CND'))$$, null, 'every list must be done before the draw',
                 'DRAW-02 a circle with an unfinished list cannot draw');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('CND') || '|' || pg_temp.match_count('CND'), 'open|0',
          'DRAW-02 ... and nothing changes (still open, no matches)');

-- DRAW-03 a 3-member draw works -----------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('C3'))$$, 'DRAW-03 a 3-member circle with every list done can draw');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('C3'), 'drawn', 'DRAW-03 ... and the circle is now drawn');

-- DRAW-04 every draw is valid -------------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('C4'))$$, 'DRAW-04 a 4-member circle can draw');
select lives_ok($$select public.start_draw(pg_temp.id('C5'))$$, 'DRAW-04 a 5-member circle can draw');
select lives_ok($$select public.start_draw(pg_temp.id('C8'))$$, 'DRAW-04 an 8-member circle can draw');
select lives_ok($$select public.start_draw(pg_temp.id('C6'))$$, 'DRAW-04 a 6-member circle can draw');
select pg_temp.as_postgres();
select is(pg_temp.draw_verdict('C3'), 'ok', 'DRAW-04 the 3-member draw is valid');
select is(pg_temp.draw_verdict('C4'), 'ok', 'DRAW-04 the 4-member draw is valid');
select is(pg_temp.draw_verdict('C5'), 'ok', 'DRAW-04 the 5-member draw is valid');
select is(pg_temp.draw_verdict('C8'), 'ok', 'DRAW-04 the 8-member draw is valid');

select pg_temp.collect_draws('six', 'elf', 'C6', 50, 'reshuffle');
select is((select count(*) from pg_temp.t_draws where tag = 'six' and verdict = 'ok'), 50::bigint,
          'DRAW-04 all 50 reshuffles of a 6-member circle are valid');

-- DRAW-05 no-pairs hold in both directions ------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('CNP'))$$, 'DRAW-05 a circle with a no-pair can draw');
select pg_temp.as_postgres();
select pg_temp.collect_draws('nopair', 'elf', 'CNP', 100, 'reshuffle');
select is((select count(*) from pg_temp.t_draws where tag = 'nopair' and verdict = 'ok'), 100::bigint,
          'DRAW-05 all 100 reshuffles with a no-pair are valid');
select is((select count(*) from pg_temp.t_draws
            where tag = 'nopair' and (sig like '%Ann>Bo%' or sig like '%Bo>Ann%')), 0::bigint,
          'DRAW-05 Ann never draws Bo and Bo never draws Ann');

-- DRAW-06 / 07 impossible rules -----------------------------------------------
select pg_temp.act_as('elf');
select throws_ok($$select public.start_draw(pg_temp.id('CIMP'))$$, null,
                 'Can''t make a draw with these do-not-pair rules. Try removing one.',
                 'DRAW-06 3 kids with two of them no-paired cannot draw, with the spec''s message');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('CIMP') || '|' || pg_temp.match_count('CIMP'), 'open|0',
          'DRAW-06 ... and nothing changes (still open, no matches)');

select pg_temp.act_as('elf');
select throws_ok($$select public.start_draw(pg_temp.id('CIMP2'))$$, null,
                 'Can''t make a draw with these do-not-pair rules. Try removing one.',
                 'DRAW-07 a kid no-paired with everyone else cannot draw, with the spec''s message');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('CIMP2') || '|' || pg_temp.match_count('CIMP2'), 'open|0',
          'DRAW-07 ... and nothing changes (still open, no matches)');

-- DRAW-08 tight but possible --------------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('CTIGHT'))$$,
                'DRAW-08 two no-paired couples (4 valid draws out of 24) can draw');
select pg_temp.as_postgres();
select pg_temp.collect_draws('tight', 'elf', 'CTIGHT', 50, 'reshuffle');
select is((select count(*) from pg_temp.t_draws where tag = 'tight' and verdict = 'ok'), 50::bigint,
          'DRAW-08 all 50 reshuffles with tight rules succeed and are valid');

-- DRAW-09 mutual pairs are allowed --------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('CMUT'))$$, 'DRAW-09 a 4-member circle can draw');
select pg_temp.as_postgres();
select pg_temp.collect_draws('mutual', 'elf', 'CMUT', 200, 'reshuffle');
-- 3 of the 9 valid 4-person draws are two mutual pairs; P(none in 200) ~ 1e-35.
select cmp_ok((select count(*) from pg_temp.t_draws where tag = 'mutual' and mutual), '>', 0::bigint,
              'DRAW-09 two kids drawing each other (A->B and B->A) happens');

select * from finish();
rollback;
