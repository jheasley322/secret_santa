-- Phase 1, migration 6: erase phone numbers 7 days after the swap date.
--
-- spec "Privacy rules" 4: numbers are erased 7 days after the swap date.
-- spec "Interface contract -> Internal": erase_old_phones() returns int, sets
-- phone = null where swap_date + 7 < current_date, returns the count, run daily
-- by pg_cron. No client grant.
--
-- SECURITY INVOKER on purpose: its only callers are postgres (pg_cron) and
-- service_role, both of which can already update members. It returns the number
-- of phones actually erased, so a second run straight away returns 0.

create function public.erase_old_phones() returns integer
language plpgsql volatile
set search_path = ''
as $$
declare
  v_erased integer;
begin
  update public.members m
     set phone = null
    from public.circles c
   where c.id = m.circle_id
     and m.phone is not null
     and c.swap_date + 7 < current_date;
  get diagnostics v_erased = row_count;
  return v_erased;
end $$;

-- Daily at 03:17 UTC. cron.schedule with a job name replaces an existing job of
-- that name, so re-running this is safe.
select cron.schedule('erase-old-phones', '17 3 * * *', 'select public.erase_old_phones()');

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Internal: no client role. service_role (and postgres, the owner) may run it.
revoke all on function public.erase_old_phones() from public, anon, authenticated;
grant execute on function public.erase_old_phones() to service_role;
