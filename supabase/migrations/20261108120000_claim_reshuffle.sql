-- Re-shuffle after the names are sent.
--
-- spec "Re-shuffle after the names are sent", "Circle status", texts.kind in the
-- data model, and the kind: 'reshuffle' bullet under "Texting". Pinned by
-- tests/sql/63_claim_reshuffle.sql.
--
-- Checked for dependents on the old make_matches signature and the kind list:
--   * make_matches is called only by start_draw and reshuffle, both with one
--     argument, which now resolves to the new signature through its default.
--     Neither is changed, so plain reshuffle after sent still raises.
--   * claim_texts accepts only invite/reveal on purpose: a reshuffle never goes
--     through it. It is restated below only for the "One at a time" check. The
--     credit counter (private.text_budget) and the 3-per-hour
--     limit don't look at kind, so reshuffle rows count like any other.
--   * enforce_circle_lock guards members and no_pairs only. matches has no
--     trigger, and a re-shuffle touches neither locked table.
--   * member_view reads matches only, so the same link shows the new match.

-- ---------------------------------------------------------------------------
-- texts.kind
-- ---------------------------------------------------------------------------
-- spec data model: 'invite' | 'reveal' | 'reshuffle'.
alter table public.texts drop constraint texts_kind_check;
alter table public.texts add constraint texts_kind_check
  check (kind in ('invite', 'reveal', 'reshuffle'));

-- ---------------------------------------------------------------------------
-- private.make_matches(circle, ban_current)
-- ---------------------------------------------------------------------------
-- spec "Draw rules", unchanged, plus spec "Re-shuffle after the names are sent":
-- with p_ban_current, a giver can't draw their current receiver. One-way: if Sam
-- has Alex, Sam can't draw Alex again, but Alex may draw Sam.
--
-- Still shuffle, check, retry: a rule added to the check keeps the draw uniform
-- among the draws that pass it (see 20261018120400). The current rows are still
-- there to be read during every attempt: the delete below runs only once an
-- attempt has passed, and then the function returns.
--
-- Dropped rather than replaced because the argument list changes. Callers bind
-- by name at run time, so nothing depends on the old signature in the catalog.
drop function private.make_matches(uuid);

create function private.make_matches(p_circle_id uuid, p_ban_current boolean default false) returns void
language plpgsql volatile
set search_path = ''
as $$
declare
  v_givers    uuid[];
  v_receivers uuid[];
  v_bad       boolean;
begin
  select pg_catalog.array_agg(m.id order by m.id) into v_givers
    from public.members m where m.circle_id = p_circle_id;

  for attempt in 1 .. 1000 loop
    select pg_catalog.array_agg(g order by pg_catalog.gen_random_uuid()) into v_receivers
      from pg_catalog.unnest(v_givers) g;

    select exists (
      select 1
        from unnest(v_givers, v_receivers) as d(giver, receiver)
       where d.giver = d.receiver
          or exists (select 1 from public.no_pairs np
                      where np.circle_id = p_circle_id
                        and np.member_a = least(d.giver, d.receiver)
                        and np.member_b = greatest(d.giver, d.receiver))
          or (p_ban_current and exists (select 1 from public.matches x
                                         where x.circle_id = p_circle_id
                                           and x.giver_id = d.giver
                                           and x.receiver_id = d.receiver))
    ) into v_bad;

    if not v_bad then
      delete from public.matches where circle_id = p_circle_id;
      insert into public.matches (circle_id, giver_id, receiver_id)
      select p_circle_id, d.giver, d.receiver
        from unnest(v_givers, v_receivers) as d(giver, receiver);
      return;
    end if;
  end loop;

  raise exception 'Can''t make a draw with these do-not-pair rules. Try removing one.';
end $$;

