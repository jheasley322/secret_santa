# Cloud run report: Phase 2 (Elf pages + texting)

Branch `phase-1-2`, 2026-10-18. Nothing was deployed or applied, no text was sent, and the live
database was never touched. No Supabase connector was used.

## What was built

**Tests (test-author)**
- Deno, `supabase/functions/send-texts/`: the handler suite now has ST-35..40: a junk
  `TEXTS_DRY_RUN` stays dry run, an empty batch, a reveal to a kid with no phone, the batch rate
  limit, invites refused after `sent`, and a check that only `index.ts` touches env, fetch,
  supabase-js or Textbelt. A new `provider_test.ts` (PROV-01..05) covers the Textbelt call
  through an injected fake `fetch`. The whole suite runs with `--deny-net --deny-env`.
- pgTAP `tests/sql/60_texting_schema.sql` (TXB-01..09): `texts.body`, `private.text_budget`
  (cap default 45, one row, no client access), body allowed on dry-run rows only, and the
  service-role-only `text_budget_cap()`.
- Playwright `tests/e2e/elf.spec.js` (E2E-ELF-01..11) plus config, a static server and global
  setup/teardown. Real sends can't happen: `TEXTS_DRY_RUN=true` is forced, every page
  route-stubs `**/functions/v1/send-texts` (the stub writes `dry_run = true` rows), and
  `textbelt.com` is aborted.
- `tests/SCENARIOS.md` Phase 2 section updated with the new IDs, the interface contract and the
  open questions.

**Backend (backend-engineer)**
- `supabase/functions/_shared/messages.js` is the message builder. Every text is at most 160
  GSM-7 septets with no emoji. Quotes and dashes are straightened, names are shortened with
  `...`, and the link is always whole. Example:
  `Secret Santa! Maya, you drew Ava! $20, Dec 19. Their list: <link>`
- `send-texts/core.ts` holds the pure rules:
  - Safe defaults: a missing setting means dry run, and links are not approved.
  - The lifetime cap counts real rows, failed ones included.
  - Sending stops once `quotaRemaining` is at or below 5.
  - Rate limit: 3 per member per hour.
  - Recipients: invites skip kids already invited (by a real invite) and kids with no phone.
- `send-texts/handler.ts` runs the checks in the spec's order: auth, ownership, status, cap,
  links, rate. A whole-circle reveal locks to `sent` before the first text and never rolls back.
  Dry-run rows store the body.
- `send-texts/provider.ts` is Textbelt in one function. The key is never returned.
- `send-texts/index.ts` reads the env and wires up supabase-js:
  - It checks the Elf's JWT and reads the circle with the Elf's own client (RLS) before the
    service-role client exists.
  - With real sends on but no `TEXTBELT_KEY`, it refuses with 503 instead of logging fake
    failed rows that would use up the cap.
- **New migration** `20261018120600_texting_budget.sql` (NOT applied) adds:
  - `texts.body` with a check that only dry-run rows may have one
  - `private.text_budget` (single row, `cap` default 45)
  - `public.text_budget_cap()`, executable by `service_role` only

**Frontend (frontend-builder)** follows the approved Elf workshop mock:
- `index.html`: magic-link sign-in, my circles, and start a circle.
- `circle.html`:
  - Details, editable at any time.
  - Kids with their mobile number, and a progress checklist reading "X of Y done".
  - Send invites, plus Re-send / Copy link / Remove on each kid.
  - Each kid's text status comes from the `texts` table. Dry runs show "Text sent (practice run)".
  - Another Elf's circle shows "Circle not found".
- Shared modules: `js/supabaseClient.js` (pinned `supabase-js@2.118.0` from jsDelivr, with the key
  left as the placeholder `PASTE_PUBLISHABLE_KEY_HERE`), `auth.js`, `phone.js`, `links.js`,
  `escape.js`, `format.js` and `ui.js` (textContent only).
- No draw/reveal UI; that's Phase 4.

## Test results

