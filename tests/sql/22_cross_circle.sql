-- ===========================================================================
-- 22 -- One circle can't reach another
-- ===========================================================================
-- Spec: "Privacy rules" 1 and 2, "Access rules", "Error messages"
-- (`circle not found` for "a circle that isn't theirs, or doesn't exist").
-- Scenarios ISO-01..10 in tests/SCENARIOS.md.
--
-- Elf A owns CX; Elf B owns CY. Both are fully populated, and CY is drawn, so
-- every table has a B row that A must not reach.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(25);

select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');

select pg_temp.mk_circle('CX', 'elf_a');
select pg_temp.mk_members('CX', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_item('Ava', 'Lego', 0);

select pg_temp.mk_circle('CY', 'elf_b');
select pg_temp.mk_member('Yan', 'CY', 'Yan');
select pg_temp.mk_member('Yoko', 'CY', 'Yoko');
select pg_temp.mk_member('Yuri', 'CY', 'Yuri');
select pg_temp.mk_member('Yara', 'CY', 'Yara');
select pg_temp.mk_item('Yan', 'Secret wish', 0, 'https://example.com/y');
select pg_temp.mk_no_pair('CY', 'Yan', 'Yoko');
select pg_temp.mk_matches('CY', 'Yan', 'Yuri', 'Yuri', 'Yoko', 'Yoko', 'Yara', 'Yara', 'Yan');
select pg_temp.set_status('CY', 'drawn');
select pg_temp.mk_text('Yan', 'invite');

select pg_temp.keep('cy_before',
  (select row(c.name, c.budget, c.status, c.elf_id)::text from public.circles c where c.id = pg_temp.id('CY')));
select pg_temp.keep('cy_members_before',
  (select string_agg(row(m.first_name, m.phone, m.token, m.list_done)::text, ';' order by m.first_name)
     from public.members m where m.circle_id = pg_temp.id('CY')));

-- ISO-01 Elf A reads nothing of B's -------------------------------------------
select pg_temp.act_as('elf_a');
select is((select count(*) from public.circles where id = pg_temp.id('CY')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s circle');
select is((select count(*) from public.members where circle_id = pg_temp.id('CY')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s members (names, phones, tokens)');
select is((select count(*) from public.wish_items where member_id = pg_temp.id('Yan')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s wish items');
select is((select count(*) from public.no_pairs where circle_id = pg_temp.id('CY')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s no-pairs');
select is((select count(*) from public.matches where circle_id = pg_temp.id('CY')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s matches');
select is((select count(*) from public.texts where member_id = pg_temp.id('Yan')), 0::bigint,
          'ISO-01 Elf A cannot see Elf B''s texts');

-- ISO-02 / 03 updates and deletes of B's rows change nothing -----------------
select pg_temp.try($$update public.circles set name = 'pgtap:stolen', budget = 999 where id = pg_temp.id('CY')$$);
select pg_temp.try($$update public.members set phone = '+15555550199', list_done = false where circle_id = pg_temp.id('CY')$$);
select pg_temp.try($$update public.wish_items set text = 'defaced' where member_id = pg_temp.id('Yan')$$);
select pg_temp.try($$delete from public.wish_items where member_id = pg_temp.id('Yan')$$);
select pg_temp.try($$delete from public.no_pairs where circle_id = pg_temp.id('CY')$$);
select pg_temp.try($$delete from public.members where circle_id = pg_temp.id('CY')$$);
select pg_temp.try($$delete from public.circles where id = pg_temp.id('CY')$$);
select pg_temp.as_postgres();

select is((select row(c.name, c.budget, c.status, c.elf_id)::text from public.circles c where c.id = pg_temp.id('CY')),
          pg_temp.val('cy_before'), 'ISO-02 Elf A cannot change or delete Elf B''s circle');
select is((select string_agg(row(m.first_name, m.phone, m.token, m.list_done)::text, ';' order by m.first_name)
             from public.members m where m.circle_id = pg_temp.id('CY')),
          pg_temp.val('cy_members_before'), 'ISO-02 Elf A cannot change or delete Elf B''s members');
select is((select string_agg(text, ',') from public.wish_items where member_id = pg_temp.id('Yan')), 'Secret wish',
          'ISO-03 Elf A cannot change or delete Elf B''s wish items');
select is((select count(*) from public.no_pairs where circle_id = pg_temp.id('CY')), 1::bigint,
          'ISO-03 Elf A cannot delete Elf B''s no-pairs');

-- ISO-04 / 05 / 10 no inserts into B's circle --------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.try($$insert into public.members (circle_id, first_name, phone) values (pg_temp.id('CY'), 'Intruder', '+15555550170')$$);
select pg_temp.try($$insert into public.wish_items (member_id, text, position) values (pg_temp.id('Yan'), 'planted', 5)$$);
select pg_temp.try($$insert into public.no_pairs (circle_id, member_a, member_b)
                     values (pg_temp.id('CY'), least(pg_temp.id('Yuri'), pg_temp.id('Yara')),
                             greatest(pg_temp.id('Yuri'), pg_temp.id('Yara')))$$);
select pg_temp.try($$update public.members set circle_id = pg_temp.id('CY') where id = pg_temp.id('Cy')$$);
select pg_temp.try($$insert into public.no_pairs (circle_id, member_a, member_b)
                     values (pg_temp.id('CX'), least(pg_temp.id('Ava'), pg_temp.id('Yan')),
                             greatest(pg_temp.id('Ava'), pg_temp.id('Yan')))$$);
select pg_temp.as_postgres();
select is((select count(*) from public.members where circle_id = pg_temp.id('CY')), 4::bigint,
          'ISO-04 Elf A cannot add a member to Elf B''s circle');
select is((select count(*) from public.wish_items where member_id = pg_temp.id('Yan')), 1::bigint,
          'ISO-04 Elf A cannot add a wish item to Elf B''s member');
select is((select count(*) from public.no_pairs where circle_id = pg_temp.id('CY')), 1::bigint,
          'ISO-04 Elf A cannot add a no-pair to Elf B''s circle');
select is((select circle_id from public.members where id = pg_temp.id('Cy')), pg_temp.id('CX'),
          'ISO-05 Elf A cannot move their own member into Elf B''s circle');
select is((select count(*) from public.no_pairs where pg_temp.id('Yan') in (member_a, member_b)), 1::bigint,
          'ISO-10 Elf A cannot no-pair their member with one of Elf B''s');

-- ISO-06 / 07 Elf RPCs on someone else's circle -------------------------------
select pg_temp.act_as('elf_a');
select throws_ok($$select public.start_draw(pg_temp.id('CY'))$$, null, 'circle not found',
                 'ISO-06 start_draw on Elf B''s circle says circle not found (not "already drawn")');
select throws_ok($$select public.reshuffle(pg_temp.id('CY'))$$, null, 'circle not found',
                 'ISO-06 reshuffle on Elf B''s circle says circle not found');
select throws_ok($$select public.undo_draw(pg_temp.id('CY'))$$, null, 'circle not found',
                 'ISO-06 undo_draw on Elf B''s circle says circle not found');
select throws_ok($$select public.start_draw(gen_random_uuid())$$, null, 'circle not found',
                 'ISO-07 start_draw on a circle that does not exist says circle not found');
select throws_ok($$select public.reshuffle(gen_random_uuid())$$, null, 'circle not found',
                 'ISO-07 reshuffle on a circle that does not exist says circle not found');
select throws_ok($$select public.undo_draw(gen_random_uuid())$$, null, 'circle not found',
                 'ISO-07 undo_draw on a circle that does not exist says circle not found');
select pg_temp.as_postgres();
select is(pg_temp.draw_sig('CY') || '|' || pg_temp.circle_status('CY'),
          'Yan>Yuri,Yara>Yan,Yoko>Yara,Yuri>Yoko|drawn',
          'ISO-06 Elf B''s draw and status are unchanged');

-- ISO-08 a token from circle X sees only circle X -----------------------------
select pg_temp.capture_view('ava', 'Ava');
select is((select count(*) from jsonb_array_elements(pg_temp.view('ava')->'members') m
            where (m->>'id')::uuid not in (pg_temp.id('Ava'), pg_temp.id('Ben'), pg_temp.id('Cy'))),
          0::bigint, 'ISO-08 a token from circle X lists nobody from circle Y');
select ok(pg_temp.view('ava') is not null
          and position('Yan' in pg_temp.view('ava')::text) = 0
          and position('Secret wish' in pg_temp.view('ava')::text) = 0
          and position(pg_temp.id('Yan')::text in pg_temp.view('ava')::text) = 0,
          'ISO-08 no name, id or wish from circle Y appears in circle X''s view');

-- ISO-09 a token from circle X can't write into circle Y ----------------------
select pg_temp.act_as_anon();
select pg_temp.try(format($$select public.save_my_list(%L, '{}'::jsonb, '[{"text":"from X","url":null}]'::jsonb)$$,
                          pg_temp.tok('Ava')));
select pg_temp.try(format($$select public.set_list_done(%L, false)$$, pg_temp.tok('Ava')));
select pg_temp.as_postgres();
select is((select string_agg(row(m.first_name, m.phone, m.token, m.list_done)::text, ';' order by m.first_name)
             from public.members m where m.circle_id = pg_temp.id('CY'))
          || '|' || (select string_agg(text, ',') from public.wish_items where member_id = pg_temp.id('Yan')),
          pg_temp.val('cy_members_before') || '|Secret wish',
          'ISO-09 saving with a token from circle X changes nothing in circle Y');

select * from finish();
rollback;
