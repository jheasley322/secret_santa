-- ===========================================================================
-- 11 -- Every circle has a swap date, and the Elf can change it any time
-- ===========================================================================
-- Spec: "Data model" (swap_date date not null), "Texting details -> Decisions
-- from Joe (2026-10-24)" 7 ("required when the circle is created, and the Elf
-- can change it later in any status. This means every phone number is
-- eventually erased."), "Circle details" (the Elf can edit at any time).
-- Scenarios SWAP-01..05 in tests/SCENARIOS.md.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(10);

select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');

select pg_temp.mk_circle('CO', 'elf_a');
select pg_temp.mk_members('CO', 'Ava', 'Ben', 'Cy');

select pg_temp.mk_circle('CD', 'elf_a');
select pg_temp.mk_members('CD', 'Dan', 'Eli', 'Fay');
select pg_temp.mk_matches('CD', 'Dan', 'Eli', 'Eli', 'Fay', 'Fay', 'Dan');
select pg_temp.set_status('CD', 'drawn');

select pg_temp.mk_circle('CS', 'elf_a');
select pg_temp.mk_members('CS', 'Gus', 'Hal', 'Ida');
select pg_temp.mk_matches('CS', 'Gus', 'Hal', 'Hal', 'Ida', 'Ida', 'Gus');
select pg_temp.set_status('CS', 'drawn');
select pg_temp.mark_sent('CS');

-- SWAP-01 the column is required -----------------------------------------------
select col_not_null('public', 'circles', 'swap_date', 'SWAP-01 circles.swap_date is NOT NULL');

-- SWAP-02 creating a circle without one fails ------------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.outcome($$insert into public.circles (name, budget) values ('pgtap:no-date', 20)$$),
          'rejected', 'SWAP-02 the Elf cannot create a circle without a swap date');
select is(pg_temp.outcome($$insert into public.circles (name, swap_date) values ('pgtap:null-date', null)$$),
          'rejected', 'SWAP-02 the Elf cannot create a circle with a null swap date');
select is(pg_temp.outcome($$insert into public.circles (name, swap_date) values ('pgtap:with-date', current_date + 9)$$),
          'accepted', 'SWAP-02 a circle with a swap date is created');
select pg_temp.as_postgres();

-- SWAP-03 the Elf can change it in every status -----------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.keep('upd_open',  pg_temp.try($$update public.circles set swap_date = current_date + 11 where id = pg_temp.id('CO')$$));
select pg_temp.keep('upd_drawn', pg_temp.try($$update public.circles set swap_date = current_date + 12 where id = pg_temp.id('CD')$$));
select pg_temp.keep('upd_sent',  pg_temp.try($$update public.circles set swap_date = current_date + 13 where id = pg_temp.id('CS')$$));
select pg_temp.as_postgres();
select is((select swap_date from public.circles where id = pg_temp.id('CO')), current_date + 11,
          'SWAP-03 open: the Elf can change the swap date (' || pg_temp.val('upd_open') || ')');
select is((select swap_date from public.circles where id = pg_temp.id('CD')), current_date + 12,
          'SWAP-03 drawn: the Elf can change the swap date (' || pg_temp.val('upd_drawn') || ')');
select is((select swap_date from public.circles where id = pg_temp.id('CS')), current_date + 13,
          'SWAP-03 sent: the Elf can change the swap date (' || pg_temp.val('upd_sent') || ')');

-- SWAP-04 ... but never clear it ------------------------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.outcome($$update public.circles set swap_date = null where id = pg_temp.id('CS')$$),
          'rejected', 'SWAP-04 the Elf cannot clear the swap date');
select pg_temp.as_postgres();

-- SWAP-05 changing the date leaves the status and draw alone ---------------------
select is(pg_temp.circle_status('CS') || '|' || pg_temp.match_count('CS')::text, 'sent|3',
          'SWAP-05 changing the swap date of a sent circle keeps it sent with its matches');

-- And another Elf still cannot change it (ISO rules apply to the date too).
select pg_temp.act_as('elf_b');
select pg_temp.try($$update public.circles set swap_date = current_date + 99 where id = pg_temp.id('CO')$$);
select pg_temp.as_postgres();
select is((select swap_date from public.circles where id = pg_temp.id('CO')), current_date + 11,
          'SWAP-05 Elf B cannot change Elf A''s swap date');

select * from finish();
rollback;
