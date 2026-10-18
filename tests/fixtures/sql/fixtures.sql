-- ===========================================================================
-- Shared pgTAP fixtures for the Secret Santa suite
-- ===========================================================================
--
-- Pulled into a test file with
--
--     -- \include tests/fixtures/sql/fixtures.sql
--
-- The runner (tests/tools/run-pgtap.mjs) owns the transaction and always rolls
-- it back, so everything created here (auth.users rows, circles, members, temp
-- tables, temp helper functions) is gone when the file finishes.
--
-- Rules:
--   * Tests build their own fixtures. Nothing here reads an existing row.
--   * Every Elf email ends in @secret-santa-pgtap.invalid and every circle name
--     starts with "pgtap:", so a fixture row can never be mistaken for real data.
--   * Phones are fictional: +1 555 555-01xx.
--   * Fixtures are referred to by short label ('elf_a', 'Ava', 'C1'), never by
--     uuid, so assertions read like the spec.
--
-- Roles (what PostgREST does for each kind of caller):
--   pg_temp.act_as('elf_a')    database role `authenticated` + JWT sub claim
--   pg_temp.act_as_anon()      database role `anon`, no subject (a kid's browser)
--   pg_temp.act_as_service()   database role `service_role` (the Edge Function)
--   pg_temp.as_postgres()      back to the privileged setup role
--
-- Helpers that touch app tables are plpgsql on purpose: plpgsql bodies are not
-- resolved until they run, so this file loads even before the schema exists.
-- ===========================================================================

set local search_path = public, extensions;

-- --------------------------------------------------------------------------
-- Label registry
-- --------------------------------------------------------------------------
create temporary table t_id (
  label text primary key,
  id    uuid not null
);
create temporary table t_tok (
  label text primary key,
  token text not null
);
-- Results captured while acting as another role, inspected later as postgres.
create temporary table t_view (
  label text primary key,
  v     jsonb
);
-- One row per draw collected by pg_temp.collect_draws().
create temporary table t_draws (
  tag     text not null,
  run     int  not null,
  sig     text,
  verdict text,
  mutual  boolean
);
create temporary table t_val (
  label text primary key,
  v     text
);
create temporary sequence s_phone;

-- act_as() switches away from postgres; every role must still reach these.
grant select on t_id, t_tok to public;
grant all on t_view, t_draws, t_val to public;
grant usage on sequence s_phone to public;

create function pg_temp.id(p_label text) returns uuid
language sql stable as $fx$
  select id from pg_temp.t_id where label = p_label;
$fx$;

create function pg_temp.label(p_id uuid) returns text
language sql stable as $fx$
  select label from pg_temp.t_id where id = p_id;
$fx$;

create function pg_temp.tok(p_label text) returns text
language sql stable as $fx$
  select token from pg_temp.t_tok where label = p_label;
$fx$;

create function pg_temp.remember(p_label text, p_id uuid) returns uuid
language plpgsql as $fx$
begin
  insert into pg_temp.t_id (label, id) values (p_label, p_id)
    on conflict (label) do update set id = excluded.id;
  return p_id;
end $fx$;

create function pg_temp.val(p_label text) returns text
language sql stable as $fx$
  select v from pg_temp.t_val where label = p_label;
$fx$;

create function pg_temp.keep(p_label text, p_v text) returns void
language plpgsql as $fx$
begin
  insert into pg_temp.t_val (label, v) values (p_label, p_v)
    on conflict (label) do update set v = excluded.v;
end $fx$;

-- A fictional US number: +1 555 555-01xx.
create function pg_temp.fake_phone() returns text
language plpgsql as $fx$
begin
  return '+155555501' || lpad((nextval('pg_temp.s_phone') % 100)::text, 2, '0');
end $fx$;

-- --------------------------------------------------------------------------
-- Role switching. Effects last until the end of the transaction or the next
-- switch. Each switch resets first, because anon is not a member of
-- authenticated and could not otherwise switch straight across.
-- --------------------------------------------------------------------------
create function pg_temp.as_postgres() returns void
language plpgsql as $fx$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $fx$;

create function pg_temp.act_as(p_label text) returns void
language plpgsql as $fx$
declare v uuid := pg_temp.id(p_label);
begin
  if v is null then
    raise exception 'act_as(%): no such fixture label', p_label;
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claims',
    json_build_object('sub', v, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v::text, true);
  execute 'set local role authenticated';
end $fx$;

create function pg_temp.act_as_anon() returns void
language plpgsql as $fx$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $fx$;

create function pg_temp.act_as_service() returns void
language plpgsql as $fx$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
end $fx$;

-- --------------------------------------------------------------------------
-- Factories. Call these as postgres (the setup role).
-- --------------------------------------------------------------------------

-- An Elf is just a Supabase Auth user.
create function pg_temp.mk_elf(p_label text) returns uuid
language plpgsql as $fx$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role)
  values (v, p_label || '@secret-santa-pgtap.invalid', 'authenticated', 'authenticated');
  return pg_temp.remember(p_label, v);
