-- Hardening, migration 1 of 2: a swap date and a US phone number are required.
--
-- spec "Texting details -> Decisions from Joe (2026-10-24)" 5 and 7,
-- "Security hardening" S2 and S3, "Lead decisions on the S1-S3 contract".
--
-- Live data checked before applying (2026-10-24): every circle has a swap date,
-- every member has a +1 number, there are 0 texts. Nothing here rewrites rows.

-- ---------------------------------------------------------------------------
-- circles.swap_date is required.
-- ---------------------------------------------------------------------------
-- Decision 7: every circle must have a swap date, so erase_old_phones() reaches
-- every phone number eventually (ERASE-08). The Elf can still change it in any
-- status: the column stays in the Elf's insert/update column grants.
alter table public.circles alter column swap_date set not null;

-- ---------------------------------------------------------------------------
-- members.phone: US only.
-- ---------------------------------------------------------------------------
-- spec S2 / lead decision: ^\+1[0-9]{10}$. Null stays legal at the check, because
-- erasure nulls it; the trigger below decides who may set null and when.
alter table public.members drop constraint members_phone_check;
alter table public.members add constraint members_phone_check
  check (phone is null or phone ~ '^\+1[0-9]{10}$');

-- ---------------------------------------------------------------------------
-- A phone is required when a member is added, and the Elf can't clear one.
-- ---------------------------------------------------------------------------
-- Decision 5: "A phone number is required when adding a member." A plain check
-- can't tell insert from update, so this is a BEFORE trigger.
-- Lead decision: the Elf (authenticated) also can't update a phone to null; only
-- erasure can (erase_old_phones() runs as postgres from pg_cron, or as
-- service_role). Allow-list of roles, so an unexpected role fails closed.
--
-- SECURITY INVOKER on purpose: current_user must be the caller's role, not the
-- function owner. SECURITY DEFINER RPCs (save_my_list etc.) run as postgres and
-- never touch phone anyway.
create function private.members_phone_required() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.phone is null then
      raise exception 'phone number required';
    end if;
  elsif new.phone is null and old.phone is not null
        and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'phone number required';
  end if;
  return new;
end $$;

create trigger members_phone_required
  before insert or update of phone on public.members
  for each row execute function private.members_phone_required();

-- ---------------------------------------------------------------------------
-- texts.status gains 'pending'.
-- ---------------------------------------------------------------------------
-- spec S3: a pending row is written under the circle lock before the provider is
-- called, then updated to sent / failed (CON-19, CON-22).
alter table public.texts drop constraint texts_status_check;
alter table public.texts add constraint texts_status_check
  check (status in ('pending', 'sent', 'failed'));

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Internal trigger function: nobody (triggers fire without an EXECUTE check).
revoke all on function private.members_phone_required() from public, anon, authenticated;
-- Table grants are unchanged by this migration; restated so it ends explicit.
revoke all on public.circles, public.members, public.texts from public, anon;
grant select, delete on public.circles to authenticated;
grant insert (name, budget, swap_date, swap_place) on public.circles to authenticated;
grant update (name, budget, swap_date, swap_place) on public.circles to authenticated;
grant select, delete on public.members to authenticated;
grant insert (circle_id, first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;
grant update (first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;
grant select on public.texts to authenticated;
grant select, insert, update, delete on public.circles, public.members, public.texts to service_role;
