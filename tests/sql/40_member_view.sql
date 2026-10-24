-- ===========================================================================
-- 40 -- What a member sees: member_view(p_token)
-- ===========================================================================
-- Spec: "Privacy rules", "Interface contract -> member_view", "Access rules ->
-- Member", "Circle status" ("Members see their match only once the circle is
-- sent"). Scenarios MV-01..17 in tests/SCENARIOS.md.
--
-- Every call goes through the anon role, the way a kid's browser makes it.
-- pg_temp.capture_view() stores each payload in t_view so it can be inspected
-- afterwards without calling member_view again (which has side effects).

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(36);

select pg_temp.mk_elf('elf');
select pg_temp.mk_elf('elf_w');

select pg_temp.mk_circle('V', 'elf', current_date + 30, 20, 'Maya''s house');
-- Inserted out of alphabetical order so MV-06 can see the ordering.
select pg_temp.mk_members('V', 'Zoe', 'Maya', 'Ava', 'Ben');
-- Inserted out of position order so MV-05 can see the ordering.
select pg_temp.mk_item('Ava', 'Kite', 2);
select pg_temp.mk_item('Ava', 'Book', 1);
select pg_temp.mk_item('Ava', 'Lego', 0, 'https://example.com/lego');
-- Everyone has a list, so whoever Ava draws, MV-12 compares a real list.
select pg_temp.mk_item('Ben', 'Puzzle', 0, 'http://example.com/puzzle');
select pg_temp.mk_item('Ben', 'Socks', 1);
select pg_temp.mk_item('Maya', 'Paints', 0);
select pg_temp.mk_item('Zoe', 'Skates', 0, 'https://example.com/skates');
update public.members set fav_color = 'teal', fav_snack = 'popcorn', sizes = 'shirt M, shoe 4', please_no = 'nuts'
 where id = pg_temp.id('Maya');
select pg_temp.mk_no_pair('V', 'Zoe', 'Ben');

select pg_temp.mk_circle('W', 'elf_w');
select pg_temp.mk_members('W', 'Wes', 'Xia', 'Yan');

-- MV-01 unknown and malformed tokens ------------------------------------------
select pg_temp.act_as_anon();
select throws_ok($$select public.member_view('')$$, null, 'link not found', 'MV-01 an empty token gets link not found');
select throws_ok($$select public.member_view('nope')$$, null, 'link not found', 'MV-01 a garbage token gets link not found');
select throws_ok($$select public.member_view(repeat('A', 16))$$, null, 'link not found',
                 'MV-01 a well-formed but unknown token gets link not found');
select throws_ok($$select public.member_view(left(pg_temp.tok('Ava'), 8))$$, null, 'link not found',
                 'MV-01 a prefix of a real token gets link not found');
select throws_ok($$select public.member_view(upper(pg_temp.tok('Ava')))$$, null, 'link not found',
                 'MV-01 a real token in upper case gets link not found (tokens are case-sensitive)');
