-- Phase 1, migration 2: the six tables, their constraints, RLS and table grants.
--
-- spec "Data model", "Interface contract -> Constraints",
-- "Interface contract -> Elf direct table access (RLS)", "Access rules".
--
-- How "not client-writable" is enforced (spec: status, elf_id, token): the Elf role
-- gets INSERT/UPDATE only on the named columns that are writable. Writing status,
-- elf_id or token as `authenticated` is a permission error, so the value can never
-- change. RPCs (SECURITY DEFINER, owned by postgres) and the Edge Function
-- (service_role) are not limited by those column grants.

-- ---------------------------------------------------------------------------
-- circles
-- ---------------------------------------------------------------------------
create table public.circles (
  id          uuid primary key default gen_random_uuid(),
  -- spec "Interface contract": elf_id defaults to auth.uid().
  elf_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  -- spec "Constraints": budget >= 0 (whole dollars, nullable).
  budget      integer check (budget >= 0),
  swap_date   date,
  swap_place  text check (char_length(swap_place) between 1 and 200),
  -- spec "Circle status": open -> drawn -> sent.
  status      text not null default 'open' check (status in ('open', 'drawn', 'sent')),
  created_at  timestamptz not null default now()
);
create index circles_elf_id_idx on public.circles (elf_id);

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
-- spec "Privacy rules" 3: first name + phone and the About me fields, nothing else.
create table public.members (
  id          uuid primary key default gen_random_uuid(),
  circle_id   uuid not null references public.circles (id) on delete cascade,
  -- spec "Constraints": trimmed, 1-40 chars. The tidy trigger trims; the check
  -- refuses anything that still is not trimmed (CON-03).
  first_name  text not null check (char_length(first_name) between 1 and 40
                                   and first_name = btrim(first_name)),
  -- spec "Constraints": null or E.164. Erased 7 days after the swap (erase_old_phones).
  phone       text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- spec "Data model": 32 random bytes, base64url, no padding = 43 chars. Inline
  -- expression (not a private helper) because it runs as the inserting Elf.
  token       text not null unique
              default translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')
              check (token ~ '^[A-Za-z0-9_-]{43}$'),
  -- spec "Interface contract -> save_my_list": About me fields are <= 200 chars.
  fav_color   text check (char_length(fav_color) <= 200),
  fav_snack   text check (char_length(fav_snack) <= 200),
  sizes       text check (char_length(sizes)     <= 200),
  please_no   text check (char_length(please_no) <= 200),
  list_done   boolean not null default false,
  created_at  timestamptz not null default now(),
  -- Target for the composite foreign keys below: a no-pair or match can only
  -- name members of its own circle (CON-14, CON-16).
  unique (circle_id, id)
);
-- spec "Constraints": first_name unique per circle, case-insensitively.
create unique index members_circle_first_name_key on public.members (circle_id, lower(first_name));

-- ---------------------------------------------------------------------------
-- wish_items
-- ---------------------------------------------------------------------------
create table public.wish_items (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references public.members (id) on delete cascade,
  text       text not null check (char_length(text) between 1 and 200 and text = btrim(text)),
  -- spec "Data model": url nullable, http/https only (also at the table, CON-18),
  -- so a javascript: or data: link can't be planted even by a direct Elf insert.
  url        text check (char_length(url) <= 500 and url ~* '^https?://[^[:space:]/?#]+[^[:space:]]*$'),
  -- spec "save_my_list": position = array index from 0, at most 10 items.
  position   integer not null check (position between 0 and 9),
  unique (member_id, position)
);

-- ---------------------------------------------------------------------------
-- no_pairs
-- ---------------------------------------------------------------------------
create table public.no_pairs (
  circle_id  uuid not null references public.circles (id) on delete cascade,
  member_a   uuid not null,
  member_b   uuid not null,
  -- spec "Data model": stored with a < b; unique per circle.
  primary key (circle_id, member_a, member_b),
  check (member_a < member_b),
  -- spec "Constraints": both in the same circle.
  foreign key (circle_id, member_a) references public.members (circle_id, id) on delete cascade,
  foreign key (circle_id, member_b) references public.members (circle_id, id) on delete cascade
);
create index no_pairs_circle_member_b_idx on public.no_pairs (circle_id, member_b);

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------
create table public.matches (
  circle_id    uuid not null references public.circles (id) on delete cascade,
  -- spec "Draw rules": each member gives exactly once and receives exactly once.
  giver_id     uuid primary key,
  receiver_id  uuid not null unique,
  opened_at    timestamptz,
  -- spec "Draw rules": nobody draws themselves.
  check (giver_id <> receiver_id),
  -- spec "Constraints": giver and receiver are in the match's circle.
  foreign key (circle_id, giver_id)    references public.members (circle_id, id) on delete cascade,
  foreign key (circle_id, receiver_id) references public.members (circle_id, id) on delete cascade
);
create index matches_circle_giver_idx    on public.matches (circle_id, giver_id);
create index matches_circle_receiver_idx on public.matches (circle_id, receiver_id);

