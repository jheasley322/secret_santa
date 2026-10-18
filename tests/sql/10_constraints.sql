-- ===========================================================================
-- 10 -- Table constraints
-- ===========================================================================
-- Spec: "Interface contract -> Constraints", "Data model".
-- Scenarios CON-01..19 in tests/SCENARIOS.md.
--
-- Everything here runs as the setup role, because constraints bind every
-- role. pg_temp.outcome() runs a statement, always undoes it, and reports
-- 'accepted' / 'rejected' / 'error ...' (see fixtures.sql).

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(48);

select pg_temp.mk_elf('elf');
select pg_temp.mk_circle('C1', 'elf');
select pg_temp.mk_circle('C2', 'elf');
select pg_temp.mk_members('C1', 'Maya', 'Ben', 'Cy');
select pg_temp.mk_member('Wes', 'C2');

-- CON-01 first_name length ----------------------------------------------------
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), repeat('a', 40), null)$$),
          'accepted', 'CON-01 a 40-character first name is accepted');
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), repeat('a', 41), null)$$),
          'rejected', 'CON-01 a 41-character first name is rejected');

-- CON-02 empty names ----------------------------------------------------------
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), '', null)$$),
          'rejected', 'CON-02 an empty first name is rejected');
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), '    ', null)$$),
          'rejected', 'CON-02 a whitespace-only first name is rejected');
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), null, null)$$),
          'rejected', 'CON-02 a null first name is rejected');

-- CON-03 trimmed: either trimmed on save or rejected, never stored padded ------
select pg_temp.try($$insert into public.members (circle_id, first_name, phone)
                     values (pg_temp.id('C1'), '  Padded  ', null)$$);
select is((select count(*) from public.members
            where circle_id = pg_temp.id('C1') and first_name <> btrim(first_name)),
          0::bigint, 'CON-03 no first name is stored with leading or trailing spaces');

-- CON-04 / 05 uniqueness ------------------------------------------------------
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), 'maya', null)$$),
          'rejected', 'CON-04 "maya" is rejected when "Maya" is already in the circle');
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C1'), 'MAYA', null)$$),
          'rejected', 'CON-04 "MAYA" is rejected too');
select is(pg_temp.outcome($$insert into public.members (circle_id, first_name, phone)
                            values (pg_temp.id('C2'), 'Maya', null)$$),
          'accepted', 'CON-05 the same first name is fine in another circle');

-- CON-06 / 07 phone -----------------------------------------------------------
select is(pg_temp.outcome($$update public.members set phone = null where id = pg_temp.id('Maya')$$),
          'accepted', 'CON-06 a null phone is accepted');
select is(pg_temp.outcome($$update public.members set phone = '+15555550142' where id = pg_temp.id('Maya')$$),
          'accepted', 'CON-06 an E.164 phone is accepted');
