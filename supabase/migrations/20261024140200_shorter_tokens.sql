-- Shorter member links: 16-character tokens.
--
-- spec "Data model" (members.token: 12 random bytes, 96 bits, base64url = exactly
-- 16 chars, no padding) and "Lead decisions -> Shorter links (Joe, 2026-10-24)":
-- existing members get new tokens in this same migration. Safe only because
-- nobody has been texted yet (0 rows in texts on 2026-10-24); once real texts go
-- out, tokens must never be reissued.
--
-- 12 bytes encode to exactly 16 base64 characters with no '=' padding, so the
-- translate() only swaps + and / for the URL-safe - and _.

-- Drop the old 43-character check first, so the reissue can write 16-char values.
alter table public.members drop constraint members_token_check;

alter table public.members alter column token
  set default translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_');

-- Reissue every existing token. Only `token` changes: the lock trigger fires only
-- on a circle move, and the phone trigger only on `update of phone`.
update public.members
   set token = translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_');

alter table public.members add constraint members_token_check
  check (token ~ '^[A-Za-z0-9_-]{16}$');

-- ---------------------------------------------------------------------------
-- Grant block
-- ---------------------------------------------------------------------------
-- Unchanged: token stays out of the Elf's insert/update column grants (not
-- client-writable), anon gets nothing. Restated so this migration ends explicit.
revoke all on public.members from public, anon;
revoke insert, update on public.members from authenticated;
grant select, delete on public.members to authenticated;
grant insert (circle_id, first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;
grant update (first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
  on public.members to authenticated;
grant select, insert, update, delete on public.members to service_role;