-- ---------------------------------------------------------------------------
-- texts
-- ---------------------------------------------------------------------------
create table public.texts (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.members (id) on delete cascade,
  kind         text not null check (kind in ('invite', 'reveal')),
  status       text not null check (status in ('sent', 'failed')),
  provider_id  text,
  error        text,
  -- spec "Texting -> HARD LIMITS" 1: the lifetime cap counts every row with
  -- dry_run = false, failed sends included. Default false = fail closed: a row
  -- that doesn't say it was a dry run is counted as a real (paid) send.
  dry_run          boolean not null default false,
  -- spec "HARD LIMITS" 1: Textbelt's quotaRemaining after each real send.
  -- No check constraint: a log row must never fail to insert.
  quota_remaining  integer,
  created_at   timestamptz not null default now()
);
-- spec "Texting": rate limit counts texts per member per hour.
create index texts_member_created_idx on public.texts (member_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- spec "Access rules -> Elf": auth.uid() = circles.elf_id. Policies are for
-- `authenticated` only; anon has no grants at all, and service_role bypasses RLS.
-- auth.uid() is wrapped in a scalar subquery so it is evaluated once per statement.
alter table public.circles    enable row level security;
alter table public.members    enable row level security;
alter table public.wish_items enable row level security;
alter table public.no_pairs   enable row level security;
alter table public.matches    enable row level security;
alter table public.texts      enable row level security;

-- circles: insert / select / update / delete their own. The column grants decide
-- which commands and columns are possible; this decides which rows.
create policy circles_elf_all on public.circles
  for all to authenticated
  using      (elf_id = (select auth.uid()))
  with check (elf_id = (select auth.uid()));

-- members: full access in their own circles (insert/delete are further limited
-- by the lock trigger in the next migration).
create policy members_elf_all on public.members
  for all to authenticated
  using      (exists (select 1 from public.circles c
                       where c.id = members.circle_id and c.elf_id = (select auth.uid())))
  with check (exists (select 1 from public.circles c
                       where c.id = members.circle_id and c.elf_id = (select auth.uid())));

-- wish_items: full access in their own circles.
create policy wish_items_elf_all on public.wish_items
  for all to authenticated
  using      (exists (select 1 from public.members m join public.circles c on c.id = m.circle_id
                       where m.id = wish_items.member_id and c.elf_id = (select auth.uid())))
  with check (exists (select 1 from public.members m join public.circles c on c.id = m.circle_id
                       where m.id = wish_items.member_id and c.elf_id = (select auth.uid())));

-- no_pairs: insert / select / delete (no update) in their own circles.
create policy no_pairs_elf_select on public.no_pairs
  for select to authenticated
  using (exists (select 1 from public.circles c
                  where c.id = no_pairs.circle_id and c.elf_id = (select auth.uid())));
create policy no_pairs_elf_insert on public.no_pairs
  for insert to authenticated
  with check (exists (select 1 from public.circles c
                       where c.id = no_pairs.circle_id and c.elf_id = (select auth.uid())));
create policy no_pairs_elf_delete on public.no_pairs
  for delete to authenticated
  using (exists (select 1 from public.circles c
                  where c.id = no_pairs.circle_id and c.elf_id = (select auth.uid())));

-- matches: select only. spec "Privacy rules" 2: only the Elf sees all matches.
create policy matches_elf_select on public.matches
  for select to authenticated
  using (exists (select 1 from public.circles c
                  where c.id = matches.circle_id and c.elf_id = (select auth.uid())));

-- texts: select only (the Edge Function writes them with the service role).
create policy texts_elf_select on public.texts
  for select to authenticated
  using (exists (select 1 from public.members m join public.circles c on c.id = m.circle_id
                  where m.id = texts.member_id and c.elf_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Start from nothing for every client role, then grant back exactly what the
-- spec's "Elf direct table access" lists. anon gets nothing (CLAUDE.md rule 4).
revoke all on public.circles, public.members, public.wish_items,
              public.no_pairs, public.matches, public.texts
  from public, anon, authenticated;

-- circles: status and elf_id are not client-writable.
grant select, delete on public.circles to authenticated;
grant insert (name, budget, swap_date, swap_place) on public.circles to authenticated;
grant update (name, budget, swap_date, swap_place) on public.circles to authenticated;

-- members: token is not client-writable; circle_id is fixed after insert so a
-- member can't be moved between circles (which would dodge the post-draw lock).
grant select, delete on public.members to authenticated;
grant insert (circle_id, first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;
grant update (first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;

-- wish_items: full access; an item stays with the member it was created for.
grant select, delete on public.wish_items to authenticated;
grant insert (member_id, text, url, position) on public.wish_items to authenticated;
grant update (text, url, position)            on public.wish_items to authenticated;

-- no_pairs: insert / select / delete.
grant select, insert, delete on public.no_pairs to authenticated;

-- matches and texts: read-only for the Elf.
grant select on public.matches, public.texts to authenticated;

-- service_role is the send-texts Edge Function (spec "Texting"): reads names,
-- numbers and matches, writes texts, moves drawn -> sent.
grant select, insert, update, delete on public.circles, public.members, public.wish_items,
                                        public.no_pairs, public.matches, public.texts
  to service_role;
