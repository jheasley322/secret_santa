# Secret Santa

A tiny Secret Santa web app for a group of kids. An adult (the **Elf**) creates a **circle**, adds kids by first name and mobile number, and the app texts each kid a private link to fill in a wish list. When every list is done the Elf draws names in the database, and the app texts each kid who they drew.

This file is for whoever maintains the code. Help pages for the families are in `help/` (start at `help/index.html`).

The spec is `.zReference/original_specs.md` and it beats the code if they disagree. The phase order is in `.zReference/master_plan.md`.

## Status / what's not done yet

Written as of the end of Phase 1 and most of Phase 2 (branch `phase-1-2`).

| Area | State |
|---|---|
| Database (tables, RLS, member and Elf RPCs, draw logic, phone erasure) | Built. Migrations 1-7 are applied to the live project. |
| Elf pages: sign-in, my circles, circle dashboard (add kids, progress, Send invites, Re-send, Copy link, Remove, edit details) | Built. Not published, not yet tried against the live project. |
| `send-texts` Edge Function | Written and unit-tested. **Not deployed.** |
| Member page (`/m/#token`) | **Not built** (Phase 3). Invite links point at it, so they lead nowhere yet. |
| Draw, Shuffle again, Undo, Show matches, Send the names, do-not-pair screen, delivery and "opened" tracking in the UI | **Not built** (Phase 4). The database functions `start_draw`, `reshuffle` and `undo_draw` exist and are tested. There is no button for them yet. |
| Publishable key in `js/supabaseClient.js` | Still the placeholder `PASTE_PUBLISHABLE_KEY_HERE`. The Elf pages show a "Setup needed" notice until Joe pastes it. |
| Supabase Auth redirect URLs | Not set. Magic links won't work until they are. |
| Site published | No. |
| Textbelt key in Supabase secrets | Not set (Joe only). |
| Textbelt URL whitelist for `jheasley322.github.io` | Requested, approval pending. |
| Playwright e2e | Written (11 tests), **not run yet**. Needs the key and two test Elf users (see Tests). |
| Security audit and Phase 2 QA gate | Not run yet. |

Test results at the time of writing: pgTAP 362 assertions in 13 files passed against the live project; Vitest 114/114; the Deno suite exists for `send-texts` (65 tests passed in the cloud run).

## Architecture, and why there is no server

```
Browser (static HTML + ES modules + one CSS file)
   |  supabase-js (pinned CDN version)
   v
Supabase
   - Postgres: tables + row-level security (RLS) + SECURITY DEFINER functions (RPCs)
   - Auth: email magic link, for the Elf only
   - Edge Function send-texts (Deno): the only server code. Sends SMS through Textbelt.
   - pg_cron: erases old phone numbers daily
```

There is no app server and no build step. The pages are plain files that any static host can serve (GitHub Pages or Netlify). The database is the only security boundary: the browser holds a public key, and everything it may do is decided by RLS policies and functions in Postgres. That is why the front end can be dumb and static. The one thing the browser can't be trusted with is the texting key and the lifetime text cap, so those live in the Edge Function.

Files:

- `index.html`, `circle.html`: Elf pages. `js/` has one module per concern (`auth.js`, `phone.js`, `links.js`, `escape.js`, `format.js`, `ui.js`, `supabaseClient.js`, and a script per page). Everything shown is set with `textContent`, never `innerHTML`.
- `css/styles.css`: the one stylesheet ("Elf workshop" look). `design/preview.html` is a style preview. `fonts/` and `img/` are self-hosted.
- `help/`: static help pages for parents and kids.
- `supabase/migrations/`: the schema. `supabase/functions/send-texts/`: the Edge Function. `supabase/functions/_shared/messages.js`: the text message builder.
- `tests/`: all test suites. `tests/SCENARIOS.md` lists every scenario by ID.

## Privacy model: who can see what, and where it's enforced

All of this is enforced in Postgres. Hiding something on a page is never the protection.

| Who | Can see | How |
|---|---|---|
| Nobody signed in (`anon` role) | Nothing in the tables | `anon` has no table grants. Tested in `tests/sql/20_anon.sql`. |
| A kid (member) | Their circle's details, every kid's first name and wish list, and their own match, only once the circle is `sent` | Only through `member_view(token)`. It never returns phone numbers, tokens, other matches or do-not-pair data. |
| The Elf | Their own circles, kids (including phone numbers and tokens), wish lists, matches and text history | RLS policies: `auth.uid() = circles.elf_id`. Matches and texts are read-only. |
| Another Elf | Nothing of someone else's circle | Same RLS. The circle page shows "Circle not found". |
| The Edge Function | Names, numbers and matches, to send texts | Service-role client, created only after the caller's JWT and circle ownership are checked. |

