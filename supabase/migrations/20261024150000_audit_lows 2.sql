-- Re-audit Lows (security-auditor, 2026-10-24): stuck pending rows, an atomic
-- reserve, strictly-US phones, the members trigger order, and a note on pg_net.
--
-- spec "Texting -> HARD LIMITS", "Security hardening" S1-S3, "Lead decisions on
-- the S1-S3 contract". Pinned by tests/sql/62_audit_lows.sql.
--
-- Live data checked before applying (2026-10-24): 4 members, all area code 803;
-- 0 texts; budget cap 45, used 0, last_quota null. Nothing here rewrites rows.

-- ---------------------------------------------------------------------------
-- Finding 1: pg_net (`net` schema). NOT CHANGED HERE, on purpose.
-- ---------------------------------------------------------------------------
-- The ask was to revoke `net` from public, anon and authenticated. On Supabase
-- that can't be done from a migration: pg_net is created by supabase_admin, which
-- owns `net` and made every grant on it (usage to PUBLIC, anon, authenticated;
-- all on its tables and sequences to PUBLIC). Migrations run as postgres, which
-- holds no grant option, so `revoke` is a silent no-op ("no privileges could be
-- revoked"). Probed on the live project in a rolled-back block, 2026-10-24.
-- Supabase documents this as a platform constraint, and warns that removing the
-- PUBLIC table grants would break pg_net for postgres (and so keep_alive()):
-- https://supabase.com/docs/guides/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16
--
-- What actually keeps clients out (verified 2026-10-24):
--   * anon / authenticated can't log in to Postgres; they arrive only through
--     PostgREST, which exposes only `public` and `graphql_public` (PGRST106 for
--     `net`), and pg_graphql is not enabled.
--   * No function a client can execute calls net.* (pinned in 62).
-- Keep `net` out of the Data API's exposed schemas.

-- ---------------------------------------------------------------------------
-- Finding 2: sweep stuck pending rows.
-- ---------------------------------------------------------------------------
-- spec S3 / lead decision: a claimed-but-unsent `pending` row ends as `failed`,
-- which keeps it counted. If send-texts dies between claim and update, the row
-- would otherwise stay pending for ever, and a pending real invite blocks a new
-- invite for that kid ("already invited"). Ten minutes is far longer than an
-- Edge Function can run, so a row that old is never going to be finished.
--
-- "Stay counted": the lifetime counter (private.text_budget.used) is never
-- touched, and the 3-per-hour rate limit counts every row whatever its status.
-- send-texts only finalises rows still `pending`, so a swept row stays failed.
--
-- p_circle_id null = every circle (pg_cron); otherwise one circle (claim_texts).
-- SECURITY INVOKER: callers are postgres (cron) and claim_texts (definer, owned
-- by postgres). No client role can execute it (grant block).
create function private.sweep_pending_texts(p_circle_id uuid default null) returns integer
language plpgsql volatile
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.texts t
     set status = 'failed',
         error  = 'timed out'
   where t.status = 'pending'
     and t.created_at < pg_catalog.now() - interval '10 minutes'
     and (p_circle_id is null
          or t.member_id in (select m.id from public.members m where m.circle_id = p_circle_id));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Every 10 minutes. Re-running replaces the job.
select cron.schedule('sweep-pending-texts', '*/10 * * * *', 'select private.sweep_pending_texts()');

-- ---------------------------------------------------------------------------
-- Finding 4: make the reserve atomic.
-- ---------------------------------------------------------------------------
-- spec "HARD LIMITS" / S1: keep a reserve of 5 Textbelt credits. Before, the
-- reserve was checked against the last quota Textbelt reported, which only
-- updates after a send, so two batches could each pass "last_quota > 5" and
-- jointly dig into the reserve. Now the claim itself spends from last_quota:
--   * a claim of n needs last_quota - n >= 5 (null = no real send yet, allowed;
--     the cap still applies), and
--   * the same single-row update decrements last_quota by n, so the next
--     claimer (waiting on that row) re-checks against the reduced value.
-- For n = 1 this is the same rule as before (last_quota > 5).
--
-- record_text_quota then never raises last_quota: it keeps the lower of what we
-- have counted down to and what Textbelt reports.
--
-- JOE: when you buy more Textbelt credit, last_quota will NOT go up on its own.
-- Reset it by hand in the SQL editor, e.g.
--     update private.text_budget set last_quota = null where id;   -- or the new quota
-- (and raise `cap` if you want to spend the new credit).

create or replace function public.claim_text_credits(p_circle_id uuid, p_n integer) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- Authorization: service_role only, enforced by the grant block (no client
  -- role can execute this). Nothing to claim never lowers used (CLM-05).
  if p_circle_id is null or p_n is null or p_n <= 0 then
    return false;
  end if;

  -- Lock first, as its own statement.
  perform 1 from public.circles c where c.id = p_circle_id for update;
  if not found then
    return false;  -- unknown circle: counts nothing (CLM-09)
  end if;

  -- HARD LIMITS 1: the whole claim fits under the cap, and spending it leaves
  -- the reserve (5) intact. One row, one update: the re-check on a concurrent
  -- update sees every condition (see 20261024140100).
  update private.text_budget b
     set used       = b.used + p_n,
         last_quota = b.last_quota - p_n          -- null stays null
   where b.id
     and b.used + p_n <= b.cap
     and (b.last_quota is null or b.last_quota - p_n >= 5);
  return found;
end $$;

create or replace function public.record_text_quota(p_quota integer) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- service_role only (grant block). A missing quota never clears the reserve.
  if p_quota is null then
    return;
  end if;
  -- Never raise it: keep the lower of our count-down and Textbelt's figure.
  -- Joe resets it with SQL after buying credit (see the note above).
  update private.text_budget b
     set last_quota = least(coalesce(b.last_quota, p_quota), p_quota)
   where b.id;
end $$;

-- claim_texts: unchanged except that it sweeps this circle's stale pending rows
-- right after taking the circle lock, before any check reads `texts`.
create or replace function public.claim_texts(
  p_circle_id  uuid,
  p_kind       text,
  p_member_ids uuid[],
  p_dry_run    boolean,
  p_resend     boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_go      uuid[] := '{}';
  v_skipped jsonb  := '[]'::jsonb;
  v_texts   jsonb;
  v_reason  text;
  m         record;
begin
  -- Authorization: service_role only (grant block). Inputs next.
  if p_circle_id is null or p_kind is null or p_kind not in ('invite', 'reveal')
     or p_dry_run is null or p_resend is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'bad request');
  end if;

  -- Lock the circle row first, as its own statement. Everything below reads
  -- with a fresh snapshot taken after the lock was granted.
  select c.status into v_status from public.circles c where c.id = p_circle_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'circle not found');
  end if;

  -- Finding 2: a stale pending real invite must not block this batch until the
  -- next cron sweep. Under the lock, so it can't race another claim.
  perform private.sweep_pending_texts(p_circle_id);

  -- Status, re-checked under the lock (spec "Circle status", "Re-send").
  if p_kind = 'invite' and v_status = 'sent' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'names have already been sent');
  elsif p_kind = 'reveal' and not p_resend and v_status = 'open' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'names have not been drawn yet');
  elsif p_kind = 'reveal' and not p_resend and v_status = 'sent' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'names have already been sent');
  elsif p_kind = 'reveal' and p_resend and v_status <> 'sent' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'names have not been sent yet');
  end if;

  -- Only members of this circle (CT-09), each once, in a stable order.
  for m in
    select mb.id, mb.phone
      from public.members mb
     where mb.circle_id = p_circle_id
       and mb.id = any (coalesce(p_member_ids, '{}'))
     order by mb.first_name, mb.id
  loop
    v_reason := null;
    if m.phone is null then
      -- "Who gets texted": no phone is skipped and reported, never an error.
      v_reason := 'no phone number';
    elsif p_kind = 'invite' and not p_resend and exists (
        -- Decision 1: dry-run invites never count. S3: a pending real one does.
        select 1 from public.texts t
         where t.member_id = m.id and t.kind = 'invite' and not t.dry_run
           and t.status in ('sent', 'pending')) then
      v_reason := 'already invited';
    elsif (select count(*) from public.texts t
            where t.member_id = m.id and t.created_at > pg_catalog.now() - interval '1 hour') >= 3 then
      -- spec "Re-send": 3 per member per hour. Decisions 2, 3: every row counts
      -- (dry run, failed, pending), and the member is skipped, not the batch.
      v_reason := 'too many texts, try again in an hour';
    elsif p_kind = 'reveal' and not exists (
        select 1 from public.matches x where x.circle_id = p_circle_id and x.giver_id = m.id) then
      v_reason := 'no match';
    end if;

    if v_reason is null then
      v_go := v_go || m.id;
    else
      v_skipped := v_skipped || pg_catalog.jsonb_build_object('member_id', m.id, 'reason', v_reason);
    end if;
  end loop;

  -- Real sends only: the whole batch must fit, or nothing happens (CT-06).
  if not p_dry_run and pg_catalog.cardinality(v_go) > 0 then
    if not public.claim_text_credits(p_circle_id, pg_catalog.cardinality(v_go)) then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'text budget used up');
    end if;
  end if;

  -- "Send the names" locks the draw, in the same transaction as the claim.
  if p_kind = 'reveal' and not p_resend then
    update public.circles c set status = 'sent' where c.id = p_circle_id and c.status = 'drawn';
  end if;

  with ins as (
    insert into public.texts (member_id, kind, status, dry_run)
    select g.id, p_kind, 'pending', p_dry_run from pg_catalog.unnest(v_go) as g (id)
    returning id, member_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('member_id', ins.member_id, 'text_id', ins.id)),
                  '[]'::jsonb)
    into v_texts
    from ins;

  return pg_catalog.jsonb_build_object('ok', true, 'texts', v_texts, 'skipped', v_skipped);
