-- ===========================================================================
-- 32 -- Circle status transitions and the post-draw lock
-- ===========================================================================
-- Spec: "Circle status" (open -> drawn -> sent; Shuffle again and Undo draw only
-- from drawn; members and no-pairs frozen unless open), "Reshuffle", "Texting"
-- (reveal moves the circle to sent), "Error messages".
-- Scenarios STAT-01..08 and LOCK-01..06 in tests/SCENARIOS.md.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(33);

select pg_temp.mk_elf('elf');
select pg_temp.mk_circle('S', 'elf');
select pg_temp.mk_members('S', 'Ava', 'Ben', 'Cy', 'Dee');
select pg_temp.mk_member('Eve', 'S');   -- removed in LOCK-01
select pg_temp.mk_no_pair('S', 'Ava', 'Ben');

-- LOCK-01 open: members and no-pairs can change -------------------------------
select pg_temp.act_as('elf');
select lives_ok($$insert into public.members (circle_id, first_name, phone)
                  values (pg_temp.id('S'), 'Fin', '+15555550160')$$,
                'LOCK-01 open: the Elf can add a member');
select lives_ok($$delete from public.members where circle_id = pg_temp.id('S') and first_name in ('Fin', 'Eve')$$,
                'LOCK-01 open: the Elf can remove a member');
select lives_ok($$insert into public.no_pairs (circle_id, member_a, member_b)
                  values (pg_temp.id('S'), least(pg_temp.id('Cy'), pg_temp.id('Dee')),
                          greatest(pg_temp.id('Cy'), pg_temp.id('Dee')))$$,
                'LOCK-01 open: the Elf can add a no-pair');
select lives_ok($$delete from public.no_pairs where circle_id = pg_temp.id('S') and pg_temp.id('Cy') in (member_a, member_b)$$,
                'LOCK-01 open: the Elf can remove a no-pair');
select pg_temp.as_postgres();
select is((select count(*) from public.members where circle_id = pg_temp.id('S'))::text || '|'
          || (select count(*) from public.no_pairs where circle_id = pg_temp.id('S'))::text,
          '4|1', 'LOCK-01 ... and those changes took effect');

-- STAT-01 / 03 ---------------------------------------------------------------
select is(pg_temp.circle_status('S'), 'open', 'STAT-01 a new circle is open');
select pg_temp.act_as('elf');
select throws_ok($$select public.reshuffle(pg_temp.id('S'))$$, null, 'names have not been drawn yet',
                 'STAT-03 reshuffle while open says names have not been drawn yet');
select throws_ok($$select public.undo_draw(pg_temp.id('S'))$$, null, 'names have not been drawn yet',
                 'STAT-03 undo_draw while open says names have not been drawn yet');
select lives_ok($$select public.start_draw(pg_temp.id('S'))$$, 'STAT-01 start_draw on an open circle works');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('S'), 'drawn', 'STAT-01 ... and the circle is now drawn');

-- STAT-02 no second draw ------------------------------------------------------
select pg_temp.keep('sig1', pg_temp.draw_sig('S'));
select pg_temp.act_as('elf');
select throws_ok($$select public.start_draw(pg_temp.id('S'))$$, null, 'names have already been drawn',
                 'STAT-02 start_draw while drawn says names have already been drawn');
select pg_temp.as_postgres();
select is(pg_temp.draw_sig('S'), pg_temp.val('sig1'), 'STAT-02 ... and the matches are untouched');

-- LOCK-02..04 drawn: frozen ---------------------------------------------------
select pg_temp.act_as('elf');
select throws_ok($$insert into public.members (circle_id, first_name, phone) values (pg_temp.id('S'), 'Late', '+15555550161')$$,
                 null, 'circle is locked after the draw', 'LOCK-02 drawn: adding a member is refused');
select throws_ok($$delete from public.members where id = pg_temp.id('Dee')$$,
                 null, 'circle is locked after the draw', 'LOCK-03 drawn: removing a member is refused');
select throws_ok($$insert into public.no_pairs (circle_id, member_a, member_b)
                   values (pg_temp.id('S'), least(pg_temp.id('Cy'), pg_temp.id('Dee')),
                           greatest(pg_temp.id('Cy'), pg_temp.id('Dee')))$$,
                 null, 'circle is locked after the draw', 'LOCK-04 drawn: adding a no-pair is refused');
