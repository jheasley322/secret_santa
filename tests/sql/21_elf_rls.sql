-- ===========================================================================
-- 21 -- The Elf and their own circle (RLS + column rules)
-- ===========================================================================
-- Spec: "Interface contract -> Elf direct table access (RLS)", "Circle details"
-- ("The Elf can edit these at any time"), "Access rules -> Elf".
-- Scenarios ELF-01..17 in tests/SCENARIOS.md.
--
-- "Not client-writable" is checked on the OUTCOME: after the attempt, the value
-- is what it was. Whether the attempt errors or is silently ignored is the
-- implementation's choice; the spec fixes only that it can't succeed.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(39);

select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');

-- CA: open circle with members, an item, a no-pair and an invite text.
select pg_temp.mk_circle('CA', 'elf_a');
select pg_temp.mk_members('CA', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_item('Cy', 'Kite', 0);
select pg_temp.mk_no_pair('CA', 'Ava', 'Ben');
select pg_temp.mk_text('Cy', 'invite');

-- CD: drawn circle with matches and texts.
select pg_temp.mk_circle('CD', 'elf_a');
select pg_temp.mk_members('CD', 'Dan', 'Eli', 'Fay');
select pg_temp.mk_item('Eli', 'Book', 0);
select pg_temp.mk_matches('CD', 'Dan', 'Eli', 'Eli', 'Fay', 'Fay', 'Dan');
select pg_temp.set_status('CD', 'drawn');
select pg_temp.mk_text('Dan', 'invite');
select pg_temp.mk_text('Eli', 'invite', 'failed');

-- ELF-01 create a circle ------------------------------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$insert into public.circles (name, budget, swap_date, swap_place)
                        values ('pgtap:elf-new', 15, current_date + 20, 'the park')$$),
          'succeeded', 'ELF-01 the Elf can create a circle without naming an owner');
select pg_temp.as_postgres();
select is((select elf_id from public.circles where name = 'pgtap:elf-new'), pg_temp.id('elf_a'),
          'ELF-01 elf_id defaults to the signed-in Elf');
select is((select status from public.circles where name = 'pgtap:elf-new'), 'open',
          'ELF-01 a new circle is open');

-- ELF-02 read and edit details ------------------------------------------------
select pg_temp.act_as('elf_a');
select is((select count(*) from public.circles where id in (pg_temp.id('CA'), pg_temp.id('CD'))), 2::bigint,
          'ELF-02 the Elf can read their circles');
update public.circles set name = 'pgtap:CA renamed', budget = 25, swap_date = current_date + 10,
                          swap_place = 'Gran''s house'
 where id = pg_temp.id('CA');
select pg_temp.as_postgres();
select is((select array[name, budget::text, swap_date::text, swap_place] from public.circles where id = pg_temp.id('CA')),
          array['pgtap:CA renamed', '25', (current_date + 10)::text, 'Gran''s house'],
          'ELF-02 the Elf can edit name, budget, swap date and place');

-- ELF-03 / 04 status is not client-writable -----------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.try($$insert into public.circles (name, swap_date, status) values ('pgtap:elf-status', current_date + 20, 'sent')$$);
select pg_temp.try($$update public.circles set status = 'sent'  where id = pg_temp.id('CA')$$);
select pg_temp.try($$update public.circles set status = 'drawn' where id = pg_temp.id('CA')$$);
select pg_temp.try($$update public.circles set status = 'open'  where id = pg_temp.id('CD')$$);
select pg_temp.as_postgres();
select is((select count(*) from public.circles where name = 'pgtap:elf-status' and status <> 'open'), 0::bigint,
          'ELF-03 the Elf cannot create a circle with a status other than open');
select is(pg_temp.circle_status('CA'), 'open',  'ELF-04 the Elf cannot move a circle from open by direct update');
select is(pg_temp.circle_status('CD'), 'drawn', 'ELF-04 the Elf cannot move a circle from drawn back to open by direct update');

-- ELF-05 / 06 elf_id is not client-writable -----------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.try($$insert into public.circles (name, swap_date, elf_id) values ('pgtap:elf-for-b', current_date + 20, pg_temp.id('elf_b'))$$);
select pg_temp.try($$update public.circles set elf_id = pg_temp.id('elf_b') where id = pg_temp.id('CA')$$);
select pg_temp.as_postgres();
select is((select count(*) from public.circles where name = 'pgtap:elf-for-b' and elf_id = pg_temp.id('elf_b')), 0::bigint,
          'ELF-05 the Elf cannot create a circle owned by someone else');
select is((select elf_id from public.circles where id = pg_temp.id('CA')), pg_temp.id('elf_a'),
          'ELF-06 the Elf cannot hand their circle to someone else');

