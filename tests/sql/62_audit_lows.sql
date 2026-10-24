-- ===========================================================================
-- 62 -- Re-audit Lows (security-auditor, 2026-10-24)
-- ===========================================================================
-- Written by backend-engineer as an agreed exception to the test-first split;
-- test-author to review. Pins supabase/migrations/20261024150000_audit_lows.sql:
--   finding 1  no client-executable function calls pg_net (the net grants
--              themselves belong to supabase_admin and can't be revoked)
--   finding 2  private.sweep_pending_texts(): pending > 10 min -> failed / 'timed out',
--              scheduled every 10 minutes, and claim_texts sweeps its circle first
--   finding 3  US only: Canadian and Caribbean NANP area codes are rejected
--   finding 4  the reserve is spent atomically at claim time; record_text_quota
--              never raises last_quota
--   finding 6a members_tidy never changes phone (the phone guard fires before it)
-- Spec: "Texting -> HARD LIMITS", "Security hardening" S1-S3.

begin;
-- \include tests/fixtures/sql/fixtures.sql

select plan(35);

-- --------------------------------------------------------------- helpers
create function pg_temp.svc(p_sql text) returns text
language plpgsql as $fx$
declare v text;
begin
  perform pg_temp.act_as_service();
  begin
    execute p_sql into v;
  exception when others then
    v := 'error ' || sqlstate || ': ' || sqlerrm;
  end;
  perform pg_temp.as_postgres();
  return coalesce(v, 'null');
end $fx$;

create function pg_temp.claim(p_circle text, p_n int) returns text
language plpgsql as $fx$
begin
  return pg_temp.svc(format('select public.claim_text_credits(p_circle_id => %L::uuid, p_n => %s)::text',
                            pg_temp.id(p_circle), p_n));
end $fx$;

create function pg_temp.quota(p_q int) returns text
language plpgsql as $fx$
begin
  return pg_temp.svc(format('select public.record_text_quota(p_quota => %s)::text', p_q));
end $fx$;

create function pg_temp.set_budget(p_cap int, p_used int, p_last_quota int) returns void
language plpgsql as $fx$
begin
  update private.text_budget set cap = p_cap, used = p_used, last_quota = p_last_quota;
end $fx$;

create function pg_temp.budget() returns text
language sql as $fx$
  select used || '/' || coalesce(last_quota::text, 'null') from private.text_budget;
$fx$;

-- A text row created p_minutes ago; its id is remembered under p_key.
create function pg_temp.old_text(p_key text, p_member text, p_status text, p_dry boolean, p_minutes int)
returns void
language plpgsql as $fx$
declare v uuid;
begin
  insert into public.texts (member_id, kind, status, dry_run, created_at)
  values (pg_temp.id(p_member), 'invite', p_status, p_dry, now() - make_interval(mins => p_minutes))
  returning id into v;
  perform pg_temp.remember(p_key, v);
end $fx$;

create function pg_temp.text_state(p_key text) returns text
language sql as $fx$
  select status || '|' || coalesce(error, '') from public.texts where id = pg_temp.id(p_key);
$fx$;

create function pg_temp.add_phone(p_circle text, p_phone text) returns text
language plpgsql as $fx$
begin
  return pg_temp.outcome(format(
    'insert into public.members (circle_id, first_name, phone) values (%L, %L, %L)',
    pg_temp.id(p_circle), 'Pat', p_phone));
end $fx$;

-- --------------------------------------------------------------- fixtures
select pg_temp.mk_elf('elf_a');
select pg_temp.mk_circle('CA', 'elf_a');
select pg_temp.mk_members('CA', 'Ava', 'Ben', 'Cy');
select pg_temp.mk_circle('CB', 'elf_a');
select pg_temp.mk_members('CB', 'Eve', 'Fay', 'Gus');
select pg_temp.set_budget(45, 0, null);

-- ======================================================= finding 2: sweep
select has_function('private', 'sweep_pending_texts', array['uuid'],
                    'AL-01 private.sweep_pending_texts(uuid) exists');
select is(array[has_function_privilege('anon',          'private.sweep_pending_texts(uuid)', 'execute'),
                has_function_privilege('authenticated', 'private.sweep_pending_texts(uuid)', 'execute'),
                has_function_privilege('service_role',  'private.sweep_pending_texts(uuid)', 'execute')],
          array[false, false, false], 'AL-02 no client role (service_role included) can execute the sweep');
select is((select schedule || '|' || command from cron.job where jobname = 'sweep-pending-texts'),
          '*/10 * * * *|select private.sweep_pending_texts()', 'AL-03 the sweep runs every 10 minutes via pg_cron');

select pg_temp.old_text('stale_ava',  'Ava', 'pending', false, 11);
select pg_temp.old_text('fresh_ben',  'Ben', 'pending', false, 9);
select pg_temp.old_text('old_sent_cy', 'Cy', 'sent',    false, 30);
select pg_temp.old_text('stale_eve',  'Eve', 'pending', true,  15);

-- claim_texts sweeps its own circle under the lock, before the checks.
select pg_temp.keep('ct', pg_temp.svc(format(
  'select public.claim_texts(p_circle_id => %L::uuid, p_kind => %L, p_member_ids => %L::uuid[],
                             p_dry_run => false, p_resend => false)::text',
  pg_temp.id('CA'), 'invite', array[pg_temp.id('Ava')])));
