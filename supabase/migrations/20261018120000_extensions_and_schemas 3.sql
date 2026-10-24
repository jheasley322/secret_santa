-- Phase 1, migration 1: extensions, the private helper schema, default privileges.
--
-- spec "Stack": Supabase Postgres. pgcrypto gives gen_random_bytes for member tokens
-- (spec "Data model": token = 32 random bytes, base64url). pgtap is the test harness
-- (CLAUDE.md rule 10). pg_cron runs erase_old_phones daily (spec "Privacy rules" 4).
--
-- The anon/authenticated usage on the extensions schema is deliberately left alone:
-- the pgTAP runner asserts as those roles, and the token default calls
-- extensions.gen_random_bytes as the inserting Elf.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgtap    with schema extensions;
-- Supabase's documented install location for pg_cron.
create extension if not exists pg_cron  with schema pg_catalog;

-- Internal helpers (draw engine, trigger functions, JSON builders) live here, not in
-- public, so PostgREST never exposes them as RPCs. Nobody but the owner gets usage.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- CLAUDE.md rule 4: anon gets nothing on tables. Supabase's default ACL auto-grants
-- every new public table, sequence and function to anon (and functions to PUBLIC).
-- Stop that for objects this role creates, so a table added later starts closed
-- instead of open. Every migration still ends with its own explicit grant block.
alter default privileges for role postgres in schema public revoke all on tables    from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- No tables or functions yet. The private schema is closed to every client role
-- (revoked above); only postgres / service_role-owned code reaches it via
-- SECURITY DEFINER functions defined later.
revoke all on schema private from public, anon, authenticated;
