-- Phase 1, migration 4: the member (kid) RPCs.
--
-- spec "Access rules -> Member": no table access; everything through SECURITY
-- DEFINER functions that resolve the member by token. Unknown token -> one
-- generic 'link not found'. None of these is STRICT: a null token must get
-- 'link not found' too, not a silent null.
--
-- spec "Interface contract": <member> = id, first_name, fav_color, fav_snack,
-- sizes, please_no, list_done, items[text, url, position]. Never phone, token,
-- created_at, opened_at, no-pair data or anyone else's match.

-- ---------------------------------------------------------------------------
-- private.member_json(member id): the one place the <member> shape is built, so
-- the "never contains" list is enforced by construction (an allow-list of keys).
-- ---------------------------------------------------------------------------
create function private.member_json(p_member_id uuid) returns jsonb
language sql stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
           'id',         m.id,
           'first_name', m.first_name,
           'fav_color',  m.fav_color,
           'fav_snack',  m.fav_snack,
           'sizes',      m.sizes,
           'please_no',  m.please_no,
           'list_done',  m.list_done,
           'items', coalesce(
              (select pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object('text', w.text, 'url', w.url, 'position', w.position)
                        order by w.position)
                 from public.wish_items w
                where w.member_id = m.id),
              '[]'::jsonb))
    from public.members m
   where m.id = p_member_id;
$$;

-- ---------------------------------------------------------------------------
-- member_view(p_token)
-- ---------------------------------------------------------------------------
create function public.member_view(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_circle    public.circles%rowtype;
  v_receiver  uuid;
begin
  -- Authorization first: the token is the member's only credential.
  select m.id into v_member_id from public.members m where m.token = p_token;
  if v_member_id is null then
    raise exception 'link not found';
  end if;

  select c.* into v_circle
    from public.circles c join public.members m on m.circle_id = c.id
   where m.id = v_member_id;

  -- spec "Circle status": members see their match only once the circle is sent,
  -- and only their own (spec "Privacy rules" 2).
  if v_circle.status = 'sent' then
    select mt.receiver_id into v_receiver from public.matches mt where mt.giver_id = v_member_id;
    if v_receiver is not null then
      -- spec "member_view": opened_at is set the first time the match is returned.
      update public.matches set opened_at = now()
       where giver_id = v_member_id and opened_at is null;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'circle', pg_catalog.jsonb_build_object(
                'name',       v_circle.name,
                'budget',     v_circle.budget,
                'swap_date',  v_circle.swap_date,
                'swap_place', v_circle.swap_place,
                'status',     v_circle.status),
    'me', private.member_json(v_member_id),
    -- spec "Privacy rules" 1: wish lists are public within the circle.
    'members', coalesce(
       (select pg_catalog.jsonb_agg(private.member_json(m.id)
                                    order by pg_catalog.lower(m.first_name), m.first_name, m.id)
          from public.members m
         where m.circle_id = v_circle.id),
       '[]'::jsonb),
    'match', case when v_receiver is null then 'null'::jsonb
                  else private.member_json(v_receiver) end);
end $$;

