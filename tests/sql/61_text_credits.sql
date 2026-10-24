-- ===========================================================================
-- 61 -- Claiming text credits under a lock (no over-spend, no double texts)
-- ===========================================================================
-- Spec: "Texting details -> Decisions from Joe (2026-10-24)" 1, 2, 6, and
-- "Security hardening (from the audit, 2026-10-24)" S1, S3, S5.
-- Scenarios CLM-01..10, CT-01..11 and RLSA-01 in tests/SCENARIOS.md.
--
-- Contract under test (proposed in SCENARIOS.md, "Credit claims"):
--   private.text_budget.used int not null default 0     never decreases
--   private.text_budget.last_quota int null              last Textbelt quotaRemaining
--   public.claim_text_credits(p_circle_id uuid, p_n int) returns boolean
--   public.record_text_quota(p_quota int) returns void
--   public.claim_texts(p_circle_id uuid, p_kind text, p_member_ids uuid[],
--                      p_dry_run boolean, p_resend boolean) returns jsonb
-- all SECURITY DEFINER, executable by service_role only.
--
-- TRUE CONCURRENCY can't happen inside one transaction, so the serialisation
-- is tested two ways:
--   1. sequentially: a second claim that, with the first, would pass the cap is
--      refused, and a second identical batch writes no rows (CLM-04, CT-02);
--   2. the lock itself: after a claim, this transaction holds a writer lock
--      (FOR UPDATE / FOR NO KEY UPDATE) on the circle row. Row locks never show
--      in pg_locks unless someone waits, so we read them with the contrib
--      extension pgrowlocks, created here and rolled back with everything else.
--      A FOR KEY SHARE / FOR SHARE lock does not count: two requests holding it
--      would not wait for each other (CLM-10, CT-10).
--
-- Every function call goes through pg_temp.svc(), which runs it as
-- service_role and turns an error into text, so a missing function is one red
-- line instead of aborting the file.

begin;
-- \include tests/fixtures/sql/fixtures.sql

create extension if not exists pgrowlocks with schema extensions;

select plan(58);

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
                            coalesce(pg_temp.id(p_circle), gen_random_uuid()), p_n));
end $fx$;

create function pg_temp.quota(p_q int) returns text
language plpgsql as $fx$
begin
  return pg_temp.svc(format('select public.record_text_quota(p_quota => %s)::text', p_q));
end $fx$;

create function pg_temp.ids(variadic p_labels text[]) returns uuid[]
language sql stable as $fx$
  select array_agg(pg_temp.id(l) order by l) from unnest(p_labels) l;
$fx$;

-- claim_texts as service_role; the jsonb result is kept under p_key.
create function pg_temp.ct(p_key text, p_circle text, p_kind text, p_members uuid[],
                           p_dry boolean, p_resend boolean default false) returns void
language plpgsql as $fx$
declare r text;
begin
  r := pg_temp.svc(format(
    'select public.claim_texts(p_circle_id => %L::uuid, p_kind => %L, p_member_ids => %L::uuid[],
                               p_dry_run => %L::boolean, p_resend => %L::boolean)::text',
    pg_temp.id(p_circle), p_kind, p_members, p_dry, p_resend));
  insert into pg_temp.t_view (label, v)
  values (p_key, case when r like 'error %' or r = 'null' then jsonb_build_object('sql_error', r) else r::jsonb end)
  on conflict (label) do update set v = excluded.v;
end $fx$;

-- Labels of members skipped for p_reason in result p_key, sorted.
create function pg_temp.skipped(p_key text, p_reason text) returns text
language sql stable as $fx$
  select coalesce(string_agg(pg_temp.label((s->>'member_id')::uuid), ',' order by pg_temp.label((s->>'member_id')::uuid)), '')
    from jsonb_array_elements(coalesce(pg_temp.view(p_key)->'skipped', '[]')) s
   where s->>'reason' = p_reason;
$fx$;

-- Labels of members with a row in status p_status (and kind p_kind) in circle p_circle, sorted.
create function pg_temp.rows_for(p_circle text, p_status text, p_kind text default 'invite') returns text
language plpgsql as $fx$
declare v text;
begin
  select coalesce(string_agg(pg_temp.label(t.member_id), ',' order by pg_temp.label(t.member_id)), '')
    into v
    from public.texts t join public.members m on m.id = t.member_id
   where m.circle_id = pg_temp.id(p_circle) and t.status = p_status and t.kind = p_kind;
  return v;