select is(pg_temp.text_state('stale_ava'), 'failed|timed out',
          'AL-04 claim_texts marks its circle''s 11-minute-old pending row failed / timed out');
select is((pg_temp.val('ct')::jsonb ->> 'ok') || '|' || jsonb_array_length(pg_temp.val('ct')::jsonb -> 'texts'),
          'true|1', 'AL-05 so a stale pending real invite no longer blocks Ava''s invite');
select is(pg_temp.text_state('stale_eve'), 'pending|',
          'AL-06 claim_texts sweeps only its own circle');
select is(pg_temp.text_state('fresh_ben'), 'pending|', 'AL-07 a 9-minute-old pending row is left alone');
select is(pg_temp.budget(), '1/null', 'AL-08 only the new claim is counted; the sweep never lowers used');

select is(private.sweep_pending_texts(), 1, 'AL-09 the cron form (no circle) sweeps every circle');
select is(pg_temp.text_state('stale_eve'), 'failed|timed out', 'AL-09 ... including dry-run rows');
select is(pg_temp.text_state('old_sent_cy'), 'sent|', 'AL-10 sent rows are never touched');
select is((select count(*) from public.texts t where t.member_id = pg_temp.id('Ava')
            and t.created_at > now() - interval '1 hour')::int, 2,
          'AL-11 a swept row still counts toward the 3-per-hour limit (it is not deleted)');

-- ======================================================= finding 4: reserve
select pg_temp.set_budget(45, 0, 10);
select is(pg_temp.claim('CA', 5) || '|' || pg_temp.budget(), 'true|5/5',
          'AL-12 last_quota 10, claim 5: leaves exactly 5, allowed, and last_quota drops by 5 in the same update');
select is(pg_temp.claim('CA', 1) || '|' || pg_temp.budget(), 'false|5/5',
          'AL-13 the next claim would dig into the reserve: refused, nothing counted');
select pg_temp.set_budget(45, 0, 8);
select is(pg_temp.claim('CA', 4) || '|' || pg_temp.budget(), 'false|0/8',
          'AL-14 last_quota 8, claim 4 (8 - 4 < 5): refused as a whole');
select is(pg_temp.claim('CA', 3) || '|' || pg_temp.budget(), 'true|3/5',
          'AL-15 last_quota 8, claim 3: allowed, last_quota 5');
select pg_temp.set_budget(45, 0, null);
select is(pg_temp.claim('CA', 2) || '|' || pg_temp.budget(), 'true|2/null',
          'AL-16 last_quota null (no real send yet): the cap alone applies, and it stays null');