end $$;

-- ---------------------------------------------------------------------------
-- Finding 3: strictly US +1 phone numbers.
-- ---------------------------------------------------------------------------
-- spec S2: "Phone numbers are US only (+1)". +1 is the whole North American
-- Numbering Plan, so +1 alone also admits Canada and ~20 Caribbean / Atlantic
-- countries. Reject those area codes. US territories (Puerto Rico 787/939,
-- USVI 340, Guam 671, N. Mariana Is. 670, American Samoa 684) ARE the US and stay.
--
-- THE LIST lives here (the database is the boundary) and is mirrored in
-- js/phone.js (NON_US_NANP). Change both together.
-- Source: NANPA area code assignments (nanpa.com, "NPA Reports"; Canadian codes
-- per CNA, cnac.ca), compiled from memory on 2026-10-24 without web access, so
-- it may miss a Canadian overlay assigned after mid-2026. Erring short is the
-- safe direction: a missed code only lets a non-US number through, while a
-- wrongly listed code would lock out a real US kid.
--
-- Canada (57): 204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403
--   416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 600 604
--   613 622 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879
--   902 905 942
-- Caribbean / Atlantic (21): 242 Bahamas, 246 Barbados, 264 Anguilla,
--   268 Antigua & Barbuda, 284 British Virgin Is., 345 Cayman Is., 441 Bermuda,
--   473 Grenada, 649 Turks & Caicos, 658/876 Jamaica, 664 Montserrat,
--   721 Sint Maarten, 758 St Lucia, 767 Dominica, 784 St Vincent & Grenadines,
--   809/829/849 Dominican Republic, 868 Trinidad & Tobago, 869 St Kitts & Nevis
--
-- Inline literal, not a helper function: a function in a CHECK is executed with
-- the inserting role's privileges, so the Elf would need EXECUTE on it.
alter table public.members drop constraint members_phone_check;
alter table public.members add constraint members_phone_check
  check (phone is null or (
    phone ~ '^\+1[0-9]{10}$'
    and substr(phone, 3, 3) <> all (array[
      -- Canada
      '204','226','236','249','250','257','263','289','306','343','354','365',
      '367','368','382','403','416','418','428','431','437','438','450','468',
      '474','506','514','519','548','579','581','584','587','600','604','613',
      '622','639','647','672','683','705','709','742','753','778','780','782',
      '807','819','825','867','873','879','902','905','942',
      -- Caribbean / Atlantic
      '242','246','264','268','284','345','441','473','649','658','664','721',
      '758','767','784','809','829','849','868','869','876'
    ]::text[])
  ));