end $fx$;

create function pg_temp.set_budget(p_cap int, p_used int, p_last_quota int) returns void
language plpgsql as $fx$
begin
  execute 'update private.text_budget set cap = $1, used = $2, last_quota = $3' using p_cap, p_used, p_last_quota;
exception when undefined_column then
  raise notice 'private.text_budget has no used / last_quota column yet';
end $fx$;

create function pg_temp.used() returns text
language plpgsql as $fx$
begin
  return pg_temp.budget_used()::text;
exception when undefined_column then
  return 'no used column';
end $fx$;

create function pg_temp.last_quota() returns text
language plpgsql as $fx$
declare v int;
begin
  execute 'select last_quota from private.text_budget' into v;
  return coalesce(v::text, 'null');
exception when undefined_column then
  return 'no last_quota column';
end $fx$;

create function pg_temp.can_exec(p_role text, p_sig text) returns boolean
language plpgsql as $fx$
begin
  if to_regprocedure(p_sig) is null then return null; end if;
  return has_function_privilege(p_role, p_sig, 'execute');
end $fx$;

create function pg_temp.mk_old_text(p_member text, p_kind text, p_status text, p_dry boolean, p_minutes int)
returns void
language plpgsql as $fx$
begin
  insert into public.texts (member_id, kind, status, dry_run, created_at)
  values (pg_temp.id(p_member), p_kind, p_status, p_dry, now() - make_interval(mins => p_minutes));
end $fx$;

-- --------------------------------------------------------------- fixtures
select pg_temp.mk_elf('elf_a');
select pg_temp.mk_elf('elf_b');
select pg_temp.mk_circle('CA', 'elf_a');
select pg_temp.mk_members('CA', 'Ava', 'Ben', 'Cy', 'Dee');
select pg_temp.mk_circle('CB', 'elf_a');
select pg_temp.mk_members('CB', 'Eve', 'Fay', 'Gus');
select pg_temp.mk_circle('CC', 'elf_a');
select pg_temp.mk_members('CC', 'Hal', 'Ida', 'Jo');
select pg_temp.mk_circle('CD', 'elf_a');
select pg_temp.mk_members('CD', 'Kai', 'Lu', 'Mo');
select pg_temp.mk_circle('CR', 'elf_a');
select pg_temp.mk_members('CR', 'Ned', 'Oli', 'Pia');
select pg_temp.mk_matches('CR', 'Ned', 'Oli', 'Oli', 'Pia', 'Pia', 'Ned');
select pg_temp.set_status('CR', 'drawn');
select pg_temp.mk_circle('CR2', 'elf_a');
select pg_temp.mk_members('CR2', 'Tia', 'Uma', 'Vic');
select pg_temp.mk_matches('CR2', 'Tia', 'Uma', 'Uma', 'Vic', 'Vic', 'Tia');
select pg_temp.set_status('CR2', 'drawn');
select pg_temp.mk_circle('CK', 'elf_a');
select pg_temp.mk_members('CK', 'Quin', 'Ray', 'Sal');
select pg_temp.mk_circle('CL', 'elf_a');          -- no members: its row carries no FK lock
select pg_temp.mk_circle('CS', 'elf_a');          -- for the lock-helper sanity check
select pg_temp.mk_circle('CZ', 'elf_b');
select pg_temp.mk_members('CZ', 'Zed');

select pg_temp.set_budget(45, 40, null);

-- =============================================================== S1: the counter
-- CLM-01 columns ---------------------------------------------------------------
select has_column('private', 'text_budget', 'used', 'CLM-01 private.text_budget.used exists');
select col_not_null('private', 'text_budget', 'used', 'CLM-01 used is not null');
select col_default_is('private', 'text_budget', 'used', '0', 'CLM-01 used defaults to 0');
select has_column('private', 'text_budget', 'last_quota', 'CLM-01 private.text_budget.last_quota exists');
select col_is_null('private', 'text_budget', 'last_quota', 'CLM-01 last_quota is nullable (no send yet)');