end $fx$;

create function pg_temp.mk_circle(
  p_label     text,
  p_elf_label text,
  p_swap_date date default (current_date + 30),
  p_budget    int  default 20,
  p_place     text default 'pgtap house'
) returns uuid
language plpgsql as $fx$
declare v uuid;
begin
  insert into public.circles (elf_id, name, budget, swap_date, swap_place)
  values (pg_temp.id(p_elf_label), 'pgtap:' || p_label, p_budget, p_swap_date, p_place)
  returning id into v;
  return pg_temp.remember(p_label, v);
end $fx$;

-- One member. The label doubles as the first name unless one is given.
-- Lists default to done, because most tests want a drawable circle.
create function pg_temp.mk_member(
  p_label        text,
  p_circle_label text,
  p_first_name   text    default null,
  p_done         boolean default true,
  p_phone        text    default 'auto'
) returns uuid
language plpgsql as $fx$
declare
  v uuid;
  t text;
begin
  insert into public.members (circle_id, first_name, phone, list_done)
  values (pg_temp.id(p_circle_label),
          coalesce(p_first_name, p_label),
          case when p_phone = 'auto' then pg_temp.fake_phone() else p_phone end,
          p_done)
  returning id, token into v, t;
  insert into pg_temp.t_tok (label, token) values (p_label, t)
    on conflict (label) do update set token = excluded.token;
  return pg_temp.remember(p_label, v);
end $fx$;

-- Several members at once, labels = first names, all lists done.
create function pg_temp.mk_members(p_circle_label text, variadic p_labels text[]) returns void
language plpgsql as $fx$
declare l text;
begin
  foreach l in array p_labels loop
    perform pg_temp.mk_member(l, p_circle_label);
  end loop;
end $fx$;

-- A no-pair, stored the way the spec requires (member_a < member_b).
create function pg_temp.mk_no_pair(p_circle_label text, p_a text, p_b text) returns void
language plpgsql as $fx$
begin
  insert into public.no_pairs (circle_id, member_a, member_b)
  values (pg_temp.id(p_circle_label),
          least(pg_temp.id(p_a), pg_temp.id(p_b)),
          greatest(pg_temp.id(p_a), pg_temp.id(p_b)));
end $fx$;

create function pg_temp.mk_item(p_member_label text, p_text text, p_position int, p_url text default null)
returns void
language plpgsql as $fx$
begin
  insert into public.wish_items (member_id, text, url, position)
  values (pg_temp.id(p_member_label), p_text, p_url, p_position);
end $fx$;