| Suite | Result | Notes |
|---|---|---|
| Vitest (`npm run test:unit`) | **114 / 114** | MSG, PH, ESC, LINK |
| Deno (`npm run test:deno`) | **65 / 65** | core, handler, provider; net and env denied |
| pgTAP (`npm run test:sql`) | **362 / 362** (13 files) | Run against a **throwaway local** `supabase/postgres` Docker container with migrations 1–7 applied, **not** the live project. The container has been removed. |
| Playwright (`npm run test:e2e`) | **not run** (11 tests listed) | Needs the live project, the publishable key and test Elf logins. A local smoke run of the same flows against a fake supabase-js passed 17/17 checks, including no horizontal scroll at 375px. |
| Secrets sweep | clean | Only `.env.example` is tracked; no key-shaped strings. |
| Dry-run sweep | clean | Forced in `playwright.config.js` and `vitest.config.js`; the Deno tests pass env explicitly with `--deny-env`. |

## What couldn't run here, and why
- **pgTAP against the live project:** no `.env`, and touching the live DB was off limits. The
  local container run is strong evidence, but it isn't the real project.
- **Playwright:** needs the live database, the publishable key and two test Elf accounts.
- **Edge Function deployment and real texts:** off limits by design.
- **security-auditor pass:** not run as a separate agent, because that agent's tools reach the
  live DB. Points for it to push on are listed under the open questions below.
- **doc-writer (README, /help/):** not done in this run. qa-gate requires it before Phase 2 can
  pass.

## Open questions for Joe
1. **Does a dry-run invite count as "already invited"?** Built: **no**, so practice runs don't
   make the first real Send invites skip everyone.
2. **Does the cap apply in dry run?** Built: **no**; dry runs never cost credit. **Does the rate
   limit apply in dry run?** Built: **yes**, so it can be tested for free.
3. **A rate-limited kid in a whole-circle batch** is skipped and reported, and the rest still go.
   OK?
4. **Reveal wording:** `Secret Santa! Maya, you drew Ava! $20, Dec 19. Their list: <link>`. The
   details are kept short so long names still fit in one credit. OK?
5. **Phone is required** when adding a kid. Should it be optional, e.g. for a kid who's reached
   through a parent's phone?
6. **The e2e suite needs two test Elf accounts.** An automated setup that inserted users straight
   into `auth.users` was blocked as too risky. Instead, please create two users by hand in the
   dashboard (auto-confirm on), with emails ending `@secret-santa-e2e.invalid`. Put their
   credentials in `.env` as `E2E_ELF_A_EMAIL/PASSWORD` and `E2E_ELF_B_EMAIL/PASSWORD`.
7. **Two simultaneous requests could each pass the cap check before either logs a row** (a race).
   With one Elf this is unlikely and costs at most one batch. A database-side reservation would
   close it. Do you want that?

## Next steps once Joe is back
1. **Review and apply migrations 4, 5, 6, then 7** (`20261018120600_texting_budget.sql`) to
   `hnnzoiuibnikrucncphu`, then run `npm run test:sql` against the live project (expect 362/362).
2. **Paste the publishable key** into `js/supabaseClient.js`, replacing
   `PASTE_PUBLISHABLE_KEY_HERE`.
3. **Supabase Auth → URL Configuration:** set the Site URL to
   `https://jheasley322.github.io/secret_santa/`, and add redirect URLs for
   `https://jheasley322.github.io/secret_santa/index.html` and, for local testing,
   `http://127.0.0.1:8787/index.html`.
4. **Deploy the function in dry-run mode:**
   `supabase functions deploy send-texts --project-ref hnnzoiuibnikrucncphu`. Set
   `APP_BASE_URL=https://jheasley322.github.io/secret_santa` and leave `TEXTS_DRY_RUN` unset
   (unset means dry run). Leave `TEXT_LINKS_APPROVED` unset as well. Then try Send invites; the
   rows should show "Text sent (practice run)", with bodies in `texts.body`.
5. **Create the two e2e Elf users** (open question 6), then run
   `npx playwright install chromium` and `npm run test:e2e`.
6. **Run doc-writer** (README + `/help/`) and a **security-auditor** pass, then qa-gate for the
   Phase 2 sign-off.
7. **Later (Phase 5, Joe only):**
   - Buy Textbelt credit and run `supabase secrets set TEXTBELT_KEY=…`.
   - Get the URL whitelist approved, then set `TEXT_LINKS_APPROVED=true`.
   - Set `TEXTS_DRY_RUN=false`.
   - Send one real test text to your own phone.