Rules to keep in mind:

- Wish lists are public inside a circle. Matches are private to the giver and the Elf.
- Collected about a kid: first name and phone number. Nothing else.
- Phone numbers are never shown to kids (not even their own) and are erased 7 days after the swap date.
- `circles.status` and `circles.elf_id` can't be written by the browser. Status only changes through the draw functions and the Edge Function.
- Every SECURITY DEFINER function sets `search_path` explicitly.

## Token model

Kids have no accounts. Each member row has a `token` (32 random bytes, base64url) generated by the database. The member link is `<APP_BASE_URL>/m/#<token>`.

- The token is the kid's only credential. It is a bearer secret, like a password in a link.
- It sits in the URL fragment (after `#`), so browsers don't send it to the server and it stays out of access logs.
- Kids use it only by calling the member functions (`member_view`, `save_my_list`, `set_list_done`). An unknown or malformed token returns the generic error `link not found`.
- The token is stored in plain text so the Elf can re-send the same link. Only the owning Elf can read it (RLS). Copy link and Re-send both use the same link, so an old text keeps working.
- Pages that handle links carry `<meta name="referrer" content="no-referrer">`.

## Local setup

You need Node 20+ (for Vitest, Playwright and the pgTAP runner) and, for the Edge Function tests, [Deno](https://deno.com). The site itself needs neither.

```sh
npm install
cp .env.example .env     # then fill in; .env is gitignored
```

Variables for `.env` (names only, never commit values):

| Variable | Used by | Where to get it |
|---|---|---|
| `SUPABASE_DB_URL` | `npm run test:sql` (and the e2e setup) | Dashboard, Connect, **Session pooler** (port 5432) or Direct. The runner refuses the transaction pooler (port 6543). Listed in `.env.example`. |
| `SUPABASE_PUBLISHABLE_KEY` | `npm run test:e2e` | Dashboard, Project Settings, API Keys. (Not yet in `.env.example`.) |
| `E2E_ELF_A_EMAIL`, `E2E_ELF_A_PASSWORD`, `E2E_ELF_B_EMAIL`, `E2E_ELF_B_PASSWORD` | `npm run test:e2e` | Two test users you create by hand (see Tests). (Not yet in `.env.example`.) |

Joe keeps a personal copy of the Textbelt key in his local `.env`. **No script, test or tool in this repo reads, loads or uses it.** The test env loader (`tests/tools/env.mjs`) only reads the names it is asked for and refuses any name containing `TEXTBELT`, `SERVICE_ROLE` or `SECRET`. The real Textbelt key belongs in Supabase secrets (see Texting).

To look at the site locally, serve the folder with any static server, for example `npx http-server -p 8787 .` and open `http://127.0.0.1:8787/`. Before sign-in works you need the publishable key in `js/supabaseClient.js` and the redirect URL set (see Deploying).

## Migrations

All in `supabase/migrations/`, applied in order:

1. `..120000_extensions_and_schemas.sql`: extensions (pgcrypto, pgtap, pg_cron) and the `private` schema
2. `..120100_tables_and_rls.sql`: tables, constraints, RLS, grants
3. `..120200_triggers.sql`: tidy-on-write triggers and the post-draw lock
4. `..120300_member_rpcs.sql`: `member_view`, `save_my_list`, `set_list_done`
5. `..120400_elf_rpcs.sql`: `start_draw`, `reshuffle`, `undo_draw`
6. `..120500_erase_old_phones.sql`: `erase_old_phones()` and its daily cron job
7. `..120600_texting_budget.sql`: `texts.body`, `private.text_budget`, `text_budget_cap()`

(File names are abbreviated; each starts `20261018`.)

**How they were applied, and a gotcha.** Migrations 1-3 were applied with the Supabase MCP `apply_migration`. Migrations 4-7 were pasted into the SQL Editor by Joe, so Supabase's migration history table lists only 1-3. The database matches the files, but the history doesn't say so. Don't re-run 4-7. For future migrations use `apply_migration` (MCP) or the Supabase CLI (`supabase db push`) so the history stays honest. Optionally, record 4-7 in `supabase_migrations.schema_migrations` by hand to close the gap.

Always target project ref `hnnzoiuibnikrucncphu`.

## Tests

| Suite | Command | What it covers | Needs |
|---|---|---|---|
| pgTAP | `npm run test:sql` | 13 files in `tests/sql/`: schema, constraints, anon, RLS, cross-circle isolation, draw rules and randomness, locks, `member_view`, `save_my_list`, phone erasure, texting tables. Last result: 362 assertions pass. | `SUPABASE_DB_URL` |
| Vitest | `npm run test:unit` | Message builder, phone normalising, HTML escaping, wish-link rules. 114 tests. | nothing |
| Deno | `npm run test:deno` | The `send-texts` rules and handler, with fake network. Runs with `--deny-net --deny-env`, so it can't reach the internet or read any key. | Deno |
| Playwright | `npm run test:e2e` | Elf pages end to end (11 tests, E2E-ELF-01..11). **Not run yet.** | Publishable key, the two test Elf users, `npx playwright install chromium` |

Run one pgTAP file by name part: `node tests/tools/run-pgtap.mjs draw`.

The pgTAP runner opens a transaction itself and always rolls it back, so running it against the live project leaves no data behind. It refuses any test file that could commit.

**Setting up the e2e users.** Create two users by hand in Dashboard, Authentication, Users, with auto-confirm on and emails ending `@secret-santa-e2e.invalid`. Put their emails and passwords in `.env` as `E2E_ELF_A_EMAIL/PASSWORD` and `E2E_ELF_B_EMAIL/PASSWORD`. (An automated script that wrote straight into `auth.users` was rejected as too risky.)

**Tests never send real texts.** `TEXTS_DRY_RUN=true` is forced in `playwright.config.js` and `vitest.config.js`, e2e pages stub the `send-texts` URL, and `textbelt.com` requests are aborted.

## Texting

The Edge Function `supabase/functions/send-texts/` is the only thing that sends texts. Provider: [Textbelt](https://textbelt.com) (pay per text, no monthly fee). The provider call is one small function (`provider.ts`), so swapping providers later touches nothing else.

Request: `POST /functions/v1/send-texts` with the Elf's JWT and `{ circle_id, kind: 'invite' | 'reveal', member_id? }`. Response: `{ sent, failed, skipped, dry_run, results }`. Checks run in this order: sign-in and ownership, circle status, lifetime cap (the whole batch must fit), links gate, per-member rate limit, then send. Refusals use these messages: `circle not found`, `text budget used up`, `links not approved yet`, `too many texts, try again in an hour`, `names have not been drawn yet`.

Who gets texted:

- **Send invites** (whole circle) texts only kids with no real invite yet, and skips kids with no phone number. Dry-run rows don't count as "invited".
- **Re-send** (one kid) sends an invite before the circle is `sent`, a reveal after. Limit: 3 per kid per hour (the limit also applies in dry run).
- **Send the names** (reveal for the whole circle) is only allowed from `drawn` and locks the circle to `sent` before the first text goes out. This UI is Phase 4.

Message format: at most 160 characters, plain GSM-7 characters only, no emoji, so one text costs one credit. The link is never shortened. Example: `Secret Santa! Maya, you drew Ava! $20, Dec 19. Their list: <link>`.

### Hard limits (Joe's orders)

- The Textbelt account has **50 credits**. Joe may buy more, up to about 700 in total.
- **Lifetime cap.** The function counts every `texts` row with `dry_run = false` (failed ones too) and refuses at the cap, before calling the provider. The cap is `private.text_budget.cap`, **45** to start (5 kept in reserve). No browser role can read or write that table.
- **Reserve.** After each real send the function stores Textbelt's `quotaRemaining`. It stops sending once that is 5 or lower.
- **Links gate.** `TEXT_LINKS_APPROVED` defaults to false. While it is false, any real send is refused with `links not approved yet` and costs nothing, because every invite and reveal contains a link. Dry runs are unaffected.
- **Dry run by default.** `TEXTS_DRY_RUN` defaults to dry run. Only the exact value `false` turns real sending on; a missing or odd value stays dry run. Dry-run rows are written to `texts` with `dry_run = true` and the message in `texts.body`, and the app labels them "Text sent (practice run)".
- **No agent or test ever sends a real text.** Joe sends real texts himself.

### Setting it up (Joe only)

1. **Buy credit** at textbelt.com. Keep the key private.
2. **Store the key as a Supabase secret.** Run it yourself in a terminal; don't paste the key anywhere else:
   ```sh
   supabase secrets set TEXTBELT_KEY=<your-key> --project-ref hnnzoiuibnikrucncphu
   ```
   If real sending is on but `TEXTBELT_KEY` is missing, the function answers 503 and logs nothing, so no credits are wasted on fake failures.
3. **Other settings** (same command): `APP_BASE_URL=https://jheasley322.github.io/secret_santa`. Leave `TEXTS_DRY_RUN` and `TEXT_LINKS_APPROVED` unset for now. Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to the function automatically.
4. **URL whitelist.** Textbelt blocks texts containing links until the app's domain is approved. The request for `jheasley322.github.io` is pending. Until Textbelt approves it, keep `TEXT_LINKS_APPROVED` unset. Shortened links (bit.ly and so on) are always blocked, so we send the full link.
5. **Go live in steps.** First deploy and test in dry run (below). Then, once the whitelist is approved: set `TEXT_LINKS_APPROVED=true`, set `TEXTS_DRY_RUN=false`, and send **one real test text to your own phone**: make a throwaway circle with yourself as the only kid, tap Send invites, and check your phone. That uses 1 credit. Afterwards delete the throwaway circle, or set `TEXTS_DRY_RUN` back to unset until you're ready.

### How to raise the cap

When you buy more credit, run this in the SQL Editor (it's the only way; the browser can't touch it):

```sql
update private.text_budget set cap = 95;  -- example: bought 50 more (100 total), keep 5 in reserve
```

Keep the cap at or below credits bought minus the reserve of 5. To see how many real sends have been counted: `select count(*) from public.texts where dry_run = false;`.

## Phone-number erasure

Numbers are erased 7 days after the swap date. `public.erase_old_phones()` sets `members.phone = null` for every kid whose circle has `swap_date + 7 < current_date`, and returns the count. It runs daily through pg_cron as the job `erase-old-phones` at 03:17 UTC. Nobody but `service_role` and the database owner can call it. Circles without a swap date are never erased automatically, so set a date. Check the job with `select * from cron.job;` and its history in `cron.job_run_details`. After erasure the kid's row stays (name and wish list), with no phone, and the circle page shows "No number" and Re-send is disabled. Tested in `tests/sql/50_phone_erasure.sql`.

## Deploying

Nothing below has been done yet. Steps for Joe:

1. **Publishable key.** Paste it into `js/supabaseClient.js` in place of `PASTE_PUBLISHABLE_KEY_HERE`. It starts with `sb_publishable_` and is meant to be public. Never put the secret key, the service-role key or the Textbelt key in any file in this repo. The secret key (`SANTA_SECRET`) is a GitHub secret used only by CI.
2. **Auth URLs.** Dashboard, Authentication, URL Configuration: Site URL `https://jheasley322.github.io/secret_santa/`. Redirect URLs: `https://jheasley322.github.io/secret_santa/index.html` and, for local testing, `http://127.0.0.1:8787/index.html`.
3. **Edge Function, in dry-run mode:**
   ```sh
   supabase functions deploy send-texts --project-ref hnnzoiuibnikrucncphu
   ```
   with `APP_BASE_URL` set and the two switches left unset. Then use Send invites on a test circle: each kid should show "Text sent (practice run)" and `texts.body` should hold the message.
4. **Publish the site.** Serve the repo root from GitHub Pages (or Netlify). There's nothing to build. Because pages use relative links, the site works under `/secret_santa/`.
5. **Real texting** only after the steps in "Setting it up".

The member page and the draw screens ship in later phases; invites sent before the member page exists would point at a page that isn't there, so keep texting in dry run until Phase 3 is deployed.

## Pointers into `.zReference/`

- `original_specs.md`: the spec, including the data model, the error message texts and the hard text limits. Authoritative.
- `master_plan.md`: the five phases.
- `cloud_run_report.md`: what the Phase 2 build run did, what couldn't run, and open questions for Joe.
- `../tests/SCENARIOS.md`: every test scenario by ID, with the interface contract and open questions.

## Open questions (from the Phase 2 report, still waiting on Joe)

- Does a dry-run invite count as "already invited"? Built: no.
- Does the cap apply in dry run? Built: no (it's free). The rate limit does apply.
- A rate-limited kid in a whole-circle batch is skipped and the rest still go. OK?
- Phone is required when adding a kid. Should it be optional?
- Two simultaneous requests could each pass the cap check before either logs a row (race). A database-side reservation would close it.