-- ELF-07 add a member; token generated; phone and token readable --------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$insert into public.members (circle_id, first_name, phone)
                        values (pg_temp.id('CA'), 'Dee', '+15555550177')$$),
          'succeeded', 'ELF-07 the Elf can add a member to their circle');
select pg_temp.as_postgres();
select pg_temp.remember('Dee', (select id from public.members where circle_id = pg_temp.id('CA') and first_name = 'Dee'));
select ok((select token ~ '^[A-Za-z0-9_-]{16}$' from public.members where id = pg_temp.id('Dee')),
          'ELF-07 the new member gets a generated token');
select pg_temp.act_as('elf_a');
select pg_temp.keep('dee_seen', (select phone || '|' || token from public.members where id = pg_temp.id('Dee')));
select pg_temp.as_postgres();
select is(pg_temp.val('dee_seen'), (select phone || '|' || token from public.members where id = pg_temp.id('Dee')),
          'ELF-07 the Elf can read the member''s phone and token');

-- ELF-08 / 09 token is not client-writable ------------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.try($$insert into public.members (circle_id, first_name, token)
                     values (pg_temp.id('CA'), 'Eve', 'pgtap-chosen-token-aaaaaaaaaaaaaaaaaaaaaaaa')$$);
select pg_temp.try($$update public.members set token = 'pgtap-changed-token-aaaaaaaaaaaaaaaaaaaaaaa'
                      where id = pg_temp.id('Ava')$$);
select pg_temp.as_postgres();
select is((select count(*) from public.members where token = 'pgtap-chosen-token-aaaaaaaaaaaaaaaaaaaaaaaa'), 0::bigint,
          'ELF-08 the Elf cannot choose a member''s token');
select is((select token from public.members where id = pg_temp.id('Ava')), pg_temp.tok('Ava'),
          'ELF-09 the Elf cannot change a member''s token');

-- ELF-10 edit and remove members while open -----------------------------------
select pg_temp.act_as('elf_a');
update public.members set first_name = 'Benji', phone = '+15555550178' where id = pg_temp.id('Ben');
delete from public.members where id = pg_temp.id('Dee');
select pg_temp.as_postgres();
select is((select first_name || '|' || phone from public.members where id = pg_temp.id('Ben')), 'Benji|+15555550178',
          'ELF-10 the Elf can edit a member''s name and phone');
select is((select count(*) from public.members where id = pg_temp.id('Dee')), 0::bigint,
          'ELF-10 the Elf can remove a member while open');

-- ELF-11 wish items: full access ----------------------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$insert into public.wish_items (member_id, text, url, position)
                        values (pg_temp.id('Ava'), 'Paints', 'https://example.com/paints', 0)$$),
          'succeeded', 'ELF-11 the Elf can insert a wish item');
select is((select count(*) from public.wish_items where member_id in (pg_temp.id('Ava'), pg_temp.id('Cy'))), 2::bigint,
          'ELF-11 the Elf can read wish items');
update public.wish_items set text = 'Watercolours' where member_id = pg_temp.id('Ava');
select is((select text from public.wish_items where member_id = pg_temp.id('Ava')), 'Watercolours',
          'ELF-11 the Elf can update a wish item');
delete from public.wish_items where member_id = pg_temp.id('Ava');
select pg_temp.as_postgres();
select is((select count(*) from public.wish_items where member_id = pg_temp.id('Ava')), 0::bigint,
          'ELF-11 the Elf can delete a wish item');

-- ELF-12 no-pairs: insert, select, delete -------------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$insert into public.no_pairs (circle_id, member_a, member_b)
                        values (pg_temp.id('CA'), least(pg_temp.id('Ava'), pg_temp.id('Cy')),
                                greatest(pg_temp.id('Ava'), pg_temp.id('Cy')))$$),
          'succeeded', 'ELF-12 the Elf can add a no-pair');
select is((select count(*) from public.no_pairs where circle_id = pg_temp.id('CA')), 2::bigint,
          'ELF-12 the Elf can read no-pairs');
delete from public.no_pairs
 where circle_id = pg_temp.id('CA') and pg_temp.id('Cy') in (member_a, member_b);
select pg_temp.as_postgres();
select is((select count(*) from public.no_pairs where circle_id = pg_temp.id('CA')), 1::bigint,
          'ELF-12 the Elf can remove a no-pair');

-- ELF-13 read matches and texts -----------------------------------------------
select pg_temp.act_as('elf_a');
select is((select count(*) from public.matches where circle_id = pg_temp.id('CD')), 3::bigint,
          'ELF-13 the Elf can read every match in their circle');
