-- Hardening, migration 2 of 2: claim text credits and rows under a circle lock.
--
-- spec "Security hardening" S1 (a lifetime counter deletes can't reset) and S3
-- (serialise per circle), "Decisions from Joe (2026-10-24)" 1, 2, 3 and 6,
-- "Lead decisions on the S1-S3 contract". Contract: tests/SCENARIOS.md, CLM / CT.
--
-- Why this is safe under concurrency (READ COMMITTED):
--   * claim_texts locks the circle row FOR UPDATE as its own statement. Every
--     later statement takes a fresh snapshot, so the duplicate-invite and
--     rate-limit reads see whatever a request that held the lock before us
--     committed. Two requests for one circle can't both pass those checks.
--   * The cap is global (every circle), so the circle lock alone can't protect
--     it. The counter is a single row, and the increment is one
--     `update ... where used + n <= cap and reserve ok`: a concurrent claimer
--     waits on that row and Postgres re-checks the WHERE against the newest
--     committed version. Every condition is on that same row, so the re-check is
--     complete and two claims can never jointly pass the cap (Decision 6: zero
--     over-spend).
--   * Lock order is always circle row, then budget row, so claims can't deadlock.

-- ---------------------------------------------------------------------------
-- private.text_budget: the lifetime counter and the last reported quota.
-- ---------------------------------------------------------------------------
-- used: lifetime claimed real texts. Never decreases through any function here;
-- deleting circles, members or texts doesn't touch it (S1). Claimed-but-unsent
-- credits stay counted (fail closed).
alter table private.text_budget add column used integer not null default 0 check (used >= 0);
-- last_quota: Textbelt's latest quotaRemaining (null = no real send yet).
alter table private.text_budget add column last_quota integer;
-- Start from the real texts already logged (0 on 2026-10-24), so the switch from
-- counting rows to the counter loses nothing.
update private.text_budget
   set used = (select count(*) from public.texts t where t.dry_run = false)
 where id;

-- ---------------------------------------------------------------------------
-- claim_text_credits: reserve p_n real texts under the circle lock (S1).
-- ---------------------------------------------------------------------------
create function public.claim_text_credits(p_circle_id uuid, p_n integer) returns boolean
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

  -- HARD LIMITS 1: the whole claim fits under the cap, and the reserve (5) holds.
  update private.text_budget b
     set used = b.used + p_n
   where b.id
     and b.used + p_n <= b.cap
     and (b.last_quota is null or b.last_quota > 5);
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- record_text_quota: store Textbelt's quotaRemaining after a real send (S1).
-- ---------------------------------------------------------------------------
create function public.record_text_quota(p_quota integer) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  -- service_role only (grant block). A missing quota never clears the reserve.
  if p_quota is null then
    return;
  end if;
  update private.text_budget b set last_quota = p_quota where b.id;
end $$;

-- ---------------------------------------------------------------------------
-- text_budget_state: the read-only pre-check's view of the budget.
-- ---------------------------------------------------------------------------
-- send-texts checks the cap before the links gate (spec "Order of checks") with
-- this; claim_text_credits is the real gate.
create function public.text_budget_state() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('cap', b.cap, 'used', b.used, 'last_quota', b.last_quota)
    from private.text_budget b
   where b.id;
$$;

-- ---------------------------------------------------------------------------
-- claim_texts: pick, claim and log a batch atomically, under the circle lock (S3).
-- ---------------------------------------------------------------------------
-- Returns {"ok": true, "texts": [{"member_id", "text_id"}], "skipped": [{"member_id", "reason"}]}
--      or {"ok": false, "error": <one of the spec's refusal texts>} with nothing changed.
-- A whole-circle reveal (kind 'reveal', not p_resend) also moves drawn -> sent
-- here, atomically with the claim, so a losing concurrent reveal claims nothing
-- (lead decision). The move happens in dry run too: it is what "Send the names" does.
create function public.claim_texts(
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
-- Grant block
-- ---------------------------------------------------------------------------
-- Internal to send-texts: service_role only. Supabase auto-grants EXECUTE to
-- anon and authenticated, so revoke from all three explicitly.
revoke all on function public.claim_text_credits(uuid, integer)                    from public, anon, authenticated;
revoke all on function public.record_text_quota(integer)                           from public, anon, authenticated;
revoke all on function public.text_budget_state()                                  from public, anon, authenticated;
revoke all on function public.claim_texts(uuid, text, uuid[], boolean, boolean)    from public, anon, authenticated;
grant execute on function public.claim_text_credits(uuid, integer)                 to service_role;
grant execute on function public.record_text_quota(integer)                        to service_role;
grant execute on function public.text_budget_state()                               to service_role;
grant execute on function public.claim_texts(uuid, text, uuid[], boolean, boolean) to service_role;
-- The counter stays out of every client role's reach, service_role included:
-- it changes only through the functions above (and Joe's SQL).
revoke all on table private.text_budget from public, anon, authenticated, service_role;
