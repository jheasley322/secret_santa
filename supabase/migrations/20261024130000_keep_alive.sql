-- Keep-alive (Joe, 2026-10-24): stop the free-tier project being paused for
-- inactivity during the Secret Santa season. Runs once a day until 2027-01-31,
-- then unschedules itself.
--
-- Supabase pauses free projects after ~7 days without activity, and activity is
-- judged by traffic through its API gateway, so a job that only touches the
-- database may not count. Each run therefore does both:
--   1. a tiny write (private.keepalive), so there's a visible record, and
--   2. an HTTP GET to this project's own Auth health endpoint via pg_net, which
--      goes through the gateway like a real visitor.
-- The publishable key below is public by design (it also ships in js/supabaseClient.js).

create extension if not exists pg_net with schema extensions;

create table private.keepalive (
  id        boolean primary key default true check (id),
  last_ping timestamptz,
  pings     integer not null default 0
);
insert into private.keepalive default values;

create function private.keep_alive() returns void
language plpgsql volatile
set search_path = ''
as $$
begin
  -- Joe: "this can end Jan 31 2027".
  if current_date > date '2027-01-31' then
    perform cron.unschedule('keep-alive');
    return;
  end if;

  update private.keepalive set last_ping = now(), pings = pings + 1 where id;

  perform net.http_get(
    url     := 'https://hnnzoiuibnikrucncphu.supabase.co/auth/v1/health',
    headers := pg_catalog.jsonb_build_object('apikey', 'sb_publishable_lSHcxZycDPN82SacwBRaAQ_D6RbVZHE')
  );
end $$;

-- Daily at 12:23 UTC (07:23 / 08:23 Eastern). Re-running replaces the job.
select cron.schedule('keep-alive', '23 12 * * *', 'select private.keep_alive()');

-- Grant block: internal only. pg_cron runs it as postgres (the owner).
revoke all on table private.keepalive from public, anon, authenticated, service_role;
revoke all on function private.keep_alive() from public, anon, authenticated, service_role;