-- ---------------------------------------------------------------------------
-- save_my_list(p_token, p_about, p_items)
-- ---------------------------------------------------------------------------
-- spec "Interface contract": about fields nullable, trimmed, <= 200 chars; <= 10
-- items, text trimmed 1-200, url null or http(s) <= 500; replaces all items;
-- position = array index (from 0); allowed in every circle status ("Lists stay
-- editable after the draw"). Everything is validated before anything is written,
-- and the function is one statement, so a rejected save changes nothing.
create function public.save_my_list(p_token text, p_about jsonb, p_items jsonb) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_about     jsonb := coalesce(p_about, '{}'::jsonb);
  v_items     jsonb := coalesce(p_items, '[]'::jsonb);
  v_field     text;
  v_value     text;
  v_clean     jsonb := '{}'::jsonb;
  v_item      jsonb;
  v_text      text;
  v_url       text;
  v_rows      jsonb := '[]'::jsonb;
begin
  -- Authorization first. FOR UPDATE serialises two saves from the same kid.
  select m.id into v_member_id from public.members m where m.token = p_token for update;
  if v_member_id is null then
    raise exception 'link not found';
  end if;

  -- About me ---------------------------------------------------------------
  if pg_catalog.jsonb_typeof(v_about) <> 'object' then
    raise exception 'invalid list: about me must be an object';
  end if;
  foreach v_field in array array['fav_color', 'fav_snack', 'sizes', 'please_no'] loop
    if pg_catalog.jsonb_typeof(v_about -> v_field) not in ('string', 'null') then
      raise exception 'invalid list: % must be text', v_field;
    end if;
    v_value := private.tidy(v_about ->> v_field);
    if pg_catalog.char_length(v_value) > 200 then
      raise exception 'invalid list: % is longer than 200 characters', v_field;
    end if;
    v_clean := v_clean || pg_catalog.jsonb_build_object(v_field, v_value);
  end loop;

  -- Items -------------------------------------------------------------------
  if pg_catalog.jsonb_typeof(v_items) <> 'array' then
    raise exception 'invalid list: items must be a list';
  end if;
  if pg_catalog.jsonb_array_length(v_items) > 10 then
    raise exception 'invalid list: at most 10 wishes';
  end if;
  for v_item in select e from pg_catalog.jsonb_array_elements(v_items) e loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid list: each wish must be an object';
    end if;
    if pg_catalog.jsonb_typeof(v_item -> 'text') is distinct from 'string' then
      raise exception 'invalid list: each wish needs some text';
    end if;
    v_text := private.tidy(v_item ->> 'text');
    if v_text is null then
      raise exception 'invalid list: each wish needs some text';
    end if;
    if pg_catalog.char_length(v_text) > 200 then
      raise exception 'invalid list: a wish is longer than 200 characters';
    end if;

    if pg_catalog.jsonb_typeof(v_item -> 'url') not in ('string', 'null') then
      raise exception 'invalid list: a link must be text';
    end if;
    v_url := private.tidy(v_item ->> 'url');
    if v_url is not null then
      if pg_catalog.char_length(v_url) > 500 then
        raise exception 'invalid list: a link is longer than 500 characters';
      end if;
      -- spec "Stack": wish links open in a new tab, so only http(s) is allowed.
      -- Same rule as the wish_items.url check constraint.
      if v_url !~* '^https?://[^[:space:]/?#]+[^[:space:]]*$' then
        raise exception 'invalid list: links must start with http:// or https://';
      end if;
    end if;

    v_rows := v_rows || pg_catalog.jsonb_build_array(
                          pg_catalog.jsonb_build_object('text', v_text, 'url', v_url));
  end loop;

  -- Write --------------------------------------------------------------------
  update public.members
     set fav_color = v_clean ->> 'fav_color',
         fav_snack = v_clean ->> 'fav_snack',
         sizes     = v_clean ->> 'sizes',
         please_no = v_clean ->> 'please_no'
   where id = v_member_id;

  delete from public.wish_items where member_id = v_member_id;

  insert into public.wish_items (member_id, text, url, position)
  select v_member_id, r.e ->> 'text', r.e ->> 'url', (r.ord - 1)::integer
    from pg_catalog.jsonb_array_elements(v_rows) with ordinality as r(e, ord);
end $$;

-- ---------------------------------------------------------------------------
-- set_list_done(p_token, p_done)
-- ---------------------------------------------------------------------------
create function public.set_list_done(p_token text, p_done boolean) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  -- Authorization first.
  select m.id into v_member_id from public.members m where m.token = p_token;
  if v_member_id is null then
    raise exception 'link not found';
  end if;
  if p_done is null then
    raise exception 'invalid list: done must be true or false';
  end if;

  update public.members set list_done = p_done where id = v_member_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
revoke all on function private.member_json(uuid)                  from public, anon, authenticated;
revoke all on function public.member_view(text)                   from public, anon, authenticated;
revoke all on function public.save_my_list(text, jsonb, jsonb)    from public, anon, authenticated;
revoke all on function public.set_list_done(text, boolean)        from public, anon, authenticated;

-- Member RPCs: a kid's browser is anon; an Elf previewing a link is authenticated.
grant execute on function public.member_view(text)                to anon, authenticated;
grant execute on function public.save_my_list(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.set_list_done(text, boolean)     to anon, authenticated;
