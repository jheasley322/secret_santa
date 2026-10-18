-- ===========================================================================
-- 01 -- Function contract and grants
-- ===========================================================================
-- Spec: "Interface contract" (names, argument names, return types, grants),
-- "Access rules -> Member" (SECURITY DEFINER, search_path set explicitly).
-- Scenarios FN-01..10 in tests/SCENARIOS.md.
--
-- Argument NAMES are checked, not just types: PostgREST calls RPCs with named
-- JSON arguments, so a renamed parameter breaks every page that calls it.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(37);

-- FN-01..05: existence, return type, argument names --------------------------
select has_function('public', 'member_view',      array['text'],                   'FN-01 member_view(text) exists');
select function_returns('public', 'member_view',  array['text'], 'jsonb',          'FN-01 member_view returns jsonb');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.member_view(text)')),
          array['p_token'], 'FN-01 member_view argument is named p_token');

select has_function('public', 'save_my_list',     array['text','jsonb','jsonb'],   'FN-02 save_my_list(text, jsonb, jsonb) exists');
select function_returns('public', 'save_my_list', array['text','jsonb','jsonb'], 'void', 'FN-02 save_my_list returns void');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.save_my_list(text,jsonb,jsonb)')),
          array['p_token','p_about','p_items'], 'FN-02 save_my_list arguments are p_token, p_about, p_items');

select has_function('public', 'set_list_done',    array['text','boolean'],         'FN-03 set_list_done(text, boolean) exists');
select function_returns('public', 'set_list_done', array['text','boolean'], 'void', 'FN-03 set_list_done returns void');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.set_list_done(text,boolean)')),
          array['p_token','p_done'], 'FN-03 set_list_done arguments are p_token, p_done');

select has_function('public', 'start_draw',       array['uuid'],                   'FN-04 start_draw(uuid) exists');
select function_returns('public', 'start_draw',   array['uuid'], 'void',           'FN-04 start_draw returns void');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.start_draw(uuid)')),
          array['p_circle_id'], 'FN-04 start_draw argument is named p_circle_id');

select has_function('public', 'reshuffle',        array['uuid'],                   'FN-04 reshuffle(uuid) exists');
select function_returns('public', 'reshuffle',    array['uuid'], 'void',           'FN-04 reshuffle returns void');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.reshuffle(uuid)')),
          array['p_circle_id'], 'FN-04 reshuffle argument is named p_circle_id');

select has_function('public', 'undo_draw',        array['uuid'],                   'FN-04 undo_draw(uuid) exists');
select function_returns('public', 'undo_draw',    array['uuid'], 'void',           'FN-04 undo_draw returns void');
select is((select proargnames::text[] from pg_proc where oid = to_regprocedure('public.undo_draw(uuid)')),
          array['p_circle_id'], 'FN-04 undo_draw argument is named p_circle_id');

select has_function('public', 'erase_old_phones', '{}'::name[],                    'FN-05 erase_old_phones() exists');
select function_returns('public', 'erase_old_phones', '{}'::name[], 'integer',     'FN-05 erase_old_phones returns int');

-- FN-06: member RPCs are SECURITY DEFINER -------------------------------------
select is_definer('public', 'member_view',   array['text'],                 'FN-06 member_view is SECURITY DEFINER');
select is_definer('public', 'save_my_list',  array['text','jsonb','jsonb'], 'FN-06 save_my_list is SECURITY DEFINER');
select is_definer('public', 'set_list_done', array['text','boolean'],       'FN-06 set_list_done is SECURITY DEFINER');

-- FN-07: search_path pinned ---------------------------------------------------
select ok(coalesce((select exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
                      from pg_proc where oid = to_regprocedure('public.member_view(text)')), false),
          'FN-07 member_view sets search_path');
select ok(coalesce((select exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
                      from pg_proc where oid = to_regprocedure('public.save_my_list(text,jsonb,jsonb)')), false),
          'FN-07 save_my_list sets search_path');
select ok(coalesce((select exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
                      from pg_proc where oid = to_regprocedure('public.set_list_done(text,boolean)')), false),
          'FN-07 set_list_done sets search_path');
select is(
  array(select p.oid::regprocedure::text
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
           and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
         order by 1),
  '{}'::text[], 'FN-07 every SECURITY DEFINER function in public sets search_path');

-- FN-08..10: who may execute what ----------------------------------------------
-- A missing function counts as a failure, never as "correctly not granted".
create function pg_temp.can_exec(p_role text, p_sig text) returns boolean
language plpgsql as $fx$
begin
  if to_regprocedure(p_sig) is null then
    return null;
  end if;
  return has_function_privilege(p_role, to_regprocedure(p_sig), 'execute');
end $fx$;

select is(pg_temp.can_exec('anon',          'public.member_view(text)'),                 true,  'FN-08 anon can execute member_view');
select is(pg_temp.can_exec('authenticated', 'public.member_view(text)'),                 true,  'FN-08 authenticated can execute member_view');
select is(pg_temp.can_exec('anon',          'public.save_my_list(text,jsonb,jsonb)'),    true,  'FN-08 anon can execute save_my_list');
select is(pg_temp.can_exec('authenticated', 'public.save_my_list(text,jsonb,jsonb)'),    true,  'FN-08 authenticated can execute save_my_list');
select is(pg_temp.can_exec('anon',          'public.set_list_done(text,boolean)'),       true,  'FN-08 anon can execute set_list_done');
select is(pg_temp.can_exec('authenticated', 'public.set_list_done(text,boolean)'),       true,  'FN-08 authenticated can execute set_list_done');

select is(
  array[pg_temp.can_exec('authenticated', 'public.start_draw(uuid)'),
        pg_temp.can_exec('authenticated', 'public.reshuffle(uuid)'),
        pg_temp.can_exec('authenticated', 'public.undo_draw(uuid)')],
  array[true, true, true], 'FN-09 authenticated can execute start_draw, reshuffle, undo_draw');
select is(
  array[pg_temp.can_exec('anon', 'public.start_draw(uuid)'),
        pg_temp.can_exec('anon', 'public.reshuffle(uuid)'),
        pg_temp.can_exec('anon', 'public.undo_draw(uuid)')],
  array[false, false, false], 'FN-09 anon cannot execute start_draw, reshuffle, undo_draw');

select is(pg_temp.can_exec('anon',          'public.erase_old_phones()'), false, 'FN-10 anon cannot execute erase_old_phones');
select is(pg_temp.can_exec('authenticated', 'public.erase_old_phones()'), false, 'FN-10 authenticated cannot execute erase_old_phones');

select * from finish();
rollback;