select is(pg_temp.outcome($$update public.members set phone = '15555550142' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a phone without + is rejected');
select is(pg_temp.outcome($$update public.members set phone = '+05555550142' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a phone with a leading 0 country code is rejected');
select is(pg_temp.outcome($$update public.members set phone = '+1 555 555 0142' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a phone with spaces is rejected');
select is(pg_temp.outcome($$update public.members set phone = '+1-555-555-0142' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a phone with dashes is rejected');
select is(pg_temp.outcome($$update public.members set phone = '+1555555' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a 7-digit phone is too short');
select is(pg_temp.outcome($$update public.members set phone = '+1555555014200000' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a 16-digit phone is too long');
select is(pg_temp.outcome($$update public.members set phone = '+1555555O14Z' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 a phone with letters is rejected');
select is(pg_temp.outcome($$update public.members set phone = '' where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-07 an empty-string phone is rejected (null is the "no phone" value)');

-- CON-08 budget ---------------------------------------------------------------
select is(pg_temp.outcome($$update public.circles set budget = -1 where id = pg_temp.id('C1')$$),
          'rejected', 'CON-08 a negative budget is rejected');
select is(pg_temp.outcome($$update public.circles set budget = 0 where id = pg_temp.id('C1')$$),
          'accepted', 'CON-08 a budget of 0 is accepted');
select is(pg_temp.outcome($$update public.circles set budget = null where id = pg_temp.id('C1')$$),
          'accepted', 'CON-08 no budget (null) is accepted');

-- CON-09 status ---------------------------------------------------------------
select is(pg_temp.circle_status('C1'), 'open', 'CON-09 a new circle defaults to open');
select is(pg_temp.outcome($$update public.circles set status = 'finished' where id = pg_temp.id('C1')$$),
          'rejected', 'CON-09 a status outside open/drawn/sent is rejected');
select is(pg_temp.outcome($$update public.circles set status = null where id = pg_temp.id('C1')$$),
          'rejected', 'CON-09 a null status is rejected');

-- CON-10 tokens ---------------------------------------------------------------
select is((select count(*) from public.members
            where circle_id in (pg_temp.id('C1'), pg_temp.id('C2'))
              and (token is null or token !~ '^[A-Za-z0-9_-]{43}$')),
          0::bigint, 'CON-10 every member gets a 43-character base64url token (32 random bytes)');
select is((select count(distinct token) from public.members
            where circle_id in (pg_temp.id('C1'), pg_temp.id('C2'))),
          (select count(*) from public.members
            where circle_id in (pg_temp.id('C1'), pg_temp.id('C2'))),
          'CON-10 every token is different');
select is(pg_temp.outcome($$update public.members set token = pg_temp.tok('Ben') where id = pg_temp.id('Maya')$$),
          'rejected', 'CON-10 a duplicate token is rejected');

-- CON-11 list_done default ----------------------------------------------------
insert into public.members (circle_id, first_name, phone) values (pg_temp.id('C1'), 'Defaulty', null);
select is((select list_done from public.members
            where circle_id = pg_temp.id('C1') and first_name = 'Defaulty'),
          false, 'CON-11 list_done defaults to false');

-- CON-12..14 no_pairs ---------------------------------------------------------
select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C1'),
                                    greatest(pg_temp.id('Maya'), pg_temp.id('Ben')),
                                    least(pg_temp.id('Maya'), pg_temp.id('Ben')))$$),
          'rejected', 'CON-12 a no-pair stored with member_a > member_b is rejected');
select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C1'), pg_temp.id('Maya'), pg_temp.id('Maya'))$$),
          'rejected', 'CON-12 a no-pair of a member with themselves is rejected');
select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C1'),
                                    least(pg_temp.id('Maya'), pg_temp.id('Ben')),
                                    greatest(pg_temp.id('Maya'), pg_temp.id('Ben')))$$),
          'accepted', 'CON-12 a no-pair stored with member_a < member_b is accepted');

select pg_temp.mk_no_pair('C1', 'Maya', 'Ben');
select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C1'),
                                    least(pg_temp.id('Maya'), pg_temp.id('Ben')),
                                    greatest(pg_temp.id('Maya'), pg_temp.id('Ben')))$$),
          'rejected', 'CON-13 the same no-pair twice in one circle is rejected');

select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C1'),
                                    least(pg_temp.id('Cy'), pg_temp.id('Wes')),
                                    greatest(pg_temp.id('Cy'), pg_temp.id('Wes')))$$),
          'rejected', 'CON-14 a no-pair naming a member of another circle is rejected');
select is(pg_temp.outcome($$insert into public.no_pairs (circle_id, member_a, member_b)
                            values (pg_temp.id('C2'),
                                    least(pg_temp.id('Cy'), pg_temp.id('Ben')),
                                    greatest(pg_temp.id('Cy'), pg_temp.id('Ben')))$$),
          'rejected', 'CON-14 a no-pair filed under a circle neither member is in is rejected');

-- CON-15..17 matches ----------------------------------------------------------
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C1'), pg_temp.id('Maya'), pg_temp.id('Maya'))$$),
          'rejected', 'CON-15 a match where giver = receiver is rejected');
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C1'), pg_temp.id('Maya'), pg_temp.id('Wes'))$$),
          'rejected', 'CON-16 a match with a receiver from another circle is rejected');
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C1'), pg_temp.id('Wes'), pg_temp.id('Maya'))$$),
          'rejected', 'CON-16 a match with a giver from another circle is rejected');
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C2'), pg_temp.id('Maya'), pg_temp.id('Ben'))$$),
          'rejected', 'CON-16 a match filed under a circle neither member is in is rejected');

select pg_temp.mk_matches('C1', 'Maya', 'Ben');
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C1'), pg_temp.id('Maya'), pg_temp.id('Cy'))$$),
          'rejected', 'CON-17 a member can be a giver only once');
select is(pg_temp.outcome($$insert into public.matches (circle_id, giver_id, receiver_id)
                            values (pg_temp.id('C1'), pg_temp.id('Cy'), pg_temp.id('Ben'))$$),
          'rejected', 'CON-17 a member can be a receiver only once');

-- CON-18 wish item links ------------------------------------------------------
select is(pg_temp.outcome($$insert into public.wish_items (member_id, text, url, position)
                            values (pg_temp.id('Maya'), 'Lego', 'javascript:alert(1)', 0)$$),
          'rejected', 'CON-18 a javascript: link is rejected at the table');
select is(pg_temp.outcome($$insert into public.wish_items (member_id, text, url, position)
                            values (pg_temp.id('Maya'), 'Lego', 'data:text/html,<script>alert(1)</script>', 0)$$),
          'rejected', 'CON-18 a data: link is rejected at the table');
select is(pg_temp.outcome($$insert into public.wish_items (member_id, text, url, position)
                            values (pg_temp.id('Maya'), 'Lego', 'https://example.com/lego', 0)$$),
          'accepted', 'CON-18 an https link is accepted');
select is(pg_temp.outcome($$insert into public.wish_items (member_id, text, url, position)
                            values (pg_temp.id('Maya'), 'Lego', null, 0)$$),
          'accepted', 'CON-18 no link (null) is accepted');

-- CON-19 texts ----------------------------------------------------------------
select is(pg_temp.outcome($$insert into public.texts (member_id, kind, status, created_at)
                            values (pg_temp.id('Maya'), 'invite', 'sent', now())$$),
          'accepted', 'CON-19 an invite/sent text row is accepted');
select is(pg_temp.outcome($$insert into public.texts (member_id, kind, status, created_at)
                            values (pg_temp.id('Maya'), 'reminder', 'sent', now())$$),
          'rejected', 'CON-19 a text kind other than invite/reveal is rejected');
select is(pg_temp.outcome($$insert into public.texts (member_id, kind, status, created_at)
                            values (pg_temp.id('Maya'), 'reveal', 'delivered', now())$$),
          'rejected', 'CON-19 a text status other than sent/failed is rejected');

select * from finish();
rollback;