select throws_ok($$delete from public.no_pairs where circle_id = pg_temp.id('S')$$,
                 null, 'circle is locked after the draw', 'LOCK-04 drawn: removing a no-pair is refused');

-- STAT-04 reshuffle -----------------------------------------------------------
select pg_temp.as_postgres();
select pg_temp.collect_draws('stat04', 'elf', 'S', 30, 'reshuffle');
select is(pg_temp.circle_status('S'), 'drawn', 'STAT-04 after reshuffling the circle is still drawn');
select is((select count(*) from pg_temp.t_draws where tag = 'stat04' and verdict = 'ok'), 30::bigint,
          'STAT-04 every reshuffle leaves a valid draw');
-- 4 kids with one no-pair have 4 valid draws; P(30 fair reshuffles all
-- identical to the first) = 4^-30.
select cmp_ok((select count(distinct sig) from (select pg_temp.val('sig1') sig
                                                union all
                                                select sig from pg_temp.t_draws where tag = 'stat04') s),
              '>', 1::bigint, 'STAT-04 reshuffle actually changes the draw');

-- STAT-05 / 06 / LOCK-06 undo -------------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.undo_draw(pg_temp.id('S'))$$, 'STAT-05 undo_draw while drawn works');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('S') || '|' || pg_temp.match_count('S'), 'open|0',
          'STAT-05 ... the circle is open again and the matches are gone');

select pg_temp.act_as('elf');
select lives_ok($$insert into public.members (circle_id, first_name, phone)
                  values (pg_temp.id('S'), 'Gia', '+15555550161')$$,
                'LOCK-06 after undo, the Elf can add a member again');
select pg_temp.as_postgres();
update public.members set list_done = true where circle_id = pg_temp.id('S') and first_name = 'Gia';
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('S'))$$, 'STAT-06 after undo, the Elf can draw again');
select pg_temp.as_postgres();
select is(pg_temp.draw_verdict('S'), 'ok', 'STAT-06 ... and the new draw (now 5 members) is valid');

-- STAT-07 the Edge Function's service role sends the names ----------------
select pg_temp.keep('sig2', pg_temp.draw_sig('S'));
select pg_temp.act_as_service();
update public.circles set status = 'sent' where id = pg_temp.id('S');
select pg_temp.as_postgres();
select is(pg_temp.circle_status('S'), 'sent', 'STAT-07 the service role can move drawn -> sent');

-- STAT-08 / STAT-02 sent is final ---------------------------------------------
select pg_temp.act_as('elf');
select throws_ok($$select public.reshuffle(pg_temp.id('S'))$$, null, 'names have already been sent',
                 'STAT-08 reshuffle after sending says names have already been sent');
select throws_ok($$select public.undo_draw(pg_temp.id('S'))$$, null, 'names have already been sent',
                 'STAT-08 undo_draw after sending says names have already been sent');
select throws_ok($$select public.start_draw(pg_temp.id('S'))$$, null, 'names have already been drawn',
                 'STAT-02 start_draw after sending says names have already been drawn');

-- LOCK-05 sent: frozen --------------------------------------------------------
select throws_ok($$insert into public.members (circle_id, first_name, phone) values (pg_temp.id('S'), 'Later', '+15555550162')$$,
                 null, 'circle is locked after the draw', 'LOCK-05 sent: adding a member is refused');
select throws_ok($$delete from public.members where id = pg_temp.id('Dee')$$,
                 null, 'circle is locked after the draw', 'LOCK-05 sent: removing a member is refused');
select throws_ok($$insert into public.no_pairs (circle_id, member_a, member_b)
                   values (pg_temp.id('S'), least(pg_temp.id('Cy'), pg_temp.id('Dee')),
                           greatest(pg_temp.id('Cy'), pg_temp.id('Dee')))$$,
                 null, 'circle is locked after the draw', 'LOCK-05 sent: adding a no-pair is refused');
select throws_ok($$delete from public.no_pairs where circle_id = pg_temp.id('S')$$,
                 null, 'circle is locked after the draw', 'LOCK-05 sent: removing a no-pair is refused');
select pg_temp.as_postgres();

select is(pg_temp.circle_status('S') || '|' || pg_temp.draw_sig('S'), 'sent|' || pg_temp.val('sig2'),
          'STAT-08 ... and the status and matches are untouched');

select * from finish();
rollback;