select is((select count(*) from public.texts
            where member_id in (pg_temp.id('Dan'), pg_temp.id('Eli'), pg_temp.id('Cy'))), 3::bigint,
          'ELF-13 the Elf can read the texts for their members');

-- ELF-14 matches are read-only ------------------------------------------------
select pg_temp.try($$insert into public.matches (circle_id, giver_id, receiver_id)
                     values (pg_temp.id('CA'), pg_temp.id('Ava'), pg_temp.id('Cy'))$$);
select pg_temp.try($$update public.matches set receiver_id = giver_id, giver_id = receiver_id
                      where circle_id = pg_temp.id('CD')$$);
select pg_temp.try($$update public.matches set opened_at = now() where circle_id = pg_temp.id('CD')$$);
select pg_temp.try($$delete from public.matches where circle_id = pg_temp.id('CD')$$);
select pg_temp.as_postgres();
select is(pg_temp.match_count('CA'), 0::bigint, 'ELF-14 the Elf cannot insert a match');
select is(pg_temp.draw_sig('CD'), 'Dan>Eli,Eli>Fay,Fay>Dan', 'ELF-14 the Elf cannot rewrite matches');
select is((select count(*) from public.matches where circle_id = pg_temp.id('CD') and opened_at is not null), 0::bigint,
          'ELF-14 the Elf cannot set opened_at');
select is(pg_temp.match_count('CD'), 3::bigint, 'ELF-14 the Elf cannot delete matches');

-- ELF-15 texts are read-only --------------------------------------------------
select pg_temp.act_as('elf_a');
select pg_temp.try($$insert into public.texts (member_id, kind, status, created_at)
                     values (pg_temp.id('Fay'), 'reveal', 'sent', now())$$);
select pg_temp.try($$update public.texts set status = 'sent', error = null where member_id = pg_temp.id('Eli')$$);
select pg_temp.try($$delete from public.texts where member_id = pg_temp.id('Dan')$$);
select pg_temp.as_postgres();
select is((select count(*) from public.texts where member_id = pg_temp.id('Fay')), 0::bigint,
          'ELF-15 the Elf cannot insert a text row');
select is((select status from public.texts where member_id = pg_temp.id('Eli')), 'failed',
          'ELF-15 the Elf cannot change a text''s status');
select is((select count(*) from public.texts where member_id = pg_temp.id('Dan')), 1::bigint,
          'ELF-15 the Elf cannot delete a text row');

-- ELF-02 (after sent) details stay editable -----------------------------------
select pg_temp.mark_sent('CD');
select pg_temp.act_as('elf_a');
update public.circles set budget = 30, swap_place = 'school hall' where id = pg_temp.id('CD');
select pg_temp.as_postgres();
select is((select budget::text || '|' || swap_place from public.circles where id = pg_temp.id('CD')), '30|school hall',
          'ELF-02 the Elf can still edit circle details after the names are sent');

-- ELF-17 remove a member who has a list and an invite text --------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$delete from public.members where id = pg_temp.id('Cy')$$), 'succeeded',
          'ELF-17 the Elf can remove a member who has wish items and texts');
select pg_temp.as_postgres();
select is((select count(*) from public.members where id = pg_temp.id('Cy'))
        + (select count(*) from public.wish_items where member_id = pg_temp.id('Cy'))
        + (select count(*) from public.texts where member_id = pg_temp.id('Cy')),
          0::bigint, 'ELF-17 ... and the member''s items and texts go with them');

-- ELF-16 delete a whole circle, open and sent ---------------------------------
select pg_temp.act_as('elf_a');
select is(pg_temp.try($$delete from public.circles where id = pg_temp.id('CA')$$), 'succeeded',
          'ELF-16 the Elf can delete their open circle');
select is(pg_temp.try($$delete from public.circles where id = pg_temp.id('CD')$$), 'succeeded',
          'ELF-16 the Elf can delete their circle after the names are sent');
select pg_temp.as_postgres();
select is(
  (select count(*) from public.circles    where id        in (pg_temp.id('CA'), pg_temp.id('CD')))
+ (select count(*) from public.members    where circle_id in (pg_temp.id('CA'), pg_temp.id('CD')))
+ (select count(*) from public.wish_items where member_id in (select id from pg_temp.t_id))
+ (select count(*) from public.no_pairs   where circle_id in (pg_temp.id('CA'), pg_temp.id('CD')))
+ (select count(*) from public.matches    where circle_id in (pg_temp.id('CA'), pg_temp.id('CD')))
+ (select count(*) from public.texts      where member_id in (select id from pg_temp.t_id)),
  0::bigint, 'ELF-16 deleting a circle leaves no members, items, no-pairs, matches or texts behind');

select * from finish();
rollback;