select throws_ok($$select public.member_view(''' or 1=1 --')$$, null, 'link not found',
                 'MV-01 an injection string gets link not found');
select throws_ok($$select public.member_view(null)$$, null, 'link not found', 'MV-01 a null token gets link not found');
select pg_temp.as_postgres();

-- While open ------------------------------------------------------------------
select pg_temp.capture_view('ava_open', 'Ava');
select pg_temp.capture_view('zoe_open', 'Zoe');

-- MV-02 / 03 top level and circle --------------------------------------------
select is(pg_temp.keys(pg_temp.view('ava_open')), array['circle', 'match', 'me', 'members'],
          'MV-02 the payload has exactly circle, me, members, match');
select is(pg_temp.keys(pg_temp.view('ava_open')->'circle'), array['budget', 'name', 'status', 'swap_date', 'swap_place'],
          'MV-03 circle has exactly name, budget, swap_date, swap_place, status');
select is((select array[c->>'name', c->>'budget', c->>'swap_date', c->>'swap_place', c->>'status']
             from (select pg_temp.view('ava_open')->'circle' c) s),
          array['pgtap:V', '20', (current_date + 30)::text, 'Maya''s house', 'open'],
          'MV-03 circle carries the right details');

-- MV-04 / 05 exact shapes -----------------------------------------------------
select is((select count(*) from (select pg_temp.view('ava_open')->'me' m
                                 union all
                                 select jsonb_array_elements(pg_temp.view('ava_open')->'members')) s
            where pg_temp.keys(m) <> array['fav_color','fav_snack','first_name','id','items','list_done','please_no','sizes']),
          0::bigint, 'MV-04 me and every member have exactly the spec keys (no phone, token, created_at, opened_at)');
select is((select count(*)
             from jsonb_array_elements(pg_temp.view('ava_open')->'members') m,
                  jsonb_array_elements(m->'items') i
            where pg_temp.keys(i) <> array['position', 'text', 'url']),
          0::bigint, 'MV-05 every wish item has exactly text, url, position');
select is((select array_agg(i->>'text' order by o)
             from jsonb_array_elements(pg_temp.view('ava_open')->'me'->'items') with ordinality t(i, o)),
          array['Lego', 'Book', 'Kite'], 'MV-05 items are ordered by position');
select is((select array_agg(i->>'position' order by o)
             from jsonb_array_elements(pg_temp.view('ava_open')->'me'->'items') with ordinality t(i, o)),
          array['0', '1', '2'], 'MV-05 items carry their position');

-- MV-06 / 07 / 08 who is in it ------------------------------------------------
select is((select array_agg(m->>'first_name' order by o)
             from jsonb_array_elements(pg_temp.view('ava_open')->'members') with ordinality t(m, o)),
          array['Ava', 'Ben', 'Maya', 'Zoe'],
          'MV-06 members is everyone in the circle including me, ordered by first name');
select is((select array[m->>'id', m->>'first_name'] from (select pg_temp.view('ava_open')->'me' m) s),
          array[pg_temp.id('Ava')::text, 'Ava'], 'MV-07 me is the caller');
select is((select array[m->>'fav_color', m->>'fav_snack', m->>'sizes', m->>'please_no']
             from jsonb_array_elements(pg_temp.view('ava_open')->'members') m where m->>'first_name' = 'Maya'),
          array['teal', 'popcorn', 'shirt M, shoe 4', 'nuts'], 'MV-08 another member''s About me is visible');
select is((select array_agg(i->>'text' order by o)
             from jsonb_array_elements(pg_temp.view('zoe_open')->'members') m,
                  jsonb_array_elements(m->'items') with ordinality t(i, o)
            where m->>'first_name' = 'Ava'),
          array['Lego', 'Book', 'Kite'], 'MV-08 another member''s wish items are visible');

-- MV-11 no match while open ---------------------------------------------------
select is(pg_temp.view('ava_open')->'match', 'null'::jsonb, 'MV-11 match is null while the circle is open');

-- While drawn -----------------------------------------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('V'))$$, 'MV setup: the Elf draws');
select pg_temp.as_postgres();
select pg_temp.capture_view('ava_drawn', 'Ava');
select is(pg_temp.view('ava_drawn')->'match', 'null'::jsonb, 'MV-11 match is still null while drawn (not yet sent)');
select is((select count(*) from public.matches where circle_id = pg_temp.id('V') and opened_at is not null), 0::bigint,
          'MV-13 viewing while open or drawn sets no opened_at');

-- Once sent -------------------------------------------------------------------
select pg_temp.mark_sent('V');
select pg_temp.remember('ava_gets', (select receiver_id from public.matches where giver_id = pg_temp.id('Ava')));
select pg_temp.capture_view('ava_sent', 'Ava');

-- MV-14 first view sets opened_at, for the caller only
select isnt((select opened_at from public.matches where giver_id = pg_temp.id('Ava')), null,
            'MV-14 the first view once sent sets the caller''s opened_at');
select is((select count(*) from public.matches
            where circle_id = pg_temp.id('V') and giver_id <> pg_temp.id('Ava') and opened_at is not null),
          0::bigint, 'MV-14 ... and nobody else''s');

-- MV-12 the caller's own match, with the receiver's list
select is(pg_temp.view('ava_sent')->'match'->>'id', pg_temp.id('ava_gets')::text,
          'MV-12 once sent, match is the caller''s own receiver');
select is(pg_temp.keys(pg_temp.view('ava_sent')->'match'),
          array['fav_color','fav_snack','first_name','id','items','list_done','please_no','sizes'],
          'MV-04 match has exactly the spec member keys');
select is(pg_temp.view('ava_sent')->'match'->'items',
          (select coalesce(jsonb_agg(jsonb_build_object('text', text, 'url', url, 'position', position) order by position),
                           '[]'::jsonb)
             from public.wish_items where member_id = pg_temp.id('ava_gets')),
          'MV-12 match carries the receiver''s wish list');

select pg_temp.capture_view('sent_Ben', 'Ben');
select pg_temp.capture_view('sent_Maya', 'Maya');
select pg_temp.capture_view('sent_Zoe', 'Zoe');
select pg_temp.capture_view('sent_Ava', 'Ava');
select is((select count(*) from unnest(array['Ava', 'Ben', 'Maya', 'Zoe']) l
            where (pg_temp.view('sent_' || l)->'match'->>'id')
                  is distinct from (select receiver_id::text from public.matches where giver_id = pg_temp.id(l))),
          0::bigint, 'MV-12 every member sees exactly their own match');

-- MV-15 later views don't overwrite opened_at
update public.matches set opened_at = '2020-01-01 00:00:00+00' where giver_id = pg_temp.id('Ava');
select pg_temp.capture_view('ava_again', 'Ava');
select is((select opened_at from public.matches where giver_id = pg_temp.id('Ava')), '2020-01-01 00:00:00+00'::timestamptz,
          'MV-15 a later view does not overwrite opened_at');

-- MV-16 authenticated may call it too
select pg_temp.act_as('elf');
select lives_ok(format('select public.member_view(%L)', pg_temp.tok('Ava')),
                'MV-16 member_view works for the authenticated role too');
select pg_temp.as_postgres();

-- MV-17 list edits after sending reach the Santa
select pg_temp.keep('ava_gets_token', (select token from public.members where id = pg_temp.id('ava_gets')));
select pg_temp.act_as_anon();
select lives_ok(format($f$select public.save_my_list(%L, '{}'::jsonb, '[{"text":"Telescope","url":null}]'::jsonb)$f$,
                       pg_temp.val('ava_gets_token')),
                'MV-17 the receiver edits their list after the names are sent');
select pg_temp.as_postgres();
select pg_temp.capture_view('ava_after_edit', 'Ava');
select is((select array_agg(i->>'text') from jsonb_array_elements(pg_temp.view('ava_after_edit')->'match'->'items') i),
          array['Telescope'], 'MV-17 the Santa sees the updated list');

-- MV-09 / 10 across every payload captured above ------------------------------
select is((select count(*) from pg_temp.t_view where v is null), 0::bigint,
          'MV setup: every captured payload is non-null');
select is((select count(*) from pg_temp.t_view t
             join public.members m on m.circle_id in (pg_temp.id('V'), pg_temp.id('W'))
            where m.phone is not null
              and (position(m.phone in t.v::text) > 0 or position(substr(m.phone, 2) in t.v::text) > 0)),
          0::bigint, 'MV-09 no phone number appears in any payload, including the caller''s own');
select is((select count(*) from pg_temp.t_view t
             join public.members m on m.circle_id in (pg_temp.id('V'), pg_temp.id('W'))
            where position(m.token in t.v::text) > 0),
          0::bigint, 'MV-10 no token appears in any payload, including the caller''s own');
select is((select count(*) from pg_temp.t_view t
            where t.v::text ~* '"(phone|token|created_at|opened_at|member_a|member_b|no_pairs?|giver_id|receiver_id)"'),
          0::bigint, 'MV-04 no payload carries a phone, token, timestamp, no-pair or match-id key anywhere');

select * from finish();
rollback;
