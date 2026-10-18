-- ===========================================================================
-- 41 -- Saving a list: save_my_list and set_list_done
-- ===========================================================================
-- Spec: "Wish list", "Interface contract -> save_my_list / set_list_done",
-- "Stack" (wish links), "Error messages" (`invalid list: <reason>`).
-- Scenarios LIST-01..12 and DONE-01..02 in tests/SCENARIOS.md.
--
-- Calls go through the anon role, the way a kid's browser makes them. The
-- reason after "invalid list: " is the implementation's to word; the tests
-- require only that one is given.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(49);

select pg_temp.mk_elf('elf');
select pg_temp.mk_circle('L', 'elf');
select pg_temp.mk_members('L', 'Ava', 'Ben');
select pg_temp.mk_member('Cy', 'L', p_done => false);
select pg_temp.mk_item('Ben', 'Ben''s own wish', 0);
update public.members set fav_color = 'red' where id = pg_temp.id('Ben');

-- The SQL for one save by a member, for throws_* / lives_ok.
create function pg_temp.save_sql(p_label text, p_about text, p_items text) returns text
language sql stable as $fx$
  select format('select public.save_my_list(%L, %L::jsonb, %L::jsonb)', pg_temp.tok(p_label), p_about, p_items);
$fx$;

-- One item with the given text and url, as a json array literal.
create function pg_temp.one_item(p_text text, p_url text default null) returns text
language sql immutable as $fx$
  select jsonb_build_array(jsonb_build_object('text', p_text, 'url', p_url))::text;
$fx$;

-- n plain items.
create function pg_temp.n_items(p_n int) returns text
language sql immutable as $fx$
  select coalesce(jsonb_agg(jsonb_build_object('text', 'Item ' || g, 'url', null) order by g), '[]'::jsonb)::text
    from generate_series(1, p_n) g;
$fx$;

create function pg_temp.items_of(p_label text) returns text[]
language plpgsql as $fx$
declare v text[];
begin
  select array_agg(text order by position) into v from public.wish_items where member_id = pg_temp.id(p_label);
  return v;
end $fx$;

-- LIST-01 ---------------------------------------------------------------------
select pg_temp.act_as_anon();
select throws_ok($$select public.save_my_list('nope', '{}'::jsonb, '[]'::jsonb)$$, null, 'link not found',
                 'LIST-01 an unknown token gets link not found');

-- LIST-02 a valid save --------------------------------------------------------
select lives_ok(pg_temp.save_sql('Ava',
                  '{"fav_color":"  teal  ","fav_snack":"popcorn","sizes":"shirt M","please_no":null}',
                  '[{"text":"  Lego  ","url":"https://example.com/lego"},
                    {"text":"Book","url":null},
                    {"text":"Kite","url":"http://example.com/kite"}]'),
                'LIST-02 a valid list saves');
select pg_temp.as_postgres();
select is((select array[fav_color, fav_snack, sizes, please_no] from public.members where id = pg_temp.id('Ava')),
          array['teal', 'popcorn', 'shirt M', null], 'LIST-02 About me is stored, trimmed');
select is(pg_temp.items_of('Ava'), array['Lego', 'Book', 'Kite'], 'LIST-02 items are stored in order, text trimmed');
select is((select array_agg(position order by position) from public.wish_items where member_id = pg_temp.id('Ava')),
          array[0, 1, 2], 'LIST-02 position is the array index, starting at 0');
select is((select array_agg(url order by position) from public.wish_items where member_id = pg_temp.id('Ava')),
          array['https://example.com/lego', null, 'http://example.com/kite'], 'LIST-02 links are stored');

-- LIST-03 / 04 replace and clear ----------------------------------------------
select pg_temp.act_as_anon();
select lives_ok(pg_temp.save_sql('Ava', '{"fav_color":"teal"}', pg_temp.one_item('Bike')), 'LIST-03 a second save works');
select pg_temp.as_postgres();
select is(pg_temp.items_of('Ava'), array['Bike'], 'LIST-03 saving replaces the whole list');
select pg_temp.act_as_anon();
select lives_ok(pg_temp.save_sql('Ava', '{"fav_color":null,"fav_snack":null,"sizes":null,"please_no":null}', '[]'),
                'LIST-04 saving an empty list works');
select pg_temp.as_postgres();
select is(pg_temp.items_of('Ava'), null::text[], 'LIST-04 an empty item array clears the list');
select is((select array[fav_color, fav_snack, sizes, please_no] from public.members where id = pg_temp.id('Ava')),
          array[null, null, null, null]::text[], 'LIST-04 null About me fields clear them');

-- LIST-05 at most 10 items ----------------------------------------------------
select pg_temp.act_as_anon();
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.n_items(10)), 'LIST-05 10 items are accepted');
select pg_temp.as_postgres();
select is(cardinality(pg_temp.items_of('Ava')), 10, 'LIST-05 ... and all 10 are stored');
select pg_temp.act_as_anon();
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.n_items(11)), 'invalid list: _%', 'LIST-05 11 items are rejected');

-- LIST-06 item text -----------------------------------------------------------
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('')), 'invalid list: _%',
                   'LIST-06 empty item text is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('    ')), 'invalid list: _%',
                   'LIST-06 whitespace-only item text is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', '[{"url":"https://example.com"}]'), 'invalid list: _%',
                   'LIST-06 an item with no text is rejected');
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item(repeat('x', 200))), 'LIST-06 200-character item text is accepted');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item(repeat('x', 201))), 'invalid list: _%',
                   'LIST-06 201-character item text is rejected');

