-- ===========================================================================
-- 20 -- The signed-out visitor (anon) reaches nothing
-- ===========================================================================
-- Spec: "Access rules -> Member" ("Has no direct table access. The anon role
-- is granted nothing on these tables."), CLAUDE.md rule 4.
-- Scenarios ANON-01..05 in tests/SCENARIOS.md.
--
-- The publishable key IS the anon role, and it ships in the front end. Every
-- table is populated first, so "nothing" means hidden, not empty.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(17);

select pg_temp.mk_elf('elf');
select pg_temp.mk_elf('stranger');
select pg_temp.mk_circle('C', 'elf');
select pg_temp.mk_members('C', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_item('Ava', 'Lego', 0, 'https://example.com/lego');
select pg_temp.mk_no_pair('C', 'Ava', 'Ben');
select pg_temp.mk_matches('C', 'Ava', 'Cy', 'Cy', 'Ben', 'Ben', 'Ava');
select pg_temp.set_status('C', 'drawn');
select pg_temp.mk_text('Ava', 'invite');

-- ANON-01: no privilege of any kind, on any table or view in public ----------
select is(
  array(select c.relname || ':' || p.priv
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and has_table_privilege('anon', c.oid, p.priv)
         order by 1),
  '{}'::text[], 'ANON-01 anon holds no table privilege on anything in public');
select is(
  array(select c.relname::text
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
           and has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
         order by 1),
  '{}'::text[], 'ANON-01 anon holds no column-level privilege on anything in public');

-- ANON-02: selecting is refused, table by table --------------------------------
select pg_temp.act_as_anon();
select throws_ok('select * from public.circles',    '42501', null, 'ANON-02 anon cannot select circles');
select throws_ok('select * from public.members',    '42501', null, 'ANON-02 anon cannot select members');
select throws_ok('select * from public.wish_items', '42501', null, 'ANON-02 anon cannot select wish_items');
select throws_ok('select * from public.no_pairs',   '42501', null, 'ANON-02 anon cannot select no_pairs');
select throws_ok('select * from public.matches',    '42501', null, 'ANON-02 anon cannot select matches');
select throws_ok('select * from public.texts',      '42501', null, 'ANON-02 anon cannot select texts');

-- ANON-03: nor writing ---------------------------------------------------------
select throws_ok($$insert into public.members (circle_id, first_name, phone) values (pg_temp.id('C'), 'Sneaky', '+15555550163')$$,
                 '42501', null, 'ANON-03 anon cannot insert a member');
select throws_ok($$update public.circles set name = 'pgtap:hacked'$$,
                 '42501', null, 'ANON-03 anon cannot update circles');
select throws_ok($$delete from public.matches$$,
                 '42501', null, 'ANON-03 anon cannot delete matches');

-- ANON-04: nor calling the Elf or internal RPCs --------------------------------
select throws_ok($$select public.start_draw(pg_temp.id('C'))$$, '42501', null, 'ANON-04 anon cannot call start_draw');
select throws_ok($$select public.reshuffle(pg_temp.id('C'))$$,  '42501', null, 'ANON-04 anon cannot call reshuffle');
select throws_ok($$select public.undo_draw(pg_temp.id('C'))$$,  '42501', null, 'ANON-04 anon cannot call undo_draw');
select throws_ok($$select public.erase_old_phones()$$,          '42501', null, 'ANON-04 anon cannot call erase_old_phones');
select pg_temp.as_postgres();

select is(pg_temp.match_count('C'), 3::bigint, 'ANON-04 ... and the draw is untouched');

-- ANON-05: a signed-in user with no circle of their own sees nothing ----------
select pg_temp.act_as('stranger');
select pg_temp.keep('stranger_rows',
  (select (select count(*) from public.circles)
        + (select count(*) from public.members)
        + (select count(*) from public.wish_items)
        + (select count(*) from public.no_pairs)
        + (select count(*) from public.matches)
        + (select count(*) from public.texts))::text);
select pg_temp.as_postgres();
select is(pg_temp.val('stranger_rows'), '0',
          'ANON-05 a signed-in user who owns no circle sees zero rows in every table');

select * from finish();
rollback;