-- ---------------------------------------------------------------------------
-- Finding 6a: members trigger order.
-- ---------------------------------------------------------------------------
-- BEFORE ROW triggers fire in name order: members_lock, members_phone_required,
-- members_tidy. So the phone guard runs BEFORE members_tidy, and would not see a
-- phone that tidy changed. Kept as is, deliberately, rather than renamed:
--   * members_tidy never reads or writes `phone` (CON-07: '' must be rejected by
--     the check, not tidied into "no phone"). So the guard's view is final.
--   * The CHECK constraint runs after every BEFORE trigger, so the format rule
--     can't be bypassed by trigger order either way.
--   * Renaming would churn names test-author's suites refer to.
-- INVARIANT: members_tidy must never change `phone`. If it ever needs to, rename
-- the guard to sort last (e.g. members_zz_phone_required). Pinned in 62.
comment on function private.members_tidy() is
  'Trims member text fields. Must never change phone: members_phone_required fires before it (name order). See 20261024150000.';

-- ---------------------------------------------------------------------------
-- Finding 6c: public.text_budget_cap() is KEPT.
-- ---------------------------------------------------------------------------
-- send-texts no longer calls it (it reads text_budget_state()), but
-- tests/sql/60_texting_schema.sql (TXB-08, TXB-09) and tests/SCENARIOS.md still
-- pin it. Dropping it is test-author's call first; service_role only meanwhile.

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Internal helper: nobody but its owner (postgres: pg_cron and claim_texts).
revoke all on function private.sweep_pending_texts(uuid) from public, anon, authenticated, service_role;
-- Re-created functions keep their ACLs, but restate them so this ends explicit.
revoke all on function public.claim_text_credits(uuid, integer)                    from public, anon, authenticated;
revoke all on function public.record_text_quota(integer)                           from public, anon, authenticated;
revoke all on function public.claim_texts(uuid, text, uuid[], boolean, boolean)    from public, anon, authenticated;
grant execute on function public.claim_text_credits(uuid, integer)                 to service_role;
grant execute on function public.record_text_quota(integer)                        to service_role;
grant execute on function public.claim_texts(uuid, text, uuid[], boolean, boolean) to service_role;
revoke all on table private.text_budget from public, anon, authenticated, service_role;
-- Tables: unchanged; anon gets nothing.
revoke all on public.members, public.texts from public, anon;
