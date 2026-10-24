-- Phase 1, migration 3: tidy-on-write triggers and the post-draw lock.
--
-- Trigger functions live in `private` (never exposed as RPCs) and are SECURITY
-- DEFINER so they read the real circle status regardless of the caller's RLS
-- view. search_path = '' and fully qualified names throughout.

-- ---------------------------------------------------------------------------
-- private.tidy(text): trim surrounding whitespace; empty becomes null.
-- ---------------------------------------------------------------------------
-- Lead decision: an empty or whitespace-only optional field is stored as null.
create function private.tidy(p text) returns text
language sql immutable
set search_path = ''
as $$
  select nullif(pg_catalog.regexp_replace(p, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
$$;

-- ---------------------------------------------------------------------------
-- circles: trim name and place.
-- ---------------------------------------------------------------------------
create function private.circles_tidy() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- An all-whitespace name becomes null and is refused by NOT NULL.
  new.name       := private.tidy(new.name);
  new.swap_place := private.tidy(new.swap_place);
  return new;
end $$;

create trigger circles_tidy
  before insert or update on public.circles
  for each row execute function private.circles_tidy();

-- ---------------------------------------------------------------------------
-- members: trim first_name (spec "Constraints": trimmed, CON-03) and About me.
-- ---------------------------------------------------------------------------
-- phone is deliberately left alone: '' is not a valid phone and must be rejected
-- (CON-07), not quietly turned into "no phone".
create function private.members_tidy() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.first_name := private.tidy(new.first_name);
  new.fav_color  := private.tidy(new.fav_color);
  new.fav_snack  := private.tidy(new.fav_snack);
  new.sizes      := private.tidy(new.sizes);
  new.please_no  := private.tidy(new.please_no);
  return new;
end $$;

create trigger members_tidy
  before insert or update on public.members
  for each row execute function private.members_tidy();

-- ---------------------------------------------------------------------------
-- The lock. spec "Circle status": in drawn (and sent) members can't be added or
-- removed, and do-not-pair rules can't be changed.
-- ---------------------------------------------------------------------------
-- Applies to every role, including the RPCs and service_role. Lead decision: the
-- Elf may still edit a member's name and phone in any status, so plain UPDATEs of
-- members are not locked; only a change of circle_id (a move) is.
--
-- Deleting a whole circle must still work in any status (ELF-16): the cascade
-- deletes the circle row first, so by the time it reaches members / no_pairs the
-- circle is no longer visible and there is nothing left to protect.
--
-- FOR SHARE: a member insert racing start_draw waits for the draw to commit and
-- then sees 'drawn', so a member can never slip in without a match.
create function private.enforce_circle_lock() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_circle_ids uuid[];
  v_locked     boolean;
begin
  if tg_op = 'INSERT' then
    v_circle_ids := array[new.circle_id];
  elsif tg_op = 'DELETE' then
    v_circle_ids := array[old.circle_id];
  else
    -- UPDATE: no_pairs rows are never updated by clients, but a direct update
    -- is a remove + add, so lock both sides. For members only a move counts.
    if tg_table_name = 'members' and new.circle_id is not distinct from old.circle_id then
      return new;
    end if;
    v_circle_ids := array[old.circle_id, new.circle_id];
  end if;

  select pg_catalog.bool_or(c.status <> 'open') into v_locked
    from (select c.status from public.circles c
           where c.id = any (v_circle_ids)
           for share) c;

  if coalesce(v_locked, false) then
    raise exception 'circle is locked after the draw';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger members_lock
  before insert or update or delete on public.members
  for each row execute function private.enforce_circle_lock();

create trigger no_pairs_lock
  before insert or update or delete on public.no_pairs
  for each row execute function private.enforce_circle_lock();

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Internal helpers: nobody. Triggers fire without an EXECUTE check, and
-- private.tidy is reached only from SECURITY DEFINER code owned by postgres.
revoke all on function private.tidy(text)               from public, anon, authenticated;
revoke all on function private.circles_tidy()           from public, anon, authenticated;
revoke all on function private.members_tidy()           from public, anon, authenticated;
revoke all on function private.enforce_circle_lock()    from public, anon, authenticated;
