-- Phase 2, migration 7: dry-run bodies and the lifetime text budget.
--
-- spec "Texting -> HARD LIMITS" 1, "Texting details (Phase 2 contract) -> Where
-- the cap lives" and "-> Dry-run bodies". NOT APPLIED: waits for Joe, after
-- migrations 4-6.

-- ---------------------------------------------------------------------------
-- texts.body: the exact message, for dry-run rows only.
-- ---------------------------------------------------------------------------
-- The Elf can already read texts in their own circles (texts_elf_select), and
-- the table-level select grant covers the new column. Members never read texts.
alter table public.texts add column body text;
-- spec "Dry-run bodies": filled only for dry-run rows, null for real sends.
alter table public.texts add constraint texts_body_dry_run_only check (body is null or dry_run);

-- ---------------------------------------------------------------------------
-- private.text_budget: one row holding the lifetime cap on real sends.
-- ---------------------------------------------------------------------------
-- Joe changes it with SQL, e.g.  update private.text_budget set cap = 95;
create table private.text_budget (
  -- Single-row table: the key can only ever be true.
  id   boolean primary key default true check (id),
  cap  integer not null default 45 check (cap >= 0)
);
insert into private.text_budget default values;

-- ---------------------------------------------------------------------------
-- public.text_budget_cap(): how send-texts reads the cap through PostgREST.
-- ---------------------------------------------------------------------------
-- private is not exposed, so the Edge Function (service_role) reads the cap
-- through this function. It takes no input and returns one number.
create function public.text_budget_cap() returns integer
language sql stable security definer
set search_path = ''
as $$
  select cap from private.text_budget where id;
$$;

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
revoke all on table private.text_budget from public, anon, authenticated, service_role;
revoke all on function public.text_budget_cap() from public, anon, authenticated;
grant execute on function public.text_budget_cap() to service_role;
-- texts: unchanged (Elf select via RLS, service_role writes). Restated so this
-- migration leaves the table's grants explicit.
revoke all on public.texts from public, anon;
grant select on public.texts to authenticated;
grant select, insert, update, delete on public.texts to service_role;