-- LIST-07 links ---------------------------------------------------------------
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', null)), 'LIST-07 no link is accepted');
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'http://example.com/a')), 'LIST-07 an http link is accepted');
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'https://example.com/a?b=c#d')), 'LIST-07 an https link is accepted');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'javascript:alert(1)')), 'invalid list: _%',
                   'LIST-07 a javascript: link is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'JavaScript:alert(1)')), 'invalid list: _%',
                   'LIST-07 a JavaScript: link (mixed case) is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', ' javascript:alert(1)')), 'invalid list: _%',
                   'LIST-07 a javascript: link with a leading space is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'data:text/html,<script>alert(1)</script>')),
                   'invalid list: _%', 'LIST-07 a data: link is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'vbscript:msgbox(1)')), 'invalid list: _%',
                   'LIST-07 a vbscript: link is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'ftp://example.com/a')), 'invalid list: _%',
                   'LIST-07 an ftp: link is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', '//example.com/a')), 'invalid list: _%',
                   'LIST-07 a protocol-relative link is rejected');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'example.com/a')), 'invalid list: _%',
                   'LIST-07 a link with no scheme is rejected');

-- LIST-08 link length ---------------------------------------------------------
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'https://example.com/' || repeat('a', 480))),
                'LIST-08 a 500-character link is accepted');
select throws_like(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Lego', 'https://example.com/' || repeat('a', 481))),
                   'invalid list: _%', 'LIST-08 a 501-character link is rejected');

-- LIST-09 About me length -----------------------------------------------------
select lives_ok(pg_temp.save_sql('Ava',
                  jsonb_build_object('fav_color', repeat('c', 200), 'fav_snack', repeat('s', 200),
                                     'sizes', repeat('z', 200), 'please_no', repeat('n', 200))::text, '[]'),
                'LIST-09 200 characters in every About me field is accepted');
select throws_like(pg_temp.save_sql('Ava', jsonb_build_object('fav_color', repeat('c', 201))::text, '[]'),
                   'invalid list: _%', 'LIST-09 a 201-character favorite color is rejected');
select throws_like(pg_temp.save_sql('Ava', jsonb_build_object('fav_snack', repeat('s', 201))::text, '[]'),
                   'invalid list: _%', 'LIST-09 a 201-character favorite snack is rejected');
select throws_like(pg_temp.save_sql('Ava', jsonb_build_object('sizes', repeat('z', 201))::text, '[]'),
                   'invalid list: _%', 'LIST-09 a 201-character sizes field is rejected');
select throws_like(pg_temp.save_sql('Ava', jsonb_build_object('please_no', repeat('n', 201))::text, '[]'),
                   'invalid list: _%', 'LIST-09 a 201-character please-no field is rejected');

-- LIST-10 a rejected save changes nothing -------------------------------------
select lives_ok(pg_temp.save_sql('Ava', '{"fav_color":"teal"}', '[{"text":"Lego","url":null},{"text":"Book","url":null}]'),
                'LIST-10 setup: a known good list');
select pg_temp.try(pg_temp.save_sql('Ava', '{"fav_color":"orange"}', pg_temp.n_items(11)));
select pg_temp.try(pg_temp.save_sql('Ava', '{"fav_color":"orange"}',
                   '[{"text":"Swapped","url":null},{"text":"Bad","url":"javascript:alert(1)"}]'));
select pg_temp.as_postgres();
select is((select fav_color from public.members where id = pg_temp.id('Ava')) || '|' || array_to_string(pg_temp.items_of('Ava'), ','),
          'teal|Lego,Book', 'LIST-10 rejected saves leave the list and About me exactly as they were');

-- LIST-11 only the caller's list ----------------------------------------------
select is((select fav_color from public.members where id = pg_temp.id('Ben')) || '|' || array_to_string(pg_temp.items_of('Ben'), ','),
          'red|Ben''s own wish', 'LIST-11 none of those saves touched another member''s list');

-- DONE-01 / 02 set_list_done --------------------------------------------------
select pg_temp.act_as_anon();
select throws_ok($$select public.set_list_done('nope', true)$$, null, 'link not found',
                 'DONE-01 an unknown token gets link not found');
select lives_ok(format('select public.set_list_done(%L, true)', pg_temp.tok('Cy')), 'DONE-02 I''m done works');
select pg_temp.as_postgres();
select is((select array_agg(list_done order by first_name) from public.members where circle_id = pg_temp.id('L')),
          array[true, true, true], 'DONE-02 set_list_done(true) marks the caller''s list done');
select pg_temp.act_as_anon();
select lives_ok(format('select public.set_list_done(%L, false)', pg_temp.tok('Cy')), 'DONE-02 un-done works');
select pg_temp.as_postgres();
select is((select array_agg(list_done order by first_name) from public.members where circle_id = pg_temp.id('L')),
          array[true, true, false], 'DONE-02 set_list_done(false) clears only the caller''s flag');
update public.members set list_done = true where circle_id = pg_temp.id('L');

-- LIST-12 lists stay editable after the draw ----------------------------------
select pg_temp.act_as('elf');
select lives_ok($$select public.start_draw(pg_temp.id('L'))$$, 'LIST-12 setup: the Elf draws');
select pg_temp.act_as_anon();
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Drawn-time idea')), 'LIST-12 saving works while drawn');
select pg_temp.as_postgres();
select pg_temp.mark_sent('L');
select pg_temp.act_as_anon();
select lives_ok(pg_temp.save_sql('Ava', '{}', pg_temp.one_item('Sent-time idea')), 'LIST-12 saving works after sent');
select pg_temp.as_postgres();
select is(pg_temp.items_of('Ava'), array['Sent-time idea'], 'LIST-12 ... and the change is stored');

select * from finish();
rollback;