-- Matches written directly, for tests about access rather than about the draw.
-- p_pairs is giver,receiver,giver,receiver,... by label.
create function pg_temp.mk_matches(p_circle_label text, variadic p_pairs text[]) returns void
language plpgsql as $fx$
declare i int := 1;
begin
  while i < array_length(p_pairs, 1) loop
    insert into public.matches (circle_id, giver_id, receiver_id)
    values (pg_temp.id(p_circle_label), pg_temp.id(p_pairs[i]), pg_temp.id(p_pairs[i + 1]));
    i := i + 2;
  end loop;
end $fx$;

create function pg_temp.mk_text(p_member_label text, p_kind text, p_status text default 'sent')
returns void
language plpgsql as $fx$
begin
  insert into public.texts (member_id, kind, status, created_at)
  values (pg_temp.id(p_member_label), p_kind, p_status, now());
end $fx$;

-- Setup-role status change, for tests about something other than how the
-- status got there. Status *transitions* are tested through the RPCs and the
-- service role in 32_status_and_locks.sql.
create function pg_temp.set_status(p_circle_label text, p_status text) returns void
language plpgsql as $fx$
begin
  update public.circles set status = p_status where id = pg_temp.id(p_circle_label);
end $fx$;

-- What the Edge Function does on "Send the names": service role, drawn -> sent.
-- Leaves the session as postgres.
create function pg_temp.mark_sent(p_circle_label text) returns void
language plpgsql as $fx$
begin
  perform pg_temp.act_as_service();
  update public.circles set status = 'sent' where id = pg_temp.id(p_circle_label);
  perform pg_temp.as_postgres();
end $fx$;

-- --------------------------------------------------------------------------
-- Observers. Call as postgres.
-- --------------------------------------------------------------------------

