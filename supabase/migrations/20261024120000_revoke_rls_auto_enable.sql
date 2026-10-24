-- Security audit 2026-10-24, finding 5 / spec "Security hardening" S5.
--
-- public.rls_auto_enable() is Supabase's event-trigger function (it backs the
-- ensure_rls trigger that turns RLS on for new public tables). It was executable
-- by anon and authenticated and reachable at /rest/v1/rpc/rls_auto_enable.
-- Harmless in practice, but nothing outside the event trigger should call it.
-- Event triggers don't check EXECUTE on their function, so ensure_rls keeps working.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
