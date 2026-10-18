-- Phase 1, migration 5: the draw. start_draw, reshuffle, undo_draw.
--
-- spec "Draw rules", "Circle status", "Interface contract -> Elf RPCs",
-- "Error messages". Each RPC is one function call = one transaction: any raise
-- undoes everything it did, so a failed draw changes nothing.
--
-- Error precedence (lead decision): ownership, then status, then
-- 'need at least 3 members', then 'every list must be done before the draw',
-- then the impossible-draw message. Ownership comes first so someone else's
-- circle never leaks its status (ISO-06).

-- ---------------------------------------------------------------------------
-- private.owned_circle_status(circle): authorization for every Elf RPC.
-- ---------------------------------------------------------------------------
-- Returns the status of a circle the caller owns, row-locked FOR UPDATE so two
-- draws (or a draw and a member insert, see enforce_circle_lock) can't
-- interleave. A circle that isn't theirs or doesn't exist: 'circle not found'.
create function private.owned_circle_status(p_circle_id uuid) returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    raise exception 'circle not found';
  end if;
  select c.status into v_status
    from public.circles c
   where c.id = p_circle_id and c.elf_id = v_uid
   for update;
  if v_status is null then
    raise exception 'circle not found';
  end if;
  return v_status;
end $$;

-- ---------------------------------------------------------------------------
-- private.make_matches(circle): replace the circle's matches with a fresh draw.
-- ---------------------------------------------------------------------------
-- spec "Draw rules": no self-draw; no no-pair in either direction; one gift out
-- and one in per member; uniformly random among valid draws.
--
-- Method: shuffle, check, retry up to 1,000 times (the spec's own suggestion).
-- Each attempt is a uniformly random permutation of the receivers (sorted by a
-- fresh gen_random_uuid, which comes from the strong RNG), and an attempt is kept
-- only if it is valid. Rejection sampling from a uniform distribution is uniform
-- over what it accepts, so every valid draw, including two kids drawing each
-- other, is equally likely. Never "fix up" a collision: that biases the result.
create function private.make_matches(p_circle_id uuid) returns void
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
-- start_draw: open -> drawn
-- ---------------------------------------------------------------------------
create function public.start_draw(p_circle_id uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  -- Authorization first.
  v_status := private.owned_circle_status(p_circle_id);

  if v_status <> 'open' then
    raise exception 'names have already been drawn';
  end if;

  -- spec "Draw rules": at least 3 members (with 2, each would know their Santa).
  if (select count(*) from public.members m where m.circle_id = p_circle_id) < 3 then
    raise exception 'need at least 3 members';
  end if;

  -- spec "Draw rules": every member's list is marked done.
  if exists (select 1 from public.members m where m.circle_id = p_circle_id and not m.list_done) then
    raise exception 'every list must be done before the draw';
  end if;

  perform private.make_matches(p_circle_id);

  update public.circles set status = 'drawn' where id = p_circle_id;
end $$;

-- ---------------------------------------------------------------------------
-- reshuffle: drawn -> drawn, new matches
-- ---------------------------------------------------------------------------
-- spec "Reshuffle": only until the names are sent. List-done is not re-checked:
-- lists stay editable after the draw, and a kid un-ticking "I'm done" must not
-- stop the Elf from shuffling. Membership can't have changed (the lock).
create function public.reshuffle(p_circle_id uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  -- Authorization first.
  v_status := private.owned_circle_status(p_circle_id);

  if v_status = 'open' then
    raise exception 'names have not been drawn yet';
  elsif v_status = 'sent' then
    raise exception 'names have already been sent';
  end if;

  perform private.make_matches(p_circle_id);
end $$;

-- ---------------------------------------------------------------------------
-- undo_draw: drawn -> open, matches deleted
-- ---------------------------------------------------------------------------
create function public.undo_draw(p_circle_id uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  -- Authorization first.
  v_status := private.owned_circle_status(p_circle_id);

  if v_status = 'open' then
    raise exception 'names have not been drawn yet';
  elsif v_status = 'sent' then
    raise exception 'names have already been sent';
  end if;

  delete from public.matches where circle_id = p_circle_id;
  update public.circles set status = 'open' where id = p_circle_id;
end $$;

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
revoke all on function private.owned_circle_status(uuid) from public, anon, authenticated;
revoke all on function private.make_matches(uuid)        from public, anon, authenticated;
revoke all on function public.start_draw(uuid)           from public, anon, authenticated;
revoke all on function public.reshuffle(uuid)            from public, anon, authenticated;
revoke all on function public.undo_draw(uuid)            from public, anon, authenticated;

-- Elf RPCs: signed-in Elfs only. Ownership is checked inside.
grant execute on function public.start_draw(uuid) to authenticated;
grant execute on function public.reshuffle(uuid)  to authenticated;
grant execute on function public.undo_draw(uuid)  to authenticated;