-- Run a statement as the current role; report 'succeeded' or the error, never
-- raise. Used for "not client-writable" checks, where the spec fixes the
-- outcome (the value doesn't change) but not whether the attempt errors or is
-- ignored. (Not 'ok': a bare top-level `select pg_temp.try(...)` returning
-- 'ok' would be read by the runner as a passing TAP line.)
create function pg_temp.try(p_sql text) returns text
language plpgsql as $fx$
begin
  execute p_sql;
  return 'succeeded';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $fx$;

-- Run a statement, ALWAYS undo it, and classify what happened:
--   'accepted'   it ran without error
--   'rejected'   a data / integrity / raised-exception error (SQLSTATE class 22,
--                class 23, or P0001), i.e. a constraint or trigger said no
--   'error ...'  anything else (missing table, permission denied, typo)
-- The third bucket matters: before the schema exists, "relation does not
-- exist" must never pass as "correctly rejected".
create function pg_temp.outcome(p_sql text) returns text
language plpgsql as $fx$
begin
  execute p_sql;
  raise exception using errcode = 'PGT01', message = 'pgtap: undo';
exception when others then
  if sqlstate = 'PGT01' then
    return 'accepted';
  end if;
  if left(sqlstate, 2) in ('22', '23') or sqlstate = 'P0001' then
    return 'rejected';
  end if;
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $fx$;

create function pg_temp.circle_status(p_circle_label text) returns text
language plpgsql as $fx$
declare v text;
begin
  select status into v from public.circles where id = pg_temp.id(p_circle_label);
  return v;
end $fx$;

create function pg_temp.match_count(p_circle_label text) returns bigint
language plpgsql as $fx$
declare v bigint;
begin
  select count(*) into v from public.matches where circle_id = pg_temp.id(p_circle_label);
  return v;
end $fx$;

-- The current draw as text, e.g. 'Ava>Ben,Ben>Cy,Cy>Ava', sorted by giver label.
create function pg_temp.draw_sig(p_circle_label text) returns text
language plpgsql as $fx$
declare v text;
begin
  select string_agg(pg_temp.label(giver_id) || '>' || pg_temp.label(receiver_id), ','
                    order by pg_temp.label(giver_id))
    into v
    from public.matches
   where circle_id = pg_temp.id(p_circle_label);
  return v;
end $fx$;

-- 'ok' if the circle's matches are a valid draw under the spec's Draw rules,
-- otherwise the first rule broken.
create function pg_temp.draw_verdict(p_circle_label text) returns text
language plpgsql as $fx$
declare
  c uuid := pg_temp.id(p_circle_label);
  n_members bigint;
begin
  select count(*) into n_members from public.members where circle_id = c;

  if (select count(*) from public.matches where circle_id = c) <> n_members then
    return 'match count differs from member count';
  end if;
  if exists (select 1 from public.matches where circle_id = c and giver_id = receiver_id) then
    return 'somebody drew themselves';
  end if;
  if (select count(distinct giver_id) from public.matches where circle_id = c) <> n_members then
    return 'not every member gives exactly once';
  end if;
  if (select count(distinct receiver_id) from public.matches where circle_id = c) <> n_members then
    return 'not every member receives exactly once';
  end if;
  if exists (select 1 from public.matches mt
              where mt.circle_id = c
                and (   not exists (select 1 from public.members m where m.id = mt.giver_id and m.circle_id = c)
                     or not exists (select 1 from public.members m where m.id = mt.receiver_id and m.circle_id = c))) then
    return 'a match names someone outside the circle';
  end if;
  if exists (select 1 from public.matches mt
               join public.no_pairs np on np.circle_id = c
              where mt.circle_id = c
                and (   (mt.giver_id = np.member_a and mt.receiver_id = np.member_b)
                     or (mt.giver_id = np.member_b and mt.receiver_id = np.member_a))) then
    return 'a do-not-pair rule is broken';
  end if;
  return 'ok';
end $fx$;

-- Does any pair draw each other (A->B and B->A)?
create function pg_temp.has_mutual(p_circle_label text) returns boolean
language plpgsql as $fx$
declare c uuid := pg_temp.id(p_circle_label);
begin
  return exists (select 1 from public.matches x
                   join public.matches y on y.circle_id = c
                                        and y.giver_id = x.receiver_id
                                        and y.receiver_id = x.giver_id
                  where x.circle_id = c);
end $fx$;

-- Draw p_runs times as the Elf and record each result.
--   p_how = 'reshuffle'  : reshuffle() each time (circle must already be drawn)
--   p_how = 'redraw'     : undo_draw() then start_draw() each time
-- Leaves the session as postgres.
create function pg_temp.collect_draws(p_tag text, p_elf text, p_circle text, p_runs int, p_how text)
returns void
language plpgsql as $fx$
declare c uuid := pg_temp.id(p_circle);
begin
  for i in 1 .. p_runs loop
    perform pg_temp.act_as(p_elf);
    if p_how = 'reshuffle' then
      perform public.reshuffle(c);
    else
      perform public.undo_draw(c);
      perform public.start_draw(c);
    end if;
    perform pg_temp.as_postgres();
    insert into pg_temp.t_draws (tag, run, sig, verdict, mutual)
    values (p_tag, i, pg_temp.draw_sig(p_circle), pg_temp.draw_verdict(p_circle),
            pg_temp.has_mutual(p_circle));
  end loop;
end $fx$;

-- member_view() as anon for one member, captured into t_view under p_key.
-- Leaves the session as postgres.
create function pg_temp.capture_view(p_key text, p_member_label text) returns void
language plpgsql as $fx$
declare v jsonb;
begin
  perform pg_temp.act_as_anon();
  v := public.member_view(pg_temp.tok(p_member_label));
  perform pg_temp.as_postgres();
  insert into pg_temp.t_view (label, v) values (p_key, v)
    on conflict (label) do update set v = excluded.v;
end $fx$;

create function pg_temp.view(p_key text) returns jsonb
language sql stable as $fx$
  select v from pg_temp.t_view where label = p_key;
$fx$;

-- Sorted key list of a json object, for exact-shape checks.
create function pg_temp.keys(p jsonb) returns text[]
language sql immutable as $fx$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) k;
$fx$;