select pg_temp.set_budget(45, 0, 7);
select pg_temp.quota(20);
select is(pg_temp.budget(), '0/7', 'AL-17 record_text_quota never raises last_quota (Joe resets it with SQL)');
select pg_temp.quota(4);
select is(pg_temp.budget(), '0/4', 'AL-18 record_text_quota lowers it to Textbelt''s figure');
select pg_temp.set_budget(45, 0, null);
select pg_temp.quota(12);
select is(pg_temp.budget(), '0/12', 'AL-19 from null, record_text_quota stores Textbelt''s figure');
select pg_temp.quota(null);
select is(pg_temp.budget(), '0/12', 'AL-20 a missing quota changes nothing');

-- ======================================================= finding 3: US only
select is(pg_temp.add_phone('CA', '+18035550101'), 'accepted', 'AL-21 a South Carolina 803 number is accepted');
select is(pg_temp.add_phone('CA', '+15555550188'), 'accepted', 'AL-22 the 555 fixture numbers are accepted');
select is(pg_temp.add_phone('CA', '+17875550101'), 'accepted', 'AL-23 Puerto Rico (a US territory) is accepted');
select is(array[pg_temp.add_phone('CA', '+14165550101'), pg_temp.add_phone('CA', '+16045550101'),
                pg_temp.add_phone('CA', '+15145550101'), pg_temp.add_phone('CA', '+18675550101')],
          array['rejected', 'rejected', 'rejected', 'rejected'],
          'AL-24 Canadian area codes (416, 604, 514, 867) are rejected');
select is(array[pg_temp.add_phone('CA', '+18765550101'), pg_temp.add_phone('CA', '+18095550101'),
                pg_temp.add_phone('CA', '+12425550101'), pg_temp.add_phone('CA', '+14415550101')],
          array['rejected', 'rejected', 'rejected', 'rejected'],
          'AL-25 Caribbean / Atlantic area codes (876, 809, 242, 441) are rejected');
select is(pg_temp.outcome(format('update public.members set phone = %L where id = %L', '+19055550101', pg_temp.id('Ava'))),
          'rejected', 'AL-26 an update to a Canadian number is rejected too');

select pg_temp.act_as('elf_a');
select is(pg_temp.add_phone('CA', '+18035550102'), 'accepted',
          'AL-27 the Elf (authenticated) can still add a US number: the check needs no extra privileges');
select is(pg_temp.add_phone('CA', '+12505550102'), 'rejected', 'AL-27 ... and is refused a Canadian one');
select pg_temp.as_postgres();

select is((select convalidated from pg_constraint where conname = 'members_phone_check'
            and conrelid = 'public.members'::regclass), true,
          'AL-28 the check is validated, so every stored phone already passes it');

-- ======================================================= finding 6a: trigger order
select is((select array_agg(tgname::text order by tgname) from pg_trigger
            where tgrelid = 'public.members'::regclass and not tgisinternal
              and tgname in ('members_phone_required', 'members_tidy')),
          array['members_phone_required', 'members_tidy'],
          'AL-29 the phone guard fires before members_tidy (name order), which is why tidy must not touch phone');
select is((select prosrc ~* '\mphone\M' from pg_proc where oid = 'private.members_tidy()'::regprocedure), false,
          'AL-30 members_tidy''s body never mentions phone');
update public.members set first_name = '  Ava  ', phone = phone where id = pg_temp.id('Ava');
select is((select first_name || '|' || (phone ~ '^\+1555') from public.members where id = pg_temp.id('Ava')),
          'Ava|true', 'AL-31 tidy trims the name and leaves the phone as it was');

-- ======================================================= finding 1: pg_net
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private')
              and p.prosrc ~* '\mnet\.'
              and (has_function_privilege('anon', p.oid, 'execute')
                   or has_function_privilege('authenticated', p.oid, 'execute'))), 0,
          'AL-32 no function anon or authenticated can execute calls net.*');
select is(has_function_privilege('anon', 'private.keep_alive()', 'execute') or
          has_function_privilege('authenticated', 'private.keep_alive()', 'execute'), false,
          'AL-33 keep_alive (the only pg_net caller) is not executable by clients');

select * from finish();
rollback;