-- CLM-02 service_role only -------------------------------------------------------
select is(array[pg_temp.can_exec('service_role', 'public.claim_text_credits(uuid,integer)'),
                pg_temp.can_exec('service_role', 'public.record_text_quota(integer)'),
                pg_temp.can_exec('service_role', 'public.claim_texts(uuid,text,uuid[],boolean,boolean)')],
          array[true, true, true], 'CLM-02 service_role can execute claim_text_credits, record_text_quota, claim_texts');
select is(array[pg_temp.can_exec('public',        'public.claim_text_credits(uuid,integer)'),
                pg_temp.can_exec('anon',          'public.claim_text_credits(uuid,integer)'),
                pg_temp.can_exec('authenticated', 'public.claim_text_credits(uuid,integer)'),
                pg_temp.can_exec('public',        'public.record_text_quota(integer)'),
                pg_temp.can_exec('anon',          'public.record_text_quota(integer)'),
                pg_temp.can_exec('authenticated', 'public.record_text_quota(integer)'),
                pg_temp.can_exec('public',        'public.claim_texts(uuid,text,uuid[],boolean,boolean)'),
                pg_temp.can_exec('anon',          'public.claim_texts(uuid,text,uuid[],boolean,boolean)'),
                pg_temp.can_exec('authenticated', 'public.claim_texts(uuid,text,uuid[],boolean,boolean)')],
          array[false, false, false, false, false, false, false, false, false],
          'CLM-02 public, anon and authenticated cannot execute any of them');
select pg_temp.act_as('elf_a');
select pg_temp.keep('elf_claim', pg_temp.try(format('select public.claim_text_credits(%L::uuid, 1)', pg_temp.id('CA'))));
select pg_temp.as_postgres();
select ok(to_regprocedure('public.claim_text_credits(uuid,integer)') is not null and pg_temp.val('elf_claim') like '42501%',
          'CLM-02 the Elf calling claim_text_credits directly is refused (' || pg_temp.val('elf_claim') || ')');

-- CLM-03 a claim that fits is granted and counted ----------------------------------
select is(pg_temp.claim('CA', 3), 'true', 'CLM-03 40 used + 3 <= 45: the claim is granted');
select is(pg_temp.used(), '43', 'CLM-03 used goes from 40 to 43');

-- CLM-04 two claims in sequence that together pass the cap ------------------------
select is(pg_temp.claim('CA', 3), 'false', 'CLM-04 43 used + 3 > 45: the second claim is refused');
select is(pg_temp.used(), '43', 'CLM-04 a refused claim reserves nothing (used stays 43)');
select is(pg_temp.claim('CA', 2) || '|' || pg_temp.used(), 'true|45', 'CLM-04 43 + 2 = 45 exactly fits');
select is(pg_temp.claim('CA', 1) || '|' || pg_temp.used(), 'false|45', 'CLM-04 at the cap a single credit is refused');

-- CLM-05 a zero or negative claim never lowers the counter ------------------------
select pg_temp.set_budget(45, 40, null);
select pg_temp.claim('CA', 0);
select pg_temp.claim('CA', -5);
select is(pg_temp.used(), '40', 'CLM-05 claiming 0 or -5 leaves used at 40');

-- CLM-06 the reserve: last_quota at or below 5 refuses ------------------------------
select pg_temp.quota(5);
select is(pg_temp.last_quota(), '5', 'CLM-06 record_text_quota stores Textbelt''s quotaRemaining');
select is(pg_temp.claim('CA', 1) || '|' || pg_temp.used(), 'false|40', 'CLM-06 last_quota 5 refuses, and nothing is counted');
-- Revised 2026-10-24 (audit_lows finding 4): record_text_quota keeps the lower
-- value, so a later 6 can't raise 5. Joe resets last_quota with SQL after buying
-- credit; set_budget models that. The reserve rule is last_quota - n >= 5, and
-- the claim decrements last_quota by n atomically.
select pg_temp.set_budget(45, 40, 6);
select is(pg_temp.claim('CA', 1) || '|' || pg_temp.used(), 'true|41', 'CLM-06 last_quota 6 allows');
select is(pg_temp.last_quota(), '5', 'CLM-06 a claim of 1 lowers last_quota from 6 to 5 in the same update');

