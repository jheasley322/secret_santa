-- ===========================================================================
-- 50 -- Phone numbers are erased 7 days after the swap date
-- ===========================================================================
-- Spec: "Privacy rules" 4 ("Numbers are erased 7 days after the swap date"),
-- "Interface contract -> Internal" (erase_old_phones() sets phone = null where
-- swap_date + 7 < current_date and returns the count; run daily by pg_cron).
-- Scenarios ERASE-01..07 in tests/SCENARIOS.md.
--
-- erase_old_phones() sweeps EVERY circle, so the expected count is measured
-- from the whole table just before the call, not assumed from the fixtures.
-- Everything is rolled back, real rows included.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(11);

select pg_temp.mk_elf('elf');
select pg_temp.mk_circle('E8', 'elf', current_date - 8);
select pg_temp.mk_members('E8', 'Ava', 'Ben');
select pg_temp.mk_member('Nop', 'E8', p_phone => null);
select pg_temp.mk_item('Ava', 'Lego', 0);
select pg_temp.mk_circle('E7', 'elf', current_date - 7);
select pg_temp.mk_members('E7', 'Cy', 'Dee');
select pg_temp.mk_circle('E6', 'elf', current_date - 6);
select pg_temp.mk_members('E6', 'Eli');
select pg_temp.mk_circle('E0', 'elf', current_date);
select pg_temp.mk_members('E0', 'Fay');
select pg_temp.mk_circle('EF', 'elf', current_date + 5);
select pg_temp.mk_members('EF', 'Gus');
select pg_temp.mk_circle('EN', 'elf', null);
select pg_temp.mk_members('EN', 'Hal');
-- A finished circle: sent, 10 days after the swap.
select pg_temp.mk_circle('ES', 'elf', current_date - 10);
select pg_temp.mk_members('ES', 'Ida', 'Jo', 'Kai');
select pg_temp.mk_matches('ES', 'Ida', 'Jo', 'Jo', 'Kai', 'Kai', 'Ida');
select pg_temp.set_status('ES', 'drawn');
select pg_temp.mark_sent('ES');

select pg_temp.keep('expected',
  (select count(*) from public.members m join public.circles c on c.id = m.circle_id
    where m.phone is not null and c.swap_date + 7 < current_date)::text);

select pg_temp.keep('erased', public.erase_old_phones()::text);

-- ERASE-01 / 05 ---------------------------------------------------------------
select is((select count(*) from public.members where circle_id = pg_temp.id('E8') and phone is not null), 0::bigint,
          'ERASE-01 phones are erased once the swap date is 8 days past');
select is((select count(*) from public.members where circle_id = pg_temp.id('ES') and phone is not null), 0::bigint,
          'ERASE-05 phones are erased in a sent circle too');

-- ERASE-02 not before ----------------------------------------------------------
select is((select count(*) from public.members where circle_id = pg_temp.id('E7') and phone is null), 0::bigint,
          'ERASE-02 phones are kept when the swap date is exactly 7 days past');
select is((select count(*) from public.members where circle_id = pg_temp.id('E6') and phone is null), 0::bigint,
          'ERASE-02 phones are kept 6 days after the swap');
select is((select count(*) from public.members
            where circle_id in (pg_temp.id('E0'), pg_temp.id('EF')) and phone is null), 0::bigint,
          'ERASE-02 phones are kept on and before the swap date');
select is((select count(*) from public.members where circle_id = pg_temp.id('EN') and phone is null), 0::bigint,
          'ERASE-02 phones are kept when no swap date is set');

-- ERASE-03 the count ----------------------------------------------------------
select is(pg_temp.val('erased'), pg_temp.val('expected'),
          'ERASE-03 erase_old_phones returns the number of phones it erased');

-- ERASE-04 nothing else is touched --------------------------------------------
select is((select array_agg(first_name order by first_name) from public.members where circle_id = pg_temp.id('E8')),
          array['Ava', 'Ben', 'Nop'], 'ERASE-04 the members and their names are kept');
select is((select count(*) from public.wish_items where member_id = pg_temp.id('Ava'))::text
          || '|' || pg_temp.match_count('ES')::text || '|' || pg_temp.circle_status('ES'),
          '1|3|sent', 'ERASE-04 lists, matches and status are kept');

-- ERASE-06 idempotent ---------------------------------------------------------
select is(public.erase_old_phones(), 0, 'ERASE-06 running it again straight away erases 0');

-- ERASE-07 scheduled daily ----------------------------------------------------
-- Dynamic SQL, so a missing pg_cron is a failed assertion, not a parse error.
create function pg_temp.cron_schedule() returns text
language plpgsql as $fx$
declare v text;
begin
  if to_regclass('cron.job') is null then
    return 'pg_cron is not installed';
  end if;
  execute $q$select schedule from cron.job where command ilike '%erase_old_phones%' and active limit 1$q$ into v;
  return coalesce(v, 'no active cron job calls erase_old_phones');
end $fx$;
select matches(pg_temp.cron_schedule(), '^(@daily|@midnight|[0-9]+ [0-9]+ \* \* \*)$',
               'ERASE-07 a pg_cron job runs erase_old_phones once a day');

select * from finish();
rollback;