-- ---------------------------------------------------------------------------
-- claim_reshuffle: a new draw and its pending texts, in one transaction
-- ---------------------------------------------------------------------------
-- spec "Texting": sent -> sent, service role only, called by send-texts. Same
-- return shape as claim_texts, and every refusal is ok:false with nothing changed.
--
-- spec "All or nothing": where claim_texts skips a kid at the hourly limit, this
-- refuses the whole batch, because a skipped kid would be left holding an old name.
--
-- p_member_ids must be the circle's full member list: the whole circle is always
-- re-matched, so a shorter list would leave a kid holding an old name, untold.
create function public.claim_reshuffle(
  p_circle_id  uuid,
  p_member_ids uuid[],
  p_dry_run    boolean
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_impossible constant text := 'Can''t make a draw with these do-not-pair rules. Try removing one.';
  v_status  text;
  v_all     uuid[];
  v_go      uuid[] := '{}';
  v_skipped jsonb  := '[]'::jsonb;
  v_texts   jsonb;
  m         record;
begin
  -- Authorization: service_role only (grant block). Inputs next.
  if p_circle_id is null or p_member_ids is null or p_dry_run is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'bad request');
  end if;

  -- Lock the circle row first, as its own statement. Everything below reads
  -- with a fresh snapshot taken after the lock was granted.
  select c.status into v_status from public.circles c where c.id = p_circle_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'circle not found');
  end if;

  -- As in claim_texts: a stale pending row becomes failed, and stays counted.
  perform private.sweep_pending_texts(p_circle_id);

  if v_status <> 'sent' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'names have not been sent yet');
  end if;

  -- Exactly the circle's members: none missing, none foreign, none repeated.
  select pg_catalog.array_agg(mb.id order by mb.id) into v_all
    from public.members mb where mb.circle_id = p_circle_id;
  if (select pg_catalog.array_agg(u order by u) from pg_catalog.unnest(p_member_ids) as u) is distinct from v_all then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'bad request');
  end if;

  -- spec "One at a time": any live send, of any kind, could still name the old
  -- draw. After the sweep and under the lock, so a stale row never blocks and
  -- two re-shuffles can't both pass.
  if exists (select 1 from public.texts t
               join public.members mb on mb.id = t.member_id
              where mb.circle_id = p_circle_id and t.status = 'pending') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'a send is already in progress');
  end if;

  -- In a stable order.
  for m in
    select mb.id, mb.phone
      from public.members mb
     where mb.circle_id = p_circle_id
     order by mb.first_name, mb.id
  loop
    if m.phone is null then
      -- spec: re-matched, skipped for the text and reported.
      v_skipped := v_skipped || pg_catalog.jsonb_build_object('member_id', m.id, 'reason', 'no phone number');
    elsif (select count(*) from public.texts t
            where t.member_id = m.id and t.created_at > pg_catalog.now() - interval '1 hour') >= 3 then
      -- spec "All or nothing"; every row counts (dry run, failed, pending).
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'too many texts, try again in an hour');
    else
      v_go := v_go || m.id;
    end if;
  end loop;

  -- spec: a sent draw must never change silently.
  if pg_catalog.cardinality(v_go) = 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'nobody can be texted');
  end if;

  -- The credit claim, then the draw. The block makes them one unit: an
  -- impossible draw undoes the claim as well, so a refusal costs nothing.
  begin
    if not p_dry_run then
      if not public.claim_text_credits(p_circle_id, pg_catalog.cardinality(v_go)) then
        return pg_catalog.jsonb_build_object('ok', false, 'error', 'text budget used up');
      end if;
    end if;

    -- New rows, so every opened_at starts over (spec: "Opened" tracking starts over).
    perform private.make_matches(p_circle_id, true);
  exception when raise_exception then
    if sqlerrm = v_impossible then
      return pg_catalog.jsonb_build_object('ok', false, 'error', v_impossible);
    end if;
    raise;
  end;

  with ins as (
    insert into public.texts (member_id, kind, status, dry_run)
    select g.id, 'reshuffle', 'pending', p_dry_run from pg_catalog.unnest(v_go) as g (id)
    returning id, member_id
  )
  -- receiver_id comes from this same transaction, so send-texts names the draw
  -- this claim made, whatever happens to the matches afterwards.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'member_id', ins.member_id, 'text_id', ins.id, 'receiver_id', x.receiver_id)),
                  '[]'::jsonb)
    into v_texts
    from ins
    join public.matches x on x.circle_id = p_circle_id and x.giver_id = ins.member_id;

  return pg_catalog.jsonb_build_object('ok', true, 'texts', v_texts, 'skipped', v_skipped);
end $$;

-- ---------------------------------------------------------------------------
-- claim_texts: refuse a Re-send while a re-shuffle is pending
-- ---------------------------------------------------------------------------
-- spec "One at a time". The full body of 20261024150000, plus that one check.
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

  -- spec "One at a time": a Re-send during a re-shuffle could name an old match.
  -- After the sweep, so a stale row never blocks.
  if p_kind = 'reveal' and p_resend and exists (
      select 1 from public.texts t
        join public.members mb on mb.id = t.member_id
       where mb.circle_id = p_circle_id and t.kind = 'reshuffle' and t.status = 'pending') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'a send is already in progress');
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
-- Internal helper: nobody but its owner (start_draw, reshuffle, claim_reshuffle).
revoke all on function private.make_matches(uuid, boolean) from public, anon, authenticated, service_role;
-- send-texts only. An Elf must not be able to change a sent draw without the texts.
revoke all on function public.claim_reshuffle(uuid, uuid[], boolean) from public, anon, authenticated;
grant execute on function public.claim_reshuffle(uuid, uuid[], boolean) to service_role;
-- Unchanged from 20261024150000: restated so this block is explicit.
revoke all on function public.claim_texts(uuid, text, uuid[], boolean, boolean) from public, anon, authenticated;
grant execute on function public.claim_texts(uuid, text, uuid[], boolean, boolean) to service_role;
-- Tables: no new ones, and anon still gets nothing.