-- CLM-07 the counter is the authority, not the texts table -------------------------
select pg_temp.set_budget(45, 45, null);
select is(pg_temp.claim('CA', 1), 'false', 'CLM-07 used = cap refuses even though no texts rows record those sends');
select pg_temp.set_budget(45, 0, null);
insert into public.texts (member_id, kind, status, dry_run)
  select pg_temp.id('Ava'), 'invite', 'failed', false from generate_series(1, 45);
select is(pg_temp.claim('CA', 1), 'true', 'CLM-07 real texts rows are not re-counted on top of used');
delete from public.texts where member_id = pg_temp.id('Ava');

-- CLM-08 deleting never lowers the counter ------------------------------------------
select pg_temp.set_budget(45, 40, null);
select pg_temp.claim('CB', 3);
insert into public.texts (member_id, kind, status, dry_run)
values (pg_temp.id('Eve'), 'invite', 'sent', false),
       (pg_temp.id('Fay'), 'invite', 'sent', false),
       (pg_temp.id('Gus'), 'invite', 'failed', false);
select pg_temp.act_as('elf_a');
select pg_temp.try($$delete from public.circles where id = pg_temp.id('CB')$$);
select pg_temp.as_postgres();
delete from public.texts where member_id in (select id from public.members where circle_id = pg_temp.id('CA'));
select is((select count(*) from public.circles where id = pg_temp.id('CB')), 0::bigint,
          'CLM-08 (setup) the Elf deleted a circle that had real texts');
select is(pg_temp.used(), '43', 'CLM-08 deleting a circle, its members and texts leaves used at 43');
select is(pg_temp.claim('CA', 3), 'false', 'CLM-08 the deleted circle''s 3 texts still count against the cap');

-- CLM-09 an unknown circle claims nothing ---------------------------------------------
select pg_temp.set_budget(45, 10, null);
select pg_temp.claim('no-such-circle', 1);
select is(pg_temp.used(), '10', 'CLM-09 a claim for a circle that doesn''t exist counts nothing');

-- CLM-10 the claim locks the circle row ------------------------------------------------
select pg_temp.as_postgres();
select ok(not pg_temp.row_locked_for_write('public.circles', pg_temp.id('CL')),
          'CLM-10 (harness) a fresh circle row starts unlocked');
select pg_temp.keep('cs_lock', (select id::text from public.circles where id = pg_temp.id('CS') for update));
select ok(pg_temp.row_locked_for_write('public.circles', pg_temp.id('CS')),
          'CLM-10 (harness) the lock detector sees a SELECT ... FOR UPDATE');
select pg_temp.claim('CL', 1);
select ok(pg_temp.row_locked_for_write('public.circles', pg_temp.id('CL')),
          'CLM-10 claim_text_credits holds a writer lock on the circle row until the transaction ends (got: '
          || pg_temp.row_lock_modes('public.circles', pg_temp.id('CL')) || ')');

-- =============================================================== S3: claim_texts
-- Ava: 3 real invites two hours ago, all failed (not invited; too old to count
-- toward the hourly limit). Ben: only a DRY-RUN invite. Cy: a real sent invite.
-- Dee: 3 texts in the last hour (a dry run, a failure, a failed reveal).
select pg_temp.set_budget(45, 0, null);
select pg_temp.mk_old_text('Ava', 'invite', 'failed', false, 120);
select pg_temp.mk_old_text('Ava', 'invite', 'failed', false, 121);
select pg_temp.mk_old_text('Ava', 'invite', 'failed', false, 122);
select pg_temp.mk_old_text('Ben', 'invite', 'sent',   true,  30);
select pg_temp.mk_old_text('Cy',  'invite', 'sent',   false, 200);
select pg_temp.mk_old_text('Dee', 'invite', 'sent',   true,  50);
select pg_temp.mk_old_text('Dee', 'invite', 'failed', false, 40);
select pg_temp.mk_old_text('Dee', 'reveal', 'failed', false, 10);

-- CT-01 a real invite batch --------------------------------------------------------------
select pg_temp.ct('b1', 'CA', 'invite', pg_temp.ids('Ava', 'Ben', 'Cy', 'Dee'), false);
select is(pg_temp.view('b1')->>'ok', 'true', 'CT-01 the batch is accepted (' || coalesce(pg_temp.view('b1')->>'sql_error', 'ok') || ')');
select is(pg_temp.rows_for('CA', 'pending'), 'Ava,Ben',
          'CT-01 pending rows are written for Ava and Ben (a dry-run invite is not "invited", Decision 1)');
select is(pg_temp.skipped('b1', 'already invited'), 'Cy', 'CT-01 Cy (real invite sent) is skipped as already invited');
select is(pg_temp.skipped('b1', 'too many texts, try again in an hour'), 'Dee',
          'CT-01 Dee (3 texts this hour, dry-run and failed included) is skipped by the rate limit (Decisions 2, 3)');
select is(pg_temp.used(), '2', 'CT-01 exactly the 2 texts that will go are claimed');
select is((select coalesce(array_agg(x order by x), '{}') from (select (e->>'text_id')::uuid x from jsonb_array_elements(pg_temp.view('b1')->'texts') e) s),
          (select coalesce(array_agg(t.id order by t.id), '{00000000-0000-0000-0000-000000000000}') from public.texts t join public.members m on m.id = t.member_id
            where m.circle_id = pg_temp.id('CA') and t.status = 'pending'),
          'CT-01 the result lists the pending rows'' ids, so the function can mark each sent or failed');

-- CT-02 the same batch again (a parallel second click) -------------------------------
select pg_temp.ct('b2', 'CA', 'invite', pg_temp.ids('Ava', 'Ben', 'Cy', 'Dee'), false);
select is(pg_temp.rows_for('CA', 'pending'), 'Ava,Ben', 'CT-02 a second identical batch writes no new rows');
select is(pg_temp.skipped('b2', 'already invited'), 'Ava,Ben,Cy', 'CT-02 a pending real invite counts as already invited');
select is(pg_temp.used(), '2', 'CT-02 and claims no credits');

-- CT-03 Re-send is explicit: the duplicate filter is off ------------------------------
select pg_temp.ct('r1', 'CA', 'invite', pg_temp.ids('Cy'), false, true);
select is(pg_temp.rows_for('CA', 'pending'), 'Ava,Ben,Cy', 'CT-03 Re-send to already-invited Cy writes a pending row');
select is(pg_temp.used(), '3', 'CT-03 and claims one credit');

-- CT-04 ... but the rate limit still applies, under the lock -------------------------
select pg_temp.ct('r2', 'CA', 'invite', pg_temp.ids('Dee'), false, true);
select is(pg_temp.skipped('r2', 'too many texts, try again in an hour'), 'Dee', 'CT-04 Re-send to rate-limited Dee is skipped');
select is((select count(*) from public.texts where member_id = pg_temp.id('Dee') and status = 'pending')::text || '|' || pg_temp.used(),
          '0|3', 'CT-04 no row is written and no credit claimed');

-- CT-05 dry runs never touch the counter, even at the cap (Decision 2) -----------------
select pg_temp.set_budget(45, 45, null);
select pg_temp.ct('d1', 'CC', 'invite', pg_temp.ids('Hal', 'Ida', 'Jo'), true);
select is(pg_temp.view('d1')->>'ok', 'true', 'CT-05 a dry-run batch at the cap is accepted');
select is((select count(*) from public.texts t join public.members m on m.id = t.member_id
            where m.circle_id = pg_temp.id('CC') and t.status = 'pending' and t.dry_run), 3::bigint,
          'CT-05 its pending rows are dry-run rows');
select is(pg_temp.used(), '45', 'CT-05 used is unchanged by a dry run');

-- CT-06 a real batch that doesn't fit writes nothing ----------------------------------
select pg_temp.set_budget(45, 43, null);
select pg_temp.ct('o1', 'CD', 'invite', pg_temp.ids('Kai', 'Lu', 'Mo'), false);
select is(pg_temp.view('o1')->>'ok' || '|' || coalesce(pg_temp.view('o1')->>'error', ''), 'false|text budget used up',
          'CT-06 43 + 3 > 45: refused with "text budget used up"');
select is(pg_temp.rows_for('CD', 'pending'), '', 'CT-06 no rows are written');
select is(pg_temp.used(), '43', 'CT-06 no credits are claimed');

-- CT-07 the cap is checked against the members who will actually be texted -----------
select pg_temp.mk_old_text('Kai', 'invite', 'sent', false, 300);
select pg_temp.ct('o2', 'CD', 'invite', pg_temp.ids('Kai', 'Lu', 'Mo'), false);
select is(pg_temp.view('o2')->>'ok', 'true', 'CT-07 with Kai already invited only 2 go, and 43 + 2 fits');
select is(pg_temp.rows_for('CD', 'pending') || '|' || pg_temp.used(), 'Lu,Mo|45', 'CT-07 Lu and Mo get pending rows; used is 45');

-- CT-08 a reveal batch texts everyone, invites notwithstanding ------------------------
select pg_temp.set_budget(45, 0, null);
select pg_temp.mk_old_text(l, 'invite', 'sent', false, 300) from unnest(array['Ned', 'Oli', 'Pia']) l;
select pg_temp.ct('v1', 'CR', 'reveal', pg_temp.ids('Ned', 'Oli', 'Pia'), false);
select is(pg_temp.rows_for('CR', 'pending', 'reveal'), 'Ned,Oli,Pia', 'CT-08 a reveal batch writes a pending reveal for every member');
select is(pg_temp.used(), '3', 'CT-08 and claims 3 credits');

-- CT-11 a whole-circle reveal moves drawn -> sent inside the claim (lead decision)
select is(pg_temp.circle_status('CR'), 'sent', 'CT-11 the reveal claim moved the circle from drawn to sent');
select pg_temp.ct('v2', 'CR', 'reveal', pg_temp.ids('Ned', 'Oli', 'Pia'), false);
select is(coalesce(pg_temp.view('v2')->>'ok', 'null') || '|' || coalesce(pg_temp.view('v2')->>'error', '') || '|'
          || (select count(*) from public.texts t join public.members m on m.id = t.member_id
               where m.circle_id = pg_temp.id('CR') and t.kind = 'reveal')::text || '|' || pg_temp.used(),
          'false|names have already been sent|3|3',
          'CT-11 a second (losing) reveal batch claims nothing and writes nothing');
select pg_temp.set_budget(45, 44, null);
select pg_temp.ct('v3', 'CR2', 'reveal', pg_temp.ids('Tia', 'Uma', 'Vic'), false);
select is(coalesce(pg_temp.view('v3')->>'error', '') || '|' || pg_temp.circle_status('CR2'), 'text budget used up|drawn',
          'CT-11 a reveal refused by the cap leaves the circle drawn');
select pg_temp.set_budget(45, 3, null);

-- CT-09 members of another circle are never texted ---------------------------------------
select pg_temp.ct('x1', 'CA', 'invite', pg_temp.ids('Zed'), false, true);
select is((select count(*) from public.texts where member_id = pg_temp.id('Zed'))::text || '|' || pg_temp.used(), '0|3',
          'CT-09 a member id from another circle gets no row and no credit');

-- CT-10 claim_texts locks the circle row ------------------------------------------------
select ok(not pg_temp.row_locked_for_write('public.circles', pg_temp.id('CK')),
          'CT-10 (harness) CK holds only the foreign-key share lock before the claim');
select pg_temp.ct('k1', 'CK', 'invite', pg_temp.ids('Quin', 'Ray', 'Sal'), true);
select ok(pg_temp.row_locked_for_write('public.circles', pg_temp.id('CK')),
          'CT-10 claim_texts holds a writer lock on the circle row (got: '
          || pg_temp.row_lock_modes('public.circles', pg_temp.id('CK')) || ')');

-- =============================================================== S5
select is(array[pg_temp.can_exec('public',        'public.rls_auto_enable()'),
                pg_temp.can_exec('anon',          'public.rls_auto_enable()'),
                pg_temp.can_exec('authenticated', 'public.rls_auto_enable()')],
          array[false, false, false],
          'RLSA-01 public, anon and authenticated cannot execute public.rls_auto_enable()');

select * from finish();
rollback;
