# Test scenarios

Every scenario the test suite covers, in plain English. Each one points to the spec section it
comes from (`.zReference/original_specs.md`, which is authoritative) and to the file that
tests it. The scenario ID (for example `DRAW-06`) appears in the pgTAP assertion's description,
so a failing line in the runner output can be traced back here.

Tests are written from the spec, before the code exists. A red test against current code is a
result, not a problem.

**Status key:** each phase's scenarios are expected **red** until that phase's code lands.
Scenarios for later phases are listed at the bottom as *planned* and have no test file yet.

How to run: see "Running the suite" at the end.

---

## Phase 1: Database

### SCH: schema shape (`tests/sql/00_schema.sql`)

Spec: *Data model*, *Privacy rules* 3, *Access rules*.

| ID | Scenario |
|---|---|
| SCH-01 | pgTAP is installed and runnable (harness sanity). |
| SCH-02 | The six tables exist in `public`: circles, members, wish_items, no_pairs, matches, texts. |
| SCH-03 | Each table has every column the spec's data model lists. |
| SCH-04 | `members` has **exactly** the spec's columns, with nowhere to store an email, birthday, school or anything else about a kid (Privacy rule 3). |
| SCH-05 | Row-level security is switched on for every table in `public`. |

### FN: function contract and grants (`tests/sql/01_functions.sql`)

Spec: *Interface contract*, *Access rules → Member* ("Each function sets `search_path` explicitly").

| ID | Scenario |
|---|---|
| FN-01 | `member_view(p_token text) returns jsonb` exists with that argument name (PostgREST calls by name). |
| FN-02 | `save_my_list(p_token text, p_about jsonb, p_items jsonb) returns void` exists. |
| FN-03 | `set_list_done(p_token text, p_done boolean) returns void` exists. |
| FN-04 | `start_draw`, `reshuffle`, `undo_draw` each take `(p_circle_id uuid)` and return void. |
| FN-05 | `erase_old_phones() returns int` exists. |
| FN-06 | The three member RPCs are `SECURITY DEFINER`. |
| FN-07 | The three member RPCs pin `search_path`, and so does every other `SECURITY DEFINER` function in `public`. |
| FN-08 | Member RPCs are executable by `anon` and `authenticated`. |
| FN-09 | Elf RPCs are executable by `authenticated` and **not** by `anon`. |
| FN-10 | `erase_old_phones` is executable by neither `anon` nor `authenticated`. |

### CON: constraints (`tests/sql/10_constraints.sql`)

Spec: *Interface contract → Constraints*, *Data model*.

| ID | Scenario |
|---|---|
| CON-01 | A 40-character first name is accepted; 41 is rejected. |
| CON-02 | An empty or whitespace-only first name is rejected. |
| CON-03 | A first name is never stored with leading or trailing spaces (either trimmed on save or rejected). |
| CON-04 | Two members of one circle can't share a first name, ignoring case ("Maya" vs "maya"). |
| CON-05 | The same first name is fine in two different circles. |
| CON-06 | Phone may be **updated** to null (that's how erasure works) or to a valid E.164 number. |
| CON-07 | Malformed phones are rejected: no `+`, leading 0, spaces, dashes, too short, too long, letters, empty string. |
| CON-08 | Budget below 0 is rejected; 0 and null are accepted. |
| CON-09 | Circle status defaults to `open` and accepts only `open`, `drawn`, `sent`. |
| CON-10 | Every member gets a generated token (12 random bytes, base64url, 16 characters; spec "Shorter links"), tokens differ, and a duplicate token is rejected. CON-10b: no member anywhere has an old-length token, so existing members were reissued. |
| CON-11 | `list_done` defaults to false. |
| CON-12 | A no-pair must be stored with `member_a < member_b`; the reverse order is rejected. |
| CON-13 | The same no-pair can't be stored twice in one circle. |
| CON-14 | A no-pair can't name a member from another circle. |
| CON-15 | A match where giver = receiver is rejected. |
| CON-16 | A match can't name a giver or receiver from another circle. |
| CON-17 | A member can be a giver only once and a receiver only once. |
| CON-18 | A wish-item link must be http or https; `javascript:` and `data:` are rejected at the table too. |
| CON-19 | Text `kind` is only `invite`/`reveal`; text `status` is only `pending`/`sent`/`failed` (anything else, e.g. `delivered`, is rejected). |
| CON-20 | **US only** (spec *Security hardening* S2): `+44…`, `+33…` and `+52…` numbers are rejected, on update and on insert. Proposed check: `phone is null or phone ~ '^\+1[0-9]{10}$'`. |
| CON-21 | **A phone is required when a member is added** (Joe, Decision 5): an insert with a null or missing phone is rejected, as postgres and as the Elf. A later update to null is still allowed (CON-06), because `erase_old_phones()` does exactly that. Proposed: a `BEFORE INSERT` trigger on `members` raising `phone number required` when `new.phone is null`. A plain `check` can't tell insert from update. |
| CON-22 | A `pending` text row is accepted (spec S3). |

Test fixtures changed with Decision 5: `pg_temp.mk_member(..., p_phone => null)` now adds the
member with a fake phone and then erases it, which is the only way a real member ends up
with no number. Every test that inserted a member with no phone now supplies a fictional one,
so each test still fails or passes for its own reason (for example LOCK-02 must fail on
`circle is locked after the draw`, not on the phone rule).

### SWAP: every circle has a swap date (`tests/sql/11_swap_date.sql`)

Spec: *Data model* (`swap_date date not null`), Joe's Decision 7, *Circle details*.

| ID | Scenario |
|---|---|
| SWAP-01 | `circles.swap_date` is `NOT NULL`. |
| SWAP-02 | The Elf creating a circle with no swap date, or a null one, is rejected. With a date, it's created. |
| SWAP-03 | The Elf can change the swap date while the circle is `open`, `drawn` and `sent`. |
| SWAP-04 | The Elf can't clear it (update to null is rejected). |
| SWAP-05 | Changing it on a `sent` circle keeps the status and matches. Elf B can't change Elf A's date. |

Fixtures already supplied a date (`current_date + 30` by default). ELF-03 and ELF-05 now supply
one too, so they test the status / owner rule, not the missing date.

### ANON: the signed-out visitor (`tests/sql/20_anon.sql`)

Spec: *Access rules → Member* ("The anon role is granted nothing on these tables"), CLAUDE.md rule 4.

| ID | Scenario |
|---|---|
| ANON-01 | `anon` holds no privilege of any kind on any table or view in `public` (catalog check, so it also catches tables added later). |
| ANON-02 | With every table populated, `anon` selecting from each of the six tables gets "permission denied". |
| ANON-03 | `anon` can't insert, update or delete either. |
| ANON-04 | `anon` can't call `start_draw`, `reshuffle`, `undo_draw` or `erase_old_phones`. |
| ANON-05 | A signed-in user who owns no circle sees zero rows in every table. |

### ELF: the Elf's own circle (`tests/sql/21_elf_rls.sql`)

Spec: *Interface contract → Elf direct table access (RLS)*, *Circle details*.

| ID | Scenario |
|---|---|
| ELF-01 | The Elf creates a circle; `elf_id` defaults to them and status is `open`. |
| ELF-02 | The Elf reads and edits their circle's details, including after the names are sent ("can edit these at any time"). |
| ELF-03 | The Elf can't create a circle with a status other than `open`. |
| ELF-04 | The Elf can't change status with a direct update. |
| ELF-05 | The Elf can't create a circle owned by someone else. |
| ELF-06 | The Elf can't hand their circle to someone else by updating `elf_id`. |
| ELF-07 | The Elf adds a member; the member gets a generated token; the Elf can read the phone and token (needed for texts and Copy link). |
| ELF-08 | The Elf can't choose a member's token on insert. |
| ELF-09 | The Elf can't change a member's token. |
| ELF-10 | The Elf edits a member's name and phone and removes a member while the circle is `open`. |
| ELF-11 | The Elf has full access to wish items in their circle. |
| ELF-12 | The Elf adds, reads and removes no-pairs in their circle. |
| ELF-13 | The Elf reads matches and texts for their circle. |
| ELF-14 | The Elf can't insert, update or delete matches. |
| ELF-15 | The Elf can't insert, update or delete texts. |
| ELF-16 | The Elf deletes their own circle and everything under it goes with it, both while `open` and after `sent`. |
| ELF-17 | The Elf removes a member who already has wish items and an invite text, while `open`. |

### ISO: one circle can't reach another (`tests/sql/22_cross_circle.sql`)

Spec: *Privacy rules* 1 and 2, *Access rules*, *Error messages*.

| ID | Scenario |
|---|---|
| ISO-01 | Elf A sees none of Elf B's circles, members, wish items, no-pairs, matches or texts. |
| ISO-02 | Elf A's updates to B's circle, members and wish items change nothing. |
| ISO-03 | Elf A's deletes of B's rows change nothing. |
| ISO-04 | Elf A can't add a member, wish item or no-pair to B's circle. |
| ISO-05 | Elf A can't move their own member into B's circle. |
| ISO-06 | Elf A calling `start_draw` / `reshuffle` / `undo_draw` on B's circle gets `circle not found`, and B's circle is unchanged. Ownership is checked before status, so a drawn circle doesn't leak "names have already been drawn". |
| ISO-07 | Any Elf RPC on a circle id that doesn't exist gets `circle not found`. |
| ISO-08 | A member token from circle X sees only circle X: no names, ids or lists from circle Y. |
| ISO-09 | A token from circle X can't change anything in circle Y through `save_my_list` or `set_list_done`. |
| ISO-10 | Elf A can't create a no-pair between their member and one of B's. |

### DRAW: the draw rules (`tests/sql/30_draw_rules.sql`)

Spec: *Draw rules*, *Do-not-pair*, *Error messages*.

| ID | Scenario |
|---|---|
| DRAW-01 | With 0 or 2 members the draw fails with `need at least 3 members` and nothing changes. |
| DRAW-02 | If any list isn't done, the draw fails with `every list must be done before the draw` and nothing changes. |
| DRAW-03 | A 3-member circle with every list done draws, and the status becomes `drawn`. |
| DRAW-04 | Every draw is valid: one match per member, each gives exactly once and receives exactly once, nobody draws themselves, everyone is in the circle. Checked for 3, 4, 5 and 8 members, and across 50 reshuffles of 6. |
| DRAW-05 | A no-pair is respected in both directions across 100 reshuffles. |
| DRAW-06 | When no-pairs make a draw impossible (3 kids, two of them paired), it fails with `Can't make a draw with these do-not-pair rules. Try removing one.`, status stays `open` and no matches exist. |
| DRAW-07 | Same when one kid is no-paired with everyone else. |
| DRAW-08 | Tight but possible rules (4 kids as two no-paired couples) always succeed. |
| DRAW-09 | Two kids drawing each other (A→B and B→A) is allowed and actually happens. |

### RAND: randomness (`tests/sql/31_draw_randomness.sql`)

Spec: *Draw rules* ("uniformly random among valid draws").

| ID | Scenario |
|---|---|
| RAND-01 | With 3 members, both possible draws appear across 200 reshuffles. |
| RAND-02 | With 3 members, both possible draws appear across 200 undo + draw cycles (`start_draw` itself is random). |
| RAND-03 | With 4 members, all 9 possible draws appear across 450 reshuffles, each between 20 and 90 times (expected 50). This catches "one big loop" algorithms that can never produce two pairs. |
| RAND-04 | All of those draws are valid. |

### STAT / LOCK: status and locks (`tests/sql/32_status_and_locks.sql`)

Spec: *Circle status*, *Reshuffle*, *Do-not-pair*, *Texting* (reveal moves to `sent`), *Error messages*.

| ID | Scenario |
|---|---|
| STAT-01 | A new circle is `open`; `start_draw` makes it `drawn`. |
| STAT-02 | `start_draw` when `drawn` or `sent` fails with `names have already been drawn`, and the matches are untouched. |
| STAT-03 | `reshuffle` and `undo_draw` when `open` fail with `names have not been drawn yet`. |
| STAT-04 | `reshuffle` when `drawn` keeps it `drawn`, leaves a valid draw, and actually changes the draw. |
| STAT-05 | `undo_draw` when `drawn` goes back to `open` and deletes the matches. |
| STAT-06 | After an undo, the Elf can draw again. |
| STAT-07 | The service role (the Edge Function) can move `drawn` → `sent`. |
| STAT-08 | `reshuffle` and `undo_draw` when `sent` fail with `names have already been sent`, and the matches and status are untouched. |
| LOCK-01 | While `open`, the Elf can add and remove members and add and remove no-pairs. |
| LOCK-02 | While `drawn`, adding a member fails with `circle is locked after the draw`. |
| LOCK-03 | While `drawn`, removing a member fails with the same message. |
| LOCK-04 | While `drawn`, adding or removing a no-pair fails with the same message. |
| LOCK-05 | While `sent`, all four fail with the same message. |
| LOCK-06 | After `undo_draw`, members and no-pairs can be changed again. |

### MV: what a member sees (`tests/sql/40_member_view.sql`)

Spec: *Privacy rules*, *Interface contract → member_view*, *Access rules → Member*.

| ID | Scenario |
|---|---|
| MV-01 | Unknown or malformed tokens (empty, garbage, right length (16) but wrong, an 8-character prefix of a real token, a real token in upper case, an injection string, null) all get `link not found`. |
| MV-02 | The top level has exactly `circle`, `me`, `members`, `match`. |
| MV-03 | `circle` has exactly `name`, `budget`, `swap_date`, `swap_place`, `status`, with the right values. |
| MV-04 | Every member object (me, each of members, match) has exactly the spec's keys, so no phone, token, created_at, opened_at or no-pair data. |
| MV-05 | Every wish item has exactly `text`, `url`, `position`, ordered by position. |
| MV-06 | `members` is everyone in the circle including me, nobody else, ordered by first name. |
| MV-07 | `me` is the caller. |
| MV-08 | Other members' lists (items and About me) are visible. |
| MV-09 | No phone number appears anywhere in the payload, including the caller's own. |
| MV-10 | No token appears anywhere in the payload, including the caller's own. |
| MV-11 | `match` is null while `open` and while `drawn`. |
| MV-12 | When `sent`, `match` is the caller's own receiver with their list, for every member. |
| MV-13 | Viewing while `open` or `drawn` doesn't set `opened_at` (only a non-null match does). |
| MV-14 | The first view once `sent` sets the caller's `opened_at` and nobody else's. |
| MV-15 | Later views don't overwrite `opened_at`. |
| MV-16 | A signed-in caller (`authenticated`) can use `member_view` too. |
| MV-17 | List edits made after the names are sent show up in the Santa's `match`. |

### LIST / DONE: saving a list (`tests/sql/41_save_my_list.sql`)

Spec: *Wish list*, *Interface contract → save_my_list / set_list_done*, *Stack* (wish links).

| ID | Scenario |
|---|---|
| LIST-01 | An unknown token gets `link not found`. |
| LIST-02 | A valid save stores About me (trimmed) and items (text trimmed), with `position` = array index starting at 0. |
| LIST-03 | Saving replaces the whole list. |
| LIST-04 | An empty item array clears the list. |
| LIST-05 | 10 items are accepted; 11 fail with `invalid list: …`. |
| LIST-06 | Item text that's empty, whitespace-only or missing is rejected; 200 characters is accepted; 201 is rejected. |
| LIST-07 | A null link and http/https links are accepted. `javascript:` (any case, with a leading space), `data:`, `vbscript:`, `ftp:`, protocol-relative and scheme-less links are rejected. |
| LIST-08 | A 500-character link is accepted; 501 is rejected. |
| LIST-09 | Each About me field accepts 200 characters and rejects 201. |
| LIST-10 | A rejected save changes nothing. |
| LIST-11 | Saving changes only the caller's own list. |
| LIST-12 | Saving works while `open`, `drawn` and `sent` ("Lists stay editable after the draw"). |
| DONE-01 | `set_list_done` with an unknown token gets `link not found`. |
| DONE-02 | `set_list_done(true)` marks only the caller's list done; `false` clears it. |

### ERASE: phone erasure (`tests/sql/50_phone_erasure.sql`)

Spec: *Privacy rules* 4, *Interface contract → Internal*.

| ID | Scenario |
|---|---|
| ERASE-01 | Phones in a circle whose swap date was 8 days ago are erased. |
| ERASE-02 | Phones are kept when the swap date was exactly 7 days ago, 6 days ago, today, or in the future. (The old "or isn't set" case is gone with Decision 7.) |
| ERASE-03 | The function returns the number of phones it erased. |
| ERASE-04 | Erasing keeps everything else: members, names, lists and matches. |
| ERASE-05 | Erasing works on a `sent` circle (the lock doesn't get in the way). |
| ERASE-06 | Running it again straight away erases 0. |
| ERASE-07 | A pg_cron job runs it daily. |
| ERASE-08 | Every circle has a swap date (`NOT NULL`), so no phone can escape erasure (Decision 7). |

---

## Phase 2: Elf pages + texting

Spec sections: *Texting*, *Texting → HARD LIMITS*, *Texting details (Phase 2 contract)*, *The
flow* 1–5, *Re-send*, *Progress*, *Circle details*, *Pages*, *Stack*, *Data model*.
Master plan row 2.

**Status key:** every Phase 2 scenario is expected **red** until the Phase 2 code exists. The
Vitest and Deno files load their module under test with a dynamic import, so a missing module
turns each test red on its own instead of crashing the file.

### The safety rules these tests follow (Joe's hard limit)

- **No test can reach Textbelt.** The Deno suite runs with `--deny-net --deny-env --deny-write
  --deny-run`, and file reads are limited to `supabase/functions`. Even a bug that tried to call
  Textbelt or read `.env` would be stopped by Deno, not by our good intentions. Every test that
  exercises "real" mode injects a fake provider object.
- **No test process loads the Textbelt key.** `tests/tools/env.mjs` reads `.env` by name and
  skips every other line. It refuses names matching `TEXTBELT`, `SERVICE_ROLE` or `SECRET`.
  Vitest's `envDir` points at a folder with no `.env`. Playwright never loads `.env` itself.
- **e2e never calls the deployed `send-texts`.** Every page has `**/functions/v1/send-texts`
  intercepted by a stub that writes dry-run rows (`dry_run = true`) straight into `texts`, and
  `textbelt.com` is blocked as well. The static server refuses dotfiles, so `.env` can't be
  fetched from the test site.
- Phones are fictional `+1 555 555-01xx` only.

### Interface the tests assume (backend-engineer and frontend-builder build to this)

The spec fixes behaviour. These module paths and function shapes are the test-first contract
for the pure core. Changing one means changing its test in the same PR.

| Module | Exports |
|---|---|
| `supabase/functions/_shared/messages.js` (plain JS, no imports; used by Deno and Node) | `memberLink(baseUrl, token)`, `inviteText({ name, circle, link })`, `revealText({ name, receiver, budget, swapDate, link })`. `budget` is a number or null. `swapDate` is `'YYYY-MM-DD'` or null. |
| `supabase/functions/send-texts/core.ts` (pure, no imports except `../_shared/`) | `readSettings(env) → { dryRun, linksApproved, appBaseUrl }`, `budgetAllows({ used, cap, lastQuota, batchSize }) → boolean` (revised 2026-10-24, S1), `isRateLimited({ texts, memberId, now }) → boolean`, `pickRecipients({ kind, members, texts, memberId? }) → { send: Member[], skipped: { member_id, reason }[] }` |
| `supabase/functions/send-texts/provider.ts` | `makeTextbeltProvider({ key, fetch }) → { send(phone, message) }`. The only code that knows Textbelt. `fetch` is injected so tests never touch the network. |
| `makeTextbeltProvider(...).configured` | `true` only when the key is non-blank (spec S4). The handler uses it for `texting is not set up yet`. Never exposes the key. |
| `public.text_budget_cap() returns int` (SQL, `security definer`) | How the Edge Function reads `private.text_budget.cap` through PostgREST. Executable by `service_role` only. |
| `supabase/functions/send-texts/handler.ts` (no imports except `./core.ts` and `../_shared/`) | `handle(req: Request, deps) → Promise<Response>`. `deps = { db, provider, env, getUserId }`. `index.ts` is the only file that touches `Deno.env`, `Deno.serve`, supabase-js or `fetch`. |
| `js/phone.js` | `normalizePhone(input) → string \| null` (E.164 or null) |
| `js/escape.js` | `escapeHtml(value) → string` |
| `js/links.js` | `isValidWishLink(url) → boolean` |

The `deps` the handler gets:

```
getUserId(authorizationHeader: string | null) → Promise<string | null>   // Elf's auth.uid(), null if missing/invalid
provider.send(phone, message) → Promise<{ success, textId?, quotaRemaining?, error? }>   // Textbelt's response shape; may throw
db.getCircle(id)          → { id, elf_id, name, budget, swap_date, swap_place, status } | null
db.getMembers(circleId)   → [{ id, circle_id, first_name, phone, token }]
db.getMatches(circleId)   → [{ giver_id, receiver_id }]
db.getTexts()             → every texts row (all circles): { member_id, kind, status, dry_run, quota_remaining, created_at }
db.lockCircleSent(id)     → boolean   // update ... set status='sent' where id=$1 and status='drawn'; true if a row changed

// Added 2026-10-24 (spec "Security hardening" S1, S3, S4). These replace getCap and insertText.
db.getBudget()            → { cap, used, last_quota }   // read-only, for the ordered pre-check
db.claimTexts({ circle_id, kind, member_ids, dry_run, resend })
                          → { ok: true, texts: [{ member_id, text_id }], skipped: [{ member_id, reason }] }
                          | { ok: false, error: 'text budget used up' }        // = public.claim_texts(...)
db.finishText(text_id, { status: 'sent' | 'failed', provider_id, error, quota_remaining, body })
db.recordQuota(quota)     → void                                                // = public.record_text_quota(...)
provider.configured       → boolean                                             // false when TEXTBELT_KEY is blank
env.ELF_USER_IDS          → comma-separated auth user ids (spaces ignored); missing or empty = nobody
```

The handler order is now: JWT → `ELF_USER_IDS` (not listed: `circle not found`, before any
database call) → ownership → status → **not set up** (real mode with `provider.configured`
false: 503 `texting is not set up yet`) → cap pre-check from `getBudget()` → links gate → rate
limit → **`claimTexts`** (the atomic database gate) → lock `drawn → sent` for a reveal → for each
row, provider call then `finishText` → `recordQuota` after each real send. A claimed row is never
deleted. If the log write after a provider call fails, the row stays `pending` and the credit
stays counted (fail closed).

A text row in `getTexts()` is the raw row, so the rate-limit and "already invited" pre-checks
are computed in `core.ts`, where they're tested. The database re-checks both under the circle
lock (`claim_texts`, CT-01..10), which is the gate that actually holds under concurrency. The
cap is no longer computed from rows at all (S1).

### SET: safe defaults (`supabase/functions/send-texts/core_test.ts`)

Spec: *Texting* ("a missing value means dry run", CLAUDE.md rule 9), *HARD LIMITS* 2.

| ID | Scenario |
|---|---|
| SET-01 | An empty environment means **dry run** and **links not approved**. |
| SET-02 | `TEXTS_DRY_RUN=true` means dry run. Only the exact value `false` turns on real sends. `""`, `0`, `no`, `off` and junk all stay dry run. |
| SET-03 | `TEXT_LINKS_APPROVED`: only the exact value `true` approves links. Missing, `""`, `false`, `1`, `yes` and junk are all "not approved". |
| SET-04 | `APP_BASE_URL` from the environment is the base for links. |

### BUD: the credit cap and reserve (`core_test.ts`)

Spec: *HARD LIMITS* 1, *Texting details → Where the cap lives*.

*Revised 2026-10-24 for S1:* `budgetAllows({ used, cap, lastQuota, batchSize })` reads the
counter, not the `texts` rows. It is the handler's read-only pre-check; the database claim
(CLM, CT) is the real gate.

| ID | Scenario |
|---|---|
| BUD-01 | `used + batch ≤ cap` allows; one over refuses. |
| BUD-02 | The `texts` rows aren't an input: a full counter refuses even with no rows passed (deleted rows can't reset the cap). |
| BUD-03 | The whole batch must fit: 40 + 5 of 45 is allowed, 40 + 6 isn't. |
| BUD-04 | At the cap, even a single text is refused. A batch of 0 is always allowed. |
| BUD-05 | `last_quota` at or below 5 refuses. 6, 200 (Joe bought credit) and null (no send yet) allow. |
| BUD-06 | An empty batch fits even at the reserve. |

### RATE: 3 texts per member per hour (`core_test.ts`)

Spec: *Re-send* ("Limited to 3 re-sends per member per hour"), *Texting* ("at most 3 texts per member per hour").

| ID | Scenario |
|---|---|
| RATE-01 | 2 texts in the last hour: not limited. 3: limited (the next would be the 4th). |
| RATE-02 | Failed texts count. |
| RATE-03 | Texts older than an hour don't count. |
| RATE-04 | Only this member's texts count. |
| RATE-05 | Dry-run rows count (Decision 2). |
| RATE-06 | `pending` rows count (S3). |

### PICK: who gets texted (`core_test.ts`)

Spec: *Texting details → Who gets texted*.

| ID | Scenario |
|---|---|
| PICK-01 | Invite batch: members with a successful real invite are not texted. Members whose only invite **failed** are texted again. |
| PICK-02 | Invite batch: a member with no phone is skipped and reported (`skipped` includes them), not an error. |
| PICK-03 | Reveal batch: every member with a phone is texted exactly once, even if they had invites. |
| PICK-04 | One member (`memberId`): just that member, even if they already have a successful invite (Re-send is explicit). |
| PICK-05 | One member with no phone: skipped, not texted. |
| PICK-06 | A dry-run invite doesn't count as "already invited" (Decision 1). |
| PICK-07 | A `pending` **real** invite counts as already invited; a pending dry-run one doesn't (S3). |

### ST: the `send-texts` handler (`supabase/functions/send-texts/handler_test.ts`)

Spec: *Texting*, *HARD LIMITS*, *Texting details → Edge Function interface*, *Order of checks*,
*Circle status*, *Re-send*.

Every test asserts outcomes: the HTTP status, the response JSON, the rows in the fake `texts`
table, the circle's status, and what the fake provider actually received.

| ID | Scenario |
|---|---|
| ST-01 | No `Authorization` header gets a 4xx. Nothing is sent and no row is written. |
| ST-02 | A signed-in caller who isn't the circle's Elf gets 4xx `circle not found`. Nothing is sent, no row is written, status is unchanged. |
| ST-03 | An unknown `circle_id` gets 4xx `circle not found`. |
| ST-04 | A `member_id` from another circle gets 4xx, and nothing is sent to anyone. |
| ST-05 | Malformed JSON, a missing `circle_id` or a `kind` other than `invite`/`reveal` gets 4xx, and nothing is sent. |
| ST-06 | A CORS preflight (`OPTIONS`) gets 2xx with `Access-Control-Allow-Origin`, and nothing is sent. *(Derived: the browser can't call the function otherwise.)* |
| ST-07 | A whole-circle reveal while `open` gets 4xx `names have not been drawn yet`. |
| ST-08 | A whole-circle reveal while `sent` is refused (4xx) and nobody is texted twice. |
| ST-09 | A one-member reveal while `drawn` (before Send the names) is refused, and the circle stays `drawn`. |
| ST-10 | **Order:** not the owner + reveal while open + cap used up gives `circle not found`. |
| ST-11 | **Order:** owner + reveal while open + cap used up + links not approved gives `names have not been drawn yet`. |
| ST-12 | **Order:** cap used up + links not approved + member rate-limited gives `text budget used up`. |
| ST-13 | **Order:** links not approved + member rate-limited gives `links not approved yet`. |
| ST-14 | **Order:** links approved + member rate-limited gives `too many texts, try again in an hour`. |
| ST-15 | **Cap:** 43 real rows used (failed and other circles included), 200 dry-run rows, cap 45. An invite batch of 2 is sent. A batch of 3 gets `text budget used up`, the provider is never called, and no row is written. |
| ST-16 | **Cap:** the cap comes from the database. Raising it from 45 to 46 lets the same batch through. |
| ST-17 | **Cap:** at the cap, a single Re-send is refused before the provider. |
| ST-18 | **Reserve:** the last recorded `quotaRemaining` of 5 refuses with `text budget used up` before the provider is called. A value of 6 sends. |
| ST-19 | **Reserve mid-batch:** once the provider reports `quotaRemaining` 5, no further text in that batch is sent. |
| ST-20 | **Links gate:** real mode with links not approved (missing **or** `false`) refuses invites and reveals with `links not approved yet`, writes no row (so it costs nothing against the cap), and leaves a `drawn` circle `drawn`. |
| ST-21 | **Links gate:** dry run with links not approved still runs, and the logged body contains the full link. |
| ST-22 | **Batch:** Send invites skips members with a successful invite, re-texts members whose invite failed, and skips and reports members with no phone. The counts in the response match. |
| ST-23 | **Batch:** Re-send to one already-invited member sends exactly one invite, to that member only. |
| ST-24 | **Rate:** the 4th text to one member within an hour is refused with `too many texts, try again in an hour`, and nothing is sent. The 3rd is allowed. Texts older than an hour don't count. Another member is unaffected. |
| ST-25 | **Rate (dry run):** the limit applies in dry run too, counting dry-run rows, so the stuck-button protection can be tested without credits. *(Interpretation, see the open questions.)* |
| ST-26 | **Reveal:** the circle is already `sent` when the first text goes to the provider. Every member gets exactly one text naming **their own** receiver, with a link carrying **their own** token. A receiver's token never appears in someone else's text. |
| ST-27 | **Reveal:** a failed provider call (`success: false`, or the call throwing) is logged `failed` with its error, the circle stays `sent` (no rollback), and the other members are still texted. |
| ST-28 | **Reveal:** if the `drawn → sent` lock doesn't take (someone else already sent), nothing is sent. Since 2026-10-24 that move happens inside `claimTexts` (= `claim_texts`), and the fake models it. |
| ST-29 | **Reveal:** a cap or links refusal leaves the circle `drawn`, because the lock comes after the checks. |
| ST-30 | **Reveal Re-send:** once `sent`, Re-send to one member sends that member's reveal only. |
| ST-31 | **Dry run (empty env):** the provider is never called. Each row has `dry_run = true`, `status = sent`, `body` = the exact message, and `provider_id` and `quota_remaining` null. The response says `dry_run: true`. |
| ST-32 | **Real rows:** `body` is null, `provider_id` is Textbelt's `textId`, `quota_remaining` is recorded, and `dry_run` is false. |
| ST-33 | **Real message:** the provider receives the member's E.164 phone and the spec's invite text, ≤160 GSM-7 characters. |
| ST-34 | **Only allowed fields:** no text or body contains any phone number, any token but the recipient's own, or the swap place. |
| ST-35 | **Safety default:** junk `TEXTS_DRY_RUN` (`yes`, `FALSE`, `0`, `off`, `""`) is a dry run even with links approved. The provider is never called. |
| ST-36 | **Batch:** Send invites when everyone already has an invite gives 200 with `sent: 0`, and nothing is sent, even at the cap (an empty batch always fits). |
| ST-37 | **Reveal:** a member with no phone is skipped and reported, the circle still locks to `sent`, and everyone else is texted. |
| ST-38 | **Batch rate limit:** in a whole-circle batch, a member who has hit 3 texts this hour is skipped and reported with `too many texts, try again in an hour`. The others are texted. *(Interpretation, see the open questions.)* |
| ST-39 | **Invites after sent:** once the circle is `sent`, invite requests (batch or one member) are refused with 4xx, and nothing is sent. Re-send then means the reveal (spec *Re-send*). |
| ST-40 | **Isolation:** `handler.ts`, `core.ts` and `messages.js` never read `Deno.env`, call `fetch`, name `textbelt.com` or create a supabase client. Only `index.ts` does. |

**Added 2026-10-24** (Decisions 1–4 and 6; *Security hardening* S1–S4). The fakes now model the
counter (`db.used`, `db.lastQuota`), `claimTexts`, `finishText` and `recordQuota`. Every real row
seeded by a test also counts in `db.used`, so ST-15..19 keep their meaning. The provider fake
records `db.used` and the pending rows at the moment of each call, so "claimed before the
provider" is checked on state, not on call order.

| ID | Scenario |
|---|---|
| ST-41 | **Claim first:** when the first text reaches the provider, the whole batch is already counted in `used` and every member in it has a `pending` row. |
| ST-42 | **Refused claim:** the read-only pre-check sees room, but a concurrent request takes the credits first. Our claim is refused, giving 4xx `text budget used up`, zero provider calls and no rows (Decision 6). |
| ST-43 | A refused claim on Send the names leaves the circle `drawn`. |
| ST-44 | **Failed log write:** the provider was called, then `finishText` fails. The credit stays counted, the row stays `pending` (never deleted), the request reports an error, and the next Send invites doesn't text that member again. |
| ST-45 | No row is left `pending` after a request that finishes normally: a plain batch, failed provider calls, a mid-batch reserve stop, and a dry run. |
| ST-46 | The `quotaRemaining` Textbelt reports is recorded (`recordQuota`). |
| ST-47 | Dry runs never touch the counter, and a dry-run batch at the cap still runs (Decision 2). |
| ST-48 | Dry-run invites don't count as invited: the first real Send invites texts everyone (Decision 1). |
| ST-49 | A dry-run batch skips a member rate-limited by dry-run rows and sends the rest (Decisions 2, 3). |
| ST-50 | The reveal body is exactly `Secret Santa! Ava, you drew Ben! $20, Dec 19. Their list: <link>` (Decision 4). |
| ST-51 | **Allow-list (S2):** a signed-in user not on `ELF_USER_IDS` gets 404 `circle not found`, for invites and reveals, while the fake database throws on any use. This proves no database call (so no service-role client) happened first. |
| ST-52 | A missing, empty or blank-only `ELF_USER_IDS` lets nobody in (fail closed). |
| ST-53 | `ELF_USER_IDS` is comma-separated; spaces around ids are ignored. |
| ST-54 | **S4:** with no Textbelt key in real mode, no JWT gets 401, a non-listed user gets `circle not found`, and only the allow-listed owner gets 503 `texting is not set up yet`, with nothing sent and no credit claimed. |
| ST-55 | A dry run needs no Textbelt key. |
| ST-56 | `index.ts` reads `ELF_USER_IDS`, and no longer answers `texting is not set up` itself before auth. *(A source check, because the handler tests can't see an early return in `index.ts`.)* |

### PROV: the Textbelt provider (`supabase/functions/send-texts/provider_test.ts`)

Spec: *Texting* ("Swappable", "The API key ... never appears in the browser or the repo").
Every test injects a fake `fetch`. The key is a fake string.

| ID | Scenario |
|---|---|
| PROV-01 | One `POST https://textbelt.com/text` carrying `phone`, `message` and `key`. It returns `success`, `textId` and `quotaRemaining`. |
| PROV-02 | A missing, empty or blank key never calls `fetch` and never reports success. |
| PROV-03 | A Textbelt refusal (`success: false`) comes back with its error and quota. |
| PROV-04 | An HTTP error, a non-JSON reply or a network error is never reported as success. |
| PROV-05 | The key never appears in anything the provider returns or throws, even if Textbelt echoes it. |
| PROV-06 | `configured` is false for a missing, empty or blank key and true otherwise. The key isn't exposed on the provider object (S4). |

### MSG: message builder (`tests/unit/messages.test.js`)

Spec: *Texting details → Message format*, *Texting* ("we send the full link").

| ID | Scenario |
|---|---|
| MSG-01 | The invite with short names is exactly `Secret Santa! Hi Maya, add your wish list for Ava's Crew: https://jheasley322.github.io/secret_santa/m/#<token>`. |
| MSG-02 | `memberLink` gives `{APP_BASE_URL}/m/#<token>` whether or not the base ends in `/`. It's the full URL, never a shortener. |
| MSG-03 | The reveal with budget and date starts `Secret Santa! Maya, you drew Ava!`, contains `$20` and `Dec 19`, and ends `. Their list: <link>`. |
| MSG-04 | Reveal with budget only, date only, or neither: only what's set appears, never `null`, `undefined`, `NaN` or a stray `$`. With neither there's no `!.`. |
| MSG-05 | A budget of 0 is set, so it shows `$0`. |
| MSG-06 | The swap date is the stored calendar day in every time zone, from UTC−10 to UTC+14, so `2026-12-19` never becomes `Dec 18` or `Dec 20`. If a weekday is shown, it's `Sat`. |
| MSG-07 | Every output fits one segment: ≤160 GSM-7 septets (`^{}\[~]|€` count as 2), across a matrix of names, circles, budgets and dates. |
| MSG-08 | Every output is GSM-7 only. Emoji (including ZWJ families, skin tones, flags and variation selectors) are dropped. Curly quotes become straight. En and em dashes become `-`. No `…` character. |
| MSG-09 | Long names (40-character kid, 80-character circle) are shortened with `...`, and the shortened part is a prefix of the original. The link is whole and last. |
| MSG-10 | Names that fit are never shortened. |
| MSG-11 | A name made only of emoji still gives a valid one-segment text with the whole link. |
| MSG-12 | The reveal is **exactly** `Secret Santa! Maya, you drew Ava! $20, Dec 19. Their list: <link>` (Decision 4). |

### PH: phone normalisation (`tests/unit/phone.test.js`)

Spec: *Data model* (E.164), *Constraints* (`^\+[1-9][0-9]{7,14}$`), *The flow* 2.

| ID | Scenario |
|---|---|
| PH-01 | US 10-digit numbers in every common format (`5555550123`, `555-555-0123`, `(555) 555-0123`, `555.555.0123`, `555 555 0123`) become `+15555550123`. |
| PH-02 | 11 digits with a leading 1 (`1 555 555 0123`, `1-555-555-0123`) and `+1` forms become `+15555550123`. |
| PH-03 | *Revised 2026-10-24 (S2, US only):* non-US numbers (`+44`, `+61`, `+33`, `+52`, `+7`) give null, so the page never accepts what the database rejects (CON-20). |
| PH-04 | Junk gives null: empty, spaces, null, undefined, letters, a vanity number (`1-800-FLOWERS`), 7 digits, 9 digits, 11 digits not starting with 1, 16+ digits, an extension, `++1…`, `+0…`, punctuation only, emoji, and an object. |
| PH-05 | Every non-null output matches the spec's E.164 pattern and the US form `^\+1[0-9]{10}$`. |
| PH-06 | Normalising twice gives the same answer. |
| PH-07 | Nothing typed gives null, so the page can say a number is needed (Decision 5). |
| PH-08 | *Re-audit finding 3:* `+1` numbers from Canada (416, 604, 514, 867, 905) and the Caribbean / Atlantic (876, 809, 242, 441) give null, matching AL-24..26. US numbers and US territories (787) still pass. |

### ESC: HTML escaping (`tests/unit/escape.test.js`)

Spec: *Stack* ("Everything a user typed is escaped when shown"), CLAUDE.md rule 7.

| ID | Scenario |
|---|---|
| ESC-01 | `& < > " '` are escaped, and the output contains no raw `< > " '`. |
| ESC-02 | Decoding the output gives the input back (`&` is escaped first, and `&amp;` becomes `&amp;amp;`). |
| ESC-03 | Script, attribute-breakout and event-handler payloads come out inert. |
| ESC-04 | null and undefined give `''`. Numbers become strings. Plain text and non-ASCII (`Zoë`, `José`) pass through unchanged. |

### LINK: wish-link validation (`tests/unit/links.test.js`)

Spec: *Data model* (url http/https), *save_my_list* (≤ 500 chars), *Stack* (wish links). The
same rule as the database (Phase 1 LIST-07/08), so the page never accepts what the database
rejects.

| ID | Scenario |
|---|---|
| LINK-01 | `http://` and `https://` links with a host are accepted, in any letter case. |
| LINK-02 | `javascript:` (any case, leading spaces, an embedded tab or newline), `data:`, `vbscript:`, `file:`, `ftp:`, `mailto:`, protocol-relative `//host` and scheme-less links are rejected. |
| LINK-03 | 500 characters are accepted and 501 rejected. |
| LINK-04 | No host (`https://`) or whitespace inside the link is rejected. |

### TXB: texting tables (`tests/sql/60_texting_schema.sql`, pgTAP)

Spec: *HARD LIMITS* (`texts` gains `dry_run`, `quota_remaining`), *Texting details → Where the
cap lives* and *Dry-run bodies*.

| ID | Scenario |
|---|---|
| TXB-01 | `texts.body` exists, is `text` and is nullable. |
| TXB-02 | `private.text_budget` exists with `cap integer not null default 45`. |
| TXB-03 | It holds exactly one row, and a second row is rejected. |
| TXB-04 | Neither `anon` nor `authenticated` has any privilege on `private.text_budget` or usage on schema `private`. |
| TXB-05 | A signed-in Elf selecting from `private.text_budget` gets "permission denied". |
| TXB-06 | The Elf can read `body` on their own circle's texts but not on another Elf's. |
| TXB-07 | A real row (`dry_run = false`) with a body is rejected. The body is for dry runs only. |
| TXB-08 | `public.text_budget_cap()` is executable by `service_role` only, not by `anon` or `authenticated`. |
| TXB-09 | `text_budget_cap()` returns the stored cap (after Joe changes it to 46, it returns 46). |
| TXB-10 | `public.text_budget_state()` (what send-texts actually reads) is executable by `service_role` only, not by public, anon or authenticated. |
| TXB-11 | `text_budget_state()` returns exactly `{cap, used, last_quota}` as stored. |

*TXB-08/09 can retire:* `text_budget_cap()` has no caller (send-texts reads `text_budget_state()`, TXB-10/11). They go in the same PR as the migration that drops it.

### CLM / CT / RLSA: credit claims under a lock (`tests/sql/61_text_credits.sql`, pgTAP)

Spec: Joe's Decisions 1, 2 and 6, and *Security hardening* S1, S3 and S5.

**Contract (proposed by test-author 2026-10-24; backend-engineer builds to it):**

```
private.text_budget.used        int not null default 0   -- lifetime claimed real texts; never decreases
private.text_budget.last_quota  int null                 -- latest Textbelt quotaRemaining

public.claim_text_credits(p_circle_id uuid, p_n int) returns boolean
  -- S1. Locks the circle row (FOR UPDATE), then, in a NEW statement (fresh snapshot):
  --   if p_n > 0 and used + p_n <= cap and (last_quota is null or last_quota > 5):
  --     used := used + p_n; return true
  --   else return false (nothing changes). p_n <= 0 never lowers used.
  -- Unknown circle: counts nothing.

public.record_text_quota(p_quota int) returns void        -- S1. Sets last_quota.

public.claim_texts(p_circle_id uuid, p_kind text, p_member_ids uuid[],
                   p_dry_run boolean, p_resend boolean) returns jsonb
  -- S3. One transaction, under the same circle lock:
  --   keep only members of p_circle_id;
  --   invite and not p_resend: skip members with a REAL invite that is sent or pending
  --     (reason 'already invited'; dry-run invites never count, Decision 1);
  --   skip members with >= 3 texts of any kind/status/dry_run in the last hour
  --     (reason 'too many texts, try again in an hour', Decisions 2 and 3);
  --   real (not p_dry_run) and survivors > 0: claim_text_credits(p_circle_id, survivors),
  --     and if refused return {"ok": false, "error": "text budget used up"} with no rows;
  --   whole-circle reveal (not p_resend): requires status 'drawn' (else {"ok": false,
  --     "error": "names have already been sent"}) and moves drawn -> sent AFTER the credit
  --     check, in the same transaction, so a losing concurrent reveal claims nothing
  --     (lead decision 2026-10-24);
  --   insert one 'pending' texts row per survivor (dry_run = p_dry_run).
  --   Returns {"ok": true, "texts": [{"member_id", "text_id"}], "skipped": [{"member_id", "reason"}]}.

All three: SECURITY DEFINER, set search_path = '', execute revoked from public, anon and
authenticated, and granted to service_role only. texts.status gains 'pending'.
```

Why the lock must be its own statement: under READ COMMITTED, a single
`update ... where used + n <= cap` re-checks only the row it waited on. A count read in the
same statement would use the old snapshot. Lock first, then read.

**How serialisation is tested without two connections.** True concurrency can't happen
inside one transaction, so it's covered two ways. (1) Sequentially: a second claim that, with
the first, would pass the cap is refused, and a second identical batch writes no rows. (2) The
lock itself: after a claim, this transaction holds a **writer** row lock (`For Update` / `For No
Key Update`) on the circle. Row locks don't appear in `pg_locks` unless someone waits, so the
test creates the contrib extension `pgrowlocks` inside its own rolled-back transaction and
reads the lock mode. A `For Key Share` lock (what a member insert's foreign key takes) or a
`For Share` lock doesn't count, because two requests holding it wouldn't wait for each other.
A harness check confirms the detector sees a manual `SELECT … FOR UPDATE`. The detector
doesn't filter on the backend pid: a lock taken inside a subtransaction (any plpgsql
exception block) is reported by pgrowlocks with pid 0. The rows tested are created in the
test's own uncommitted transaction, so no other session can lock them.

| ID | Scenario |
|---|---|
| CLM-01 | `used int not null default 0` and `last_quota int null` exist on `private.text_budget`. |
| CLM-02 | `claim_text_credits`, `record_text_quota` and `claim_texts` are executable by service_role and by nobody else (public, anon, authenticated). An Elf calling one directly gets permission denied. |
| CLM-03 | 40 used + 3 of 45 is granted, and `used` becomes 43. |
| CLM-04 | **Two claims in sequence:** 43 + 3 is refused and reserves nothing. 43 + 2 = 45 fits exactly. At 45, a single credit is refused. |
| CLM-05 | A claim of 0 or −5 never lowers `used`. |
| CLM-06 | `record_text_quota(5)` stores 5. Then any claim is refused and nothing is counted. With `last_quota` set to 6 (as Joe does with SQL), a claim of 1 is allowed and lowers it to 5. *Revised 2026-10-24 for AL-12..17: `record_text_quota` never raises the value, so a later 6 can't undo a 5.* |
| CLM-07 | The counter is the authority. `used = cap` refuses with no `texts` rows, and 45 real `texts` rows aren't re-counted on top of `used`. |
| CLM-08 | **Deletes never lower it:** after the Elf deletes a circle whose 3 texts were claimed (and the other circle's texts are deleted too), `used` is unchanged and those 3 still count against the cap. |
| CLM-09 | A claim for a circle that doesn't exist counts nothing. |
| CLM-10 | After `claim_text_credits`, this transaction holds a writer lock on the circle row (plus 2 harness checks). |
| CT-01 | A real invite batch for Ava, Ben, Cy and Dee writes `pending` rows for Ava (old failed invites only) and Ben (a dry-run invite only, Decision 1). It skips Cy (`already invited`) and Dee (3 texts this hour, dry-run and failed included: `too many texts, try again in an hour`), claims exactly 2, and returns the pending rows' ids. |
| CT-02 | The same batch again (a parallel second click) writes nothing and claims nothing. A pending real invite counts as already invited. |
| CT-03 | Re-send (`p_resend`) to already-invited Cy writes a pending row and claims 1. |
| CT-04 | Re-send to rate-limited Dee is skipped, with no row and no credit. |
| CT-05 | A dry-run batch at the cap is accepted, writes dry-run pending rows, and leaves `used` unchanged (Decision 2). |
| CT-06 | A real batch that doesn't fit gives `{ok: false, error: 'text budget used up'}`, writes no rows and claims nothing. |
| CT-07 | The cap is checked against the members who will actually be texted. With one already invited, 43 + 2 fits. |
| CT-08 | A reveal batch texts every member, whatever invites they had. |
| CT-09 | A member id from another circle gets no row and no credit. |
| CT-10 | After `claim_texts`, this transaction holds a writer lock on the circle row (plus a harness check). |
| CT-11 | A whole-circle reveal claim moves the circle `drawn → sent`. A second (losing) reveal batch gets `names have already been sent` and writes and claims nothing. A reveal refused by the cap leaves the circle `drawn`. |
| RLSA-01 | `public.rls_auto_enable()` isn't executable by public, anon or authenticated (S5). |

### AL: re-audit fixes (`tests/sql/62_audit_lows.sql`, pgTAP)

Spec: *HARD LIMITS*, *Security hardening* S1–S3, *Lead decisions on the S1–S3 contract*. Pins
`supabase/migrations/20261024150000_audit_lows.sql`. backend-engineer wrote it as an agreed
exception to test-first, and test-author reviewed it on 2026-10-24: it asserts outcomes (row
states, the counter, accept/reject), not call order, and it's kept as is.

| ID | Scenario |
|---|---|
| AL-01..03 | `private.sweep_pending_texts(uuid)` exists. No client role, service_role included, can execute it. pg_cron runs it every 10 minutes. |
| AL-04..08 | `claim_texts` first sweeps its own circle's `pending` rows older than 10 minutes to `failed` / `timed out`, so a crashed send no longer blocks a kid's invite. It leaves other circles and 9-minute-old rows alone, and `used` never goes down. |
| AL-09..11 | The cron form sweeps every circle, dry-run rows included. `sent` rows are untouched. A swept row is kept, so it still counts toward the 3-per-hour limit. |
| AL-12..16 | **Atomic reserve:** a claim of n needs `last_quota - n >= 5` and lowers `last_quota` by n in the same update. A batch that would dig into the reserve is refused whole. A null `last_quota` (no real send yet) means only the cap applies. |
| AL-17..20 | `record_text_quota` keeps the lower of the stored and reported values (never raises it; Joe resets it with SQL after buying credit). From null it stores the figure. A null report changes nothing. |
| AL-21..28 | **US only:** a US number (803), the 555 fixtures and Puerto Rico are accepted. Canadian (416, 604, 514, 867, 905, 250) and Caribbean / Atlantic (876, 809, 242, 441) numbers are rejected, on insert and update, as postgres and as the Elf. The check is validated. |
| AL-29..31 | The phone guard trigger fires before `members_tidy`, and `members_tidy` never touches phone. |
| AL-32..33 | No function that anon or authenticated can execute calls `net.*`, and `keep_alive()` isn't client-executable. |

Review notes for the lead:
- **Joe has a manual step.** After buying credit, `last_quota` stays low until Joe runs
  `update private.text_budget set last_quota = null` (or the new figure). Until then, real sends
  are refused with `text budget used up`. That fails safe, but it belongs in the README / Joe's
  checklist.
- AL-03 and AL-30 match on source text (the cron command, the function body). They're brittle
  but deliberate.
- The `+1` exclusion list is copied by hand in `js/phone.js` and the migration. PH-08 and
  AL-24..26 check the same area codes on both sides, so a drift in those shows up, but a code
  missing from both lists would not.

### E2E-ELF: the Elf pages (`tests/e2e/elf.spec.js`, Playwright)

Spec: *The flow* 1–5, *Circle details*, *Re-send*, *Progress*, *Pages*, *Privacy rules*.

| ID | Scenario |
|---|---|
| E2E-ELF-01 | Signed out, `/` shows an email field and a sign-in button. Submitting shows "check your email". The OTP request is intercepted, so no real email is sent. |
| E2E-ELF-02 | **Happy path:** the signed-in Elf creates `[e2e] …` with budget 20, swap date 2026-12-19 and a place, and lands on `circle.html?id=…` showing the name, `$20`, `Dec 19` and the place. |
| E2E-ELF-03 | They add Ava, Ben and Cy with phones typed as `(555) 555-0101` and similar. The rows show "Not sent yet", and the database stores `+15555550101`. |
| E2E-ELF-04 | Send invites calls `send-texts` with `{ circle_id, kind: 'invite' }` and the Elf's JWT. Every row then shows "Text sent". |
| E2E-ELF-05 | The progress checklist shows `0 of 3 done`. After one kid marks their list done (through `set_list_done`), a reload shows `1 of 3 done`. |
| E2E-ELF-06 | Copy link puts the full `…/m/#<that member's token>` on the clipboard. |
| E2E-ELF-07 | Re-send on one row sends `{ circle_id, kind: 'invite', member_id }` for that member only. |
| E2E-ELF-08 | `/` lists the Elf's own circles, and Elf B's circle isn't among them. |
| E2E-ELF-09 | **Unhappy:** an invalid phone (`555-0101`, `call me`) gives an inline error on the mobile field (`aria-invalid="true"` plus a non-empty accessible description), and no member is added. |
| E2E-ELF-10 | **Unhappy:** Elf A opening Elf B's `circle.html?id=…` sees a "not found" message and none of B's circle name, member names or phones. |
| E2E-ELF-11 | The circle page at 375px wide has no horizontal scroll. |
| E2E-ELF-12 | The sign-in request carries `create_user: false` (`shouldCreateUser: false`, S2). The OTP request is intercepted. |
| E2E-ELF-13 | Adding a kid with an empty mobile field marks the field invalid and adds nobody (Decision 5). |
| E2E-ELF-14 | Creating a circle with no swap date marks the date invalid, stays on `/`, and creates no circle (Decision 7). |

UI contract the e2e relies on (taken from the approved mock in `design/preview.html` and the
spec wording):

- Create form: inputs labelled with *name*, *budget*, *date* and *place*, and a button
  "Create circle".
- Add-member form: inputs labelled *first name* and *mobile*/*phone*, and an "Add" button.
- Each member is a list item. The text-status pill reads "Not sent yet", "Text sent" or
  "Text failed", and the row has "Re-send" and "Copy link" buttons.
- Progress reads "X of Y done". The page-level button is "Send invites".
- The session lives in supabase-js's default storage (localStorage key
  `sb-hnnzoiuibnikrucncphu-auth-token`). e2e signs in by placing a real session there.

How e2e gets an Elf session without the service-role key: Joe creates two test Elf accounts
once, by hand, in the Supabase dashboard (Authentication, then Add user, with auto-confirm on).
Their emails end in `@secret-santa-e2e.invalid`. Their credentials come from the environment as
`E2E_ELF_A_EMAIL`, `E2E_ELF_A_PASSWORD`, `E2E_ELF_B_EMAIL` and `E2E_ELF_B_PASSWORD`, read by name
only. Global setup signs each one in with `signInWithPassword` and the publishable key, and
saves the session as Playwright storage state in `tests/e2e/.auth/` (gitignored). The suite never
creates or deletes auth users. Setup and teardown sweep only circles named `[e2e]%`.

The `send-texts` stub (`tests/e2e/support/fixtures.mjs`) records each request the page made,
so E2E-ELF-04 and 07 assert on the exact body and the `Bearer` header. It answers in the spec's
response shape and writes `dry_run = true` rows.

### Open questions for Joe (tests currently take the reading shown)

*Joe's 2026-10-24 decisions answered 1 (dry runs never count toward the cap, and a dry run at the
cap still runs: ST-47, CT-05), 2 (yes: ST-25, ST-49, RATE-05), 3 (no: PICK-06, ST-48, CT-01),
4 (exact wording: MSG-12, ST-50) and 8 (skip and continue: ST-38, ST-49).*

1. **Is the cap applied in dry run?** The tests check the cap only in real mode and make no
   assertion either way for dry run.
2. **Does the rate limit count dry-run rows?** ST-25 says yes, so the limit can be tested
   without credits.
3. **Does a dry-run "sent" invite count as "already invited"?** No test pins this. If it counts,
   a dev dry run before go-live would make the first real Send invites skip everyone.
4. **Reveal format** `{budget/date if set}` isn't pinned exactly. The spec's `·` isn't GSM-7.
   The tests require `$20` and `Dec 19` to appear and the text to end `. Their list: <link>`.
5. **Whole-circle reveal while `sent`, and one-member reveal while `drawn`,** have no error
   text in the spec. The tests require only a 4xx with nothing sent.
6. **Quota at or below 5** reuses `text budget used up` (the spec lists no other text).
7. **How does the Edge Function read `private.text_budget`?** Answered in the contract:
   `public.text_budget_cap()`, a SECURITY DEFINER function executable by `service_role` only
   (TXB-08, TXB-09).
8. **A rate-limited member in a whole-circle batch** is skipped and reported, and the rest of
   the batch goes (ST-38). A one-member Re-send gets the request-level refusal (ST-14, ST-24).
9. **Invites after `sent`** are refused (ST-39). The spec says Re-send means the reveal then,
   but it gives no error text, so the tests require only a 4xx.

---

## Phase 3: Member page

Spec sections: *Pages* (`/m/#<token>`), *Interface contract → member_view, save_my_list,
set_list_done*, *Privacy rules*, *Wish list* (including "Lists stay editable after the
draw"), *Circle details*, *Stack* (escaping, `rel="noopener noreferrer"`), *Access rules →
Member*, *Shorter links* (16-character tokens). Master plan row 3. The approved look is
`design/preview.html` mocks (b) editor, (c) everyone's lists and (d) the reveal.

**Lead scope decision (2026-10-24):** the member side of the reveal is built now. When
`member_view` returns a non-null `match` (circle `sent`), the page shows "You drew {name}!" and
that member's list. The Elf-side draw UI stays in Phase 4.

**Status key:** every Phase 3 scenario is expected **red** until `m/index.html` and its
modules exist. The Vitest files load their module with a dynamic import, so a missing module
turns each test red on its own.

### Interface the tests assume (frontend-builder builds to this)

| Module | Exports |
|---|---|
| `m/index.html` | The member page, served at `/m/` (the static server maps `/m/` to `/m/index.html`). |
| `js/member.js` | The page script (not unit tested; it touches the DOM and supabase-js). |
| `js/token.js` (pure, no imports) | `tokenFromHash(hash) → string \| null`. Takes `location.hash` (the leading `#` is optional). Returns the token only when it's exactly 16 base64url characters (`A–Z a–z 0–9 - _`), else null. Never throws. |
| `js/wishlist.js` (pure; may import `./links.js`) | `MAX_WISHES = 10`, `MAX_TEXT = 200`, `MAX_URL = 500`, and `checkList({ about, items }) → { ok, about, items, errors }`. |

`checkList` mirrors `save_my_list` so the page never sends what the database refuses:

```
input   about: { fav_color, fav_snack, sizes, please_no }   -- any may be missing / null / ''
        items: [ { text, url } ]                            -- in screen order
output  about: same four keys; each trimmed, '' -> null
        items: [ { text, url } ] only (no position; save_my_list uses the array index)
               text trimmed; url trimmed, '' -> null
               a row whose text AND url are both blank is dropped (an untouched "Add another wish")
        errors: [ { field, index?, message } ]
               field: 'fav_color' | 'fav_snack' | 'sizes' | 'please_no' | 'items' | 'text' | 'url'
               index: the row's index in the INPUT array (so the page can mark that row)
               message: a non-empty, kid-friendly sentence; a url error mentions http:// or https://
        ok: errors.length === 0. When ok, { about, items } are exactly p_about and p_items.
```

**DOM hooks the e2e relies on** (from the mock and the spec wording):

- `header` holds the circle name, `$budget`, the swap date as `Dec 19` (with or without the
  weekday) and the place. The page's `h1` is the greeting, `Hi {first name}!`.
- About me inputs are labelled *Favorite color*, *Favorite snack…*, *Sizes* and *Please no…*.
- Each wish being edited is a `[data-test="wish-edit"]` element holding inputs labelled
  *What do you wish for?* and *Link (optional)*, and a *Remove* button. The add button's name
  matches `/add.*wish/i`. At 10 rows it is disabled or hidden.
- Wish text and About me inputs have `maxlength="200"`; the link input `maxlength="500"`.
- A button whose name starts with *Save* saves the list. On success
  `[data-test="save-status"]` shows text matching `/saved/i`.
- An invalid field gets `aria-invalid="true"` and an accessible description (the mock's
  `field__error`, as `js/ui.js` `fieldError` already does).
- The *I'm done!* button calls `set_list_done(true)`. Afterwards (and after a reload)
  `[data-test="done-state"]` is visible.
- Everyone's lists: one `[data-test="person"]` per member, with the name in a heading, About
  me, the wishes, and `Not done yet` for a member whose list isn't done. A wish link is an
  `<a href>` with `target="_blank"` and `rel` containing `noopener` and `noreferrer`.
- The reveal (only when `match` is non-null): text "You drew…", `[data-test="drawn-name"]`
  with the receiver's first name, and `[data-test="match-list"]` holding the receiver's About me
  and wishes. While sent, the member can still edit and save their own list (an *Edit my
  list* button may reveal the editor).
- An unknown or garbled link shows text matching `/link not found/i` and none of the editor.
- Changing the fragment in place (a `hashchange`, which is what editing the address bar does)
  must show the new token's page or "link not found", never the old token's data.

### TOK: token from the fragment (`tests/unit/token.test.js`)

Spec: *Pages* (token in the fragment), *Shorter links* (16 base64url characters), *Access
rules → Member* (unknown token reveals nothing).

| ID | Scenario |
|---|---|
| TOK-01 | `#` + 16 base64url characters gives those 16 characters, case preserved, with `-` and `_` allowed. Without the `#` it works too. |
| TOK-02 | Empty, `#`, null, undefined, a number and an object give null and never throw. |
| TOK-03 | 15 or 17 characters give null (the old 32-character tokens too). |
| TOK-04 | Anything outside base64url gives null: `+`, `/`, `=` padding, `%` escapes, spaces, `<script>`, a second `#`, a `?query`. |

### WL: list validation (`tests/unit/wishlist.test.js`)

Spec: *Wish list*, *Interface contract → save_my_list*, *Data model* (url http/https). The page
twin of LIST-02..09.

| ID | Scenario |
|---|---|
| WL-01 | The limits are exported: 10 wishes, 200 characters of text, 500 of link. |
| WL-02 | A good list is `ok` with no errors. About me and wish text are trimmed, blanks become null, and links are trimmed. Output items carry only `text` and `url`, in input order. |
| WL-03 | Missing or null About me fields and a missing `about` give four null fields. |
| WL-04 | Each About me field: 200 characters accepted, 201 rejected with that field named. |
| WL-05 | A wish with a link but empty or whitespace-only text is an error on `text` at that row's index. |
| WL-06 | A row with no text and no link is dropped, not an error, and not counted toward 10. |
| WL-07 | Wish text of 200 characters is accepted (also with surrounding spaces); 201 is rejected. |
| WL-08 | 10 wishes are accepted; 11 give an `items` error. |
| WL-09 | `javascript:` (any case, leading space), `data:`, `vbscript:`, scheme-less (`example.com/socks`) and protocol-relative links are an error on `url` at that row's index, and the message mentions `http`. |
| WL-10 | A 500-character link is accepted, 501 rejected. An empty link is null and fine. |
| WL-11 | Several problems give several errors, each pointing at its own row. |
| WL-12 | The input isn't mutated. |

### E2E-MEM: the member page (`tests/e2e/member.spec.js`, Playwright)

Spec: *Pages*, *The flow* 4 and 8, *Wish list*, *Circle details*, *Privacy rules*, *Access
rules → Member*, *Stack*.

**Setup** (SQL through `SUPABASE_DB_URL`, in `beforeAll`): three `[e2e]` circles owned by test
Elf A, each member with a fictional `+1555555 01xx` phone.
- *open*: Ava (empty list; the happy path), Ben (done, About me, a linked wish, an HTML-looking
  wish and a 120-character unbroken word), Cy (not done, empty), Dot (empty; the unhappy paths).
  The circle name itself contains `<i>…</i>`.
- *drawn*: Gus, Hal, Ivy with matches, status `drawn`.
- *sent*: Dee → Eli → Fay → Dee, status `sent`; Eli has a list.

Tokens are read server-side and never printed. Assertions about tokens and phones compare
booleans so a failure message can't print them. `afterAll` sweeps `[e2e]%` circles only (the
real circle "SecretSanta Test 1" is never touched).

| ID | Scenario |
|---|---|
| E2E-MEM-01 | Opening `/m/#<token>` shows the header (circle name, `$20`, `Dec 19`, `Maya's house`) and `Hi Ava!`. |
| E2E-MEM-02 | Ava fills About me and three wishes (one with an https link) and saves. The database holds the trimmed values with positions 0, 1, 2. After a reload the inputs show them again. |
| E2E-MEM-03 | Ava edits wish 2 and removes wish 1, then saves. The database holds exactly the two remaining wishes, in order, at positions 0 and 1. |
| E2E-MEM-04 | *I'm done!* sets `list_done` in the database and shows `[data-test="done-state"]`, which is still there after a reload. |
| E2E-MEM-05 | Everyone's lists: Ben's About me, wishes and link are shown, in first-name order with the others. Cy shows `Not done yet`. |
| E2E-MEM-06 | While `open`, there's no "You drew", no `drawn-name` and no `match-list` anywhere in the DOM, and `member_view` answered `match: null`. |
| E2E-MEM-07 | While `drawn`, the same: no hint of a match anywhere in the DOM, and `opened_at` is still null. |
| E2E-MEM-08 | **Reveal:** once `sent`, Dee sees "You drew…" with `drawn-name` = Eli and Eli's About me and wishes in `match-list`. `opened_at` is now set for Dee's match only. |
| E2E-MEM-09 | Once `sent`, Dee can still edit and save her own list, and the database has it ("Lists stay editable after the draw"). |
| E2E-MEM-10 | **Unhappy:** an unknown 16-character token, a garbled one, an old 32-character one and a page with no fragment each show "link not found", no editor and none of the open circle's names. |
| E2E-MEM-11 | **Unhappy:** editing the fragment in place to a garbled token shows "link not found" and drops Ava's data. Editing it to a token from another circle shows only that circle, with nothing from Ava's. |
| E2E-MEM-12 | **Unhappy:** a wish with a link but no text shows an inline error on the text field, and nothing is saved. |
| E2E-MEM-13 | **Unhappy:** a `javascript:` link and a scheme-less link each show an inline error on the link field, and nothing is saved. |
| E2E-MEM-14 | **Unhappy:** long text is capped: 250 characters typed into a wish or About me field leave at most 200 (and 500 for a link). Saving stores at most 200. |
| E2E-MEM-15 | **Unhappy:** after 10 wishes, the add button is disabled or hidden, an 11th row can't be added, and saving stores exactly 10. |
| E2E-MEM-16 | **Security** (as Cy, so all three RPCs run): the token never appears in any request URL or header. It travels only in POST bodies to `/rest/v1/rpc/…`. The page calls only `member_view`, `save_my_list` and `set_list_done`, never a table endpoint or `send-texts`. |
| E2E-MEM-17 | **Security:** no member's phone number (including Ava's own) appears in the page or in any response body from Supabase. |
| E2E-MEM-18 | **Security:** text that looks like HTML (a wish `<img src=x onerror=…>`, an About me `<b>…</b>` and the circle name's `<i>…</i>`) renders as literal text. No element is created and the handler never runs. |
| E2E-MEM-19 | **Security:** every wish link has `target="_blank"` and a `rel` containing `noopener` and `noreferrer`, in everyone's lists and in the reveal. |
| E2E-MEM-20 | **Layout:** at 375px wide, the member page (with a 120-character unbroken word) and the reveal page have no horizontal scroll. |

### Open questions (the tests take the reading shown)

1. **Save button or autosave?** The mock shows no Save button, but it does show "Could not save
   your list". The tests require an explicit button whose name starts with *Save* and a
   `[data-test="save-status"]` reading "Saved". If the builder prefers autosave, the e2e
   `save()` helper changes in the same PR.
2. **Reorder:** the mock has no reorder controls, so nothing tests it. Order is screen order.
3. **Blank rows:** an untouched extra wish row (no text, no link) is dropped quietly (WL-06). A
   row with a link but no text is an error (WL-05, E2E-MEM-12).
4. **Does "I'm done" also save?** Not pinned. The spec says only that it marks the list done.
5. **Is "me" listed among everyone's lists?** Not pinned either way.
6. **Undoing "I'm done"** (`set_list_done(false)`) is allowed by the RPC but has no UI in the
   mock, so nothing tests it.

---

## Phase 4: Elf draw and reveal

Spec sections: *The flow* 6–9, *Reshuffle*, *Peek*, *Re-send*, *Progress* ("after the draw"),
*Circle status*, *Draw rules*, *Texting* (`kind: 'reveal'`), *Security hardening* S6. The
approved look is `design/preview.html` mock (a) (the draw card) and (a2) (after the draw).
**Do-not-pair UI is out of this round** (lead). No-pair rows are seeded by SQL only. Its tests are in Phase 4b below.

**Status key:** E2E-DRAW-01..13, 17 and 19 are expected **red** until the Phase 4 UI lands.
E2E-DRAW-00, 14, 15, 16, 18, 20, 21 and 22 are already green: they pin backend behaviour, or
behaviour that already exists, and they must stay green.

### Safety

- `send-texts` is intercepted on every page by the stub in `tests/e2e/support/fixtures.mjs`, and
  textbelt.com is aborted. The stub now behaves like the real function for reveals: a
  whole-circle reveal needs `drawn` and moves the circle to `sent` **before** any row is
  written. A one-member reveal needs `sent`. It writes `dry_run = true` rows and answers
  `dry_run: true`. A test can make chosen members come back `failed` or `skipped` through the
  `sendStub` fixture.
- Circles are `[e2e] draw <key> <run>`, owned by test Elf A, with phones `+1555555020x`.
  `beforeAll` sweeps and seeds, `afterAll` sweeps. Nothing is deleted by any other key.
- **E2E-DRAW-00 / 22:** every circle **not** named `[e2e]%` (including Joe's real "SecretSanta
  Test 1") is snapshotted before the run: status, name, member count, matches and text count.
  It must be identical after the run.

### E2E-DRAW: the Elf's draw and reveal (`tests/e2e/draw.spec.js`, Playwright)

| ID | Scenario | Spec |
|---|---|---|
| E2E-DRAW-00 | Seeding changed no circle outside `[e2e]`. | Joe's rule |
| E2E-DRAW-01 | **Unhappy:** with 2 members (both done), **Draw names** is disabled and `[data-test="draw-reason"]` says "at least 3". | *Draw rules* |
| E2E-DRAW-02 | **Unhappy:** with Cy's list not done, Draw names is disabled. The reason says "every list must be done" and names Cy but not Ava (mock a: "Waiting for Zoe's list…"). | *Draw rules*, mock (a) |
| E2E-DRAW-03 | **Unhappy:** with seeded no-pairs that make every draw impossible, tapping Draw names shows "Can't make a draw with these do-not-pair rules. Try removing one." The circle stays `open` with no matches. | *Do-not-pair*, *Draw rules* |
| E2E-DRAW-04 | **Happy:** with 3 members all done, Draw names is enabled. Tapping it makes the circle `drawn` with 3 matches. Shuffle again, Undo draw and Send the names appear, and Draw names goes away. Show matches is unchecked, no match row is visible, and no "Giver → Receiver" text is on screen. | *The flow* 6, *Peek* |
| E2E-DRAW-05 | **Undo draw** returns the circle to `open` and deletes the matches, and Draw names is back. An in-page confirm is tolerated but not required. | *Circle status* |
| E2E-DRAW-06 | **Happy:** draw again, then **Send the names**. An in-page `<dialog data-test="confirm-send">` opens with the exact confirm text **and** "Practice mode: no real texts". Nothing is sent before confirming. Confirming sends one request, `{ circle_id, kind: 'reveal' }` with the Bearer JWT. The circle becomes `sent`, and each member's `[data-test="send-result"]` says sent. The practice banner shows. "Names have already been sent." appears, Undo/Draw are gone and Shuffle is gone or disabled. No native `alert`/`confirm` fired. | *The flow* 7, *Reshuffle*, S6 |
| E2E-DRAW-07 | **Show matches** (`[data-test="show-matches"]`) is off by default. When on, it lists exactly the `matches` table as `[data-test="match-row"]` "Giver → Receiver". It turns off again, and after a reload it is off (not remembered). | *Peek* |
| E2E-DRAW-08 | **Shuffle again** calls `reshuffle`. Within 10 shuffles of a 3-member circle the matches change (only 2 derangements exist), the circle stays `drawn`, and any match list on screen is the current draw, never a stale one. | *Reshuffle*, *Draw rules* |
| E2E-DRAW-09 | **Unhappy:** Cancel in the confirm sends nothing and leaves the draw and status unchanged. The dialog closes, and no native dialog fired. | *The flow* 7, S6 |
| E2E-DRAW-10 | Per-member results come **from the response**. With the stub returning Ava sent, Ben failed and Cy skipped, each `send-result` says so. Cy's "skipped" writes no row, so it can only come from the response. Ben's row pill reads "Text failed". | *The flow* 9, *Texting* |
| E2E-DRAW-11 | The drawn page, with matches shown and with the confirm open, has no horizontal scroll at 375px. | Brief |
| E2E-DRAW-12 | **Unhappy (shuffle after sending):** a `sent` circle shows "Names have already been sent.". There's no Draw names, Undo draw or Send the names, and Shuffle again is absent or disabled. | *Reshuffle*, *Circle status* |
| E2E-DRAW-13 | In a `sent` circle each row shows its **reveal** text status (Ava "Text sent", Ben "Text failed", Cy "Not sent yet"). Ava, whose `matches.opened_at` is set, shows "Opened ✓", and Ben and Cy show "Not opened yet". | *Progress*, *The flow* 9 |
| E2E-DRAW-14 | Re-send on one row of a `sent` circle sends `{ circle_id, kind: 'reveal', member_id }`. | *Re-send* |
| E2E-DRAW-15 | **Unhappy:** Elf A calling `reshuffle` / `undo_draw` / `start_draw` on a `sent` circle is refused ("names have already been sent/drawn"), and the matches are unchanged. | *Reshuffle*, contract errors |
| E2E-DRAW-16 | The sent page has no horizontal scroll at 375px. | Brief |
| E2E-DRAW-17 | The practice banner shows **on load** when the circle's most recent `texts` row has `dry_run = true`. | S6 |
| E2E-DRAW-18 | The banner does **not** show when the most recent row is a real send (`dry_run = false`; a seeded log row, nothing texted). | S6 |
| E2E-DRAW-19 | The banner shows after any send whose response has `dry_run: true` (here, a Re-send invite in a circle whose last row was real). | S6 |
| E2E-DRAW-20 | **Unhappy:** Elf B opening Elf A's circle sees "Circle not found", no draw or shuffle controls, and none of the kids' names. | *Access rules* |
| E2E-DRAW-21 | **Unhappy:** Elf B calling `start_draw` / `reshuffle` / `undo_draw` on Elf A's circles gets `circle not found`, and nothing changes. | *Access rules*, contract errors |
| E2E-DRAW-22 | The whole run changed no circle outside `[e2e]`. | Joe's rule |

### UI contract for the builder (pinned by the tests)

- **Buttons** (accessible names, exact): `Draw names`, `Shuffle again`, `Undo draw`,
  `Send the names`. Draw names is shown only while `open`. Disabled means native `disabled` or
  `aria-disabled="true"` (mock a uses `aria-disabled`; Playwright accepts both).
- `[data-test="draw-reason"]`: why Draw names is disabled. It says "at least 3" for fewer than 3
  members. With an unfinished list it says "every list must be done" and names the kids who
  aren't done.
- Draw errors from the RPC are shown verbatim (e.g. the do-not-pair message).
- `[data-test="show-matches"]`: a checkbox (`role="switch"`, as in mock a2), unchecked on every
  load. When on, each match is a visible `[data-test="match-row"]` whose text is
  `Giver → Receiver` (U+2192, single spaces), read from the `matches` table. When off, no
  match row is visible.
- `<dialog data-test="confirm-send">` opened with `showModal()` (never `window.confirm`). It
  contains `This texts everyone who they drew and locks the draw. You can't shuffle after this.`
  In practice mode it also contains `Practice mode: no real texts`. Its buttons are one whose
  name contains "Send the names" (confirm) and one named "Cancel".
- After a send: one `[data-test="send-result"][data-member-id="<member id>"]` per result in the
  response, containing the first name and `sent`, `failed` or `skipped`.
- `sent`: the text `Names have already been sent.` is visible. Each member row
  (`[data-test="member-row"]`) shows `Opened ✓` or `Not opened yet` from `matches.opened_at`
  (the giver's match row), next to the existing reveal text pill.
- `[data-test="practice-banner"]` containing `Practice mode: no real texts`. It shows on load
  when the circle's newest `texts` row (by `created_at`) is a dry run, and after any send-texts
  response with `dry_run: true`.

### Open questions (the tests take the reading shown)

1. **Shuffle after sending: absent or disabled?** The spec (*Reshuffle*) says disabled with the
   note "Names have already been sent."; the lead says no shuffle controls. The tests accept
   either, and require the note.
2. **Practice mode with no texts yet.** The UI can't know until the first send. The confirm then
   can't say "Practice mode". Not pinned. In E2E-DRAW-06 the circle has dry-run invites, so the
   phrase is required.
3. **Undo draw confirmation:** not specified. The tests tolerate an in-page one.
4. **Does Peek stay on after Shuffle again?** Not pinned. Either way, what's shown must be the
   current draw.
5. **Remove member uses `window.confirm`** today (Phase 2). The no-native-dialog rule is pinned
   only for Send the names.

---

## Phase 4b: Do-not-pair UI

Spec sections: *Do-not-pair (optional, Elf)* ("Off by default. Nothing appears unless the Elf
adds a pair."), *Circle status* (no-pair rules can't be changed unless `open`), *Data model*
`no_pairs` (stored with `member_a < member_b`, unique per circle), *Draw rules*, *Access
rules*, and the error `Can't make a draw with these do-not-pair rules. Try removing one.`
The database side is already built and tested (CON-12..14, ELF-12, ISO-04/10, DRAW-05..08,
LOCK-01/04/06). These tests pin the **UI** on `circle.html`.

**Status key:** E2E-NP-01..14 are expected **red** until the do-not-pair UI lands.
E2E-NP-00, 15, 16 and 17 pin existing behaviour (the guard, "not found" for another Elf, RLS)
and must stay green.

### Safety

- Same fixtures as Phase 4: send-texts is stubbed, textbelt.com is aborted, and nothing in this
  file sends a text at all.
- Circles are `[e2e] nopairs <key> <run>`, owned by test Elf A, with phones `+1555555030x`.
  `beforeAll` sweeps and seeds, `afterAll` sweeps, and nothing is deleted by any other key.
- **E2E-NP-00 / 17:** every circle **not** named `[e2e]%` (including Joe's real "SecretSanta
  Test 1") is snapshotted before the run: status, name, member count, **no-pairs**, matches and
  text count. It must be identical after the run.

### E2E-NP: the do-not-pair section (`tests/e2e/nopairs.spec.js`, Playwright)

| ID | Scenario | Spec |
|---|---|---|
| E2E-NP-00 | Seeding changed no circle outside `[e2e]`. | Joe's rule |
| E2E-NP-01 | **Off by default:** an open circle with no pairs shows only the quiet label "Never pair these two (optional)". The selects, the Add button and any pair rows are hidden until the label is clicked. Then both selects offer exactly this circle's kids. | *Do-not-pair* |
| E2E-NP-02 | **Unhappy:** picking the same kid in both selects and tapping Add shows an inline `[data-test="nopair-error"]` mentioning "different". No row is written. | *Do-not-pair*, CON-12 |
| E2E-NP-03 | **Happy:** adding Ava + Zed with the **larger member id picked first** writes one row with `member_a < member_b` (the UI sorts; the database would refuse the other order). It lists as "Ava ✕ Zed", has no error, survives a reload, and uses no native dialog. | *Data model* `no_pairs` |
| E2E-NP-04 | **Unhappy:** adding the same pair again, as Zed + Ava and as Ava + Zed, shows a friendly error mentioning "already", never the raw database text ("duplicate key", "violates", "constraint", "23505"). Still one row. | *Data model* (unique per circle) |
| E2E-NP-05 | **Remove** on one pair row deletes that pair only (DB and list). It needs no native dialog, and the kids are untouched. | *Do-not-pair* |
| E2E-NP-06 | A kid added through the Add a kid form appears in both selects without a reload. | *Do-not-pair* |
| E2E-NP-07 | **Unhappy:** pairs added **on the page** (Ava ✕ Ben, Cy + Ava) make a 3-kid draw impossible. Draw names shows exactly "Can't make a draw with these do-not-pair rules. Try removing one.". The circle stays `open` with no matches, and the pairs are still listed with Remove. | *Do-not-pair*, *Draw rules* |
| E2E-NP-08 | A pair added on the page (Ben + Ava) is honoured by Draw names and by 8 Shuffle again taps. After each one, SQL shows 4 matches with no Ava → Ben, no Ben → Ava and no self-match. | *Draw rules* |
| E2E-NP-09 | **`drawn`:** existing pairs are shown **read-only**: the rows show, but there are no selects, no Add and no Remove. The row is unchanged in the DB. | *Circle status* |
| E2E-NP-10 | **`drawn` with no pairs:** the section isn't shown at all (no label, no selects). | *Do-not-pair* ("nothing appears unless…") |
| E2E-NP-11 | **`sent`:** same as NP-09, read-only. | *Circle status* |
| E2E-NP-12 | After **Undo draw**, the section is editable again (Add and Remove are back). | *Circle status*, LOCK-06 |
| E2E-NP-13 | A kid named `<img src=x onerror=alert(1)>` shows as literal text in the select and the pair row. No `<img>` appears in the section, and no dialog fires. | Rule 7 (escape everything) |
| E2E-NP-14 | **375px:** with a 40-character name in the circle, the open section, both selects and Add stay within 375px. Native selects size themselves to their longest option, so they need `max-width: 100%` or similar. The page doesn't scroll sideways before or after adding the pair, and the new row fits. | Brief |
| E2E-NP-15 | **Unhappy:** Elf B opening Elf A's circle sees "Circle not found", no do-not-pair section, and no names or "✕". | *Access rules* |
| E2E-NP-16 | **Unhappy:** Elf B, through the API, reads no pairs of A's circle, can't insert one, and a delete changes nothing. | *Access rules* (RLS) |
| E2E-NP-17 | The whole run changed no circle outside `[e2e]`. | Joe's rule |

### UI contract for the builder (pinned by the tests)

- One container `[data-test="nopairs"]` on `circle.html`. While `open` it holds a visible,
  quiet label with the exact text **`Never pair these two (optional)`**. Clicking that text
  reveals the controls; a `<details>`/`<summary>` is the obvious fit. The tests click it only
  when the controls aren't already visible, so it may start expanded when pairs exist.
- Controls (only while `open`): `<select data-test="nopair-a">` and
  `<select data-test="nopair-b">`. Each `<option>` has the kid's first name as its label (a
  placeholder option with `value=""` is allowed and ignored). There's a button inside the
  container named `Add` or `Add pair`.
- On Add, the UI sorts the two member ids so that `member_a < member_b` before inserting.
- `[data-test="nopair-error"]` is an inline error: it mentions "different" for the same kid
  twice and "already" for a duplicate (either order; check locally or map Postgres `23505`).
  Never the raw database message.
- Each pair is a `[data-test="nopair-row"]` whose text is `Name ✕ Name` (U+2715). Either name
  order is accepted. While `open` it has a `Remove` button that deletes straight away (no
  native `confirm`).
- `drawn` / `sent`: **read-only**. The rows show, with no selects, no Add and no Remove. If
  there are no pairs, the whole section is hidden. *(Chosen for the "pick one" in the brief:
  read-only, so the Elf can see why a shuffle never pairs siblings.)*
- Draw errors are already shown verbatim (E2E-DRAW-03). NP-07 checks the same thing with pairs
  made on the page.
- Names are rendered with `textContent` (selects and rows).
- At 375px nothing passes the viewport's right edge, even with a 40-character name.

### Open questions (the tests take the reading shown)

1. **Read-only or hidden after the draw?** Read-only (NP-09/11), and hidden when there are no
   pairs (NP-10).
2. **Confirm before Remove?** None. A pair is cheap to re-add. The tests fail if a native
   `confirm` blocks it.
3. **Error wording** is pinned only loosely ("different", "already"), so the builder can
   phrase it kindly.
4. **Removing a kid who is in a pair** cascades in the DB. That isn't pinned here; the list
   should simply re-render.

---

## Later phases (planned, no test files yet)

These come from the agent brief and the spec, and they get written at the start of their phase.

| Area | Scenario | Spec | Phase | Planned file |
|---|---|---|---|---|
| (none right now) | | | | |

The Elf draw/shuffle/send and "shuffle after sending" moved into Phase 4 (E2E-DRAW). The do-not-pair UI moved into Phase 4b (E2E-NP, `tests/e2e/nopairs.spec.js`). The member happy path, the edited fragment and the member page at 375px moved into Phase 3
(E2E-MEM-02..05, 11 and 20). The member's "You drew" moved too (E2E-MEM-08, lead decision).

---

## Running the suite

Setup, once:

1. `npm ci` (dev tooling only: `pg`, `vitest`, `@playwright/test`, `@supabase/supabase-js`).
2. Copy `.env.example` to `.env` and set `SUPABASE_DB_URL` to the **session pooler (port 5432)
   or direct** connection string for project `hnnzoiuibnikrucncphu`. Test tooling reads only
   the names it needs from `.env` (`tests/tools/env.mjs`), never the Textbelt key.

| Suite | Command | Needs |
|---|---|---|
| pgTAP | `npm run test:sql` (`npm run test:sql -- draw` runs only files whose name contains `draw`) | `SUPABASE_DB_URL` |
| Vitest | `npm run test:unit` | nothing |
| Deno | `npm run test:deno` | `deno` 2.x on the PATH. Runs with net, env, write and run denied. |
| Playwright | `npm run test:e2e` | `SUPABASE_DB_URL`, the publishable key (`SUPABASE_PUBLISHABLE_KEY`, or read from `js/supabaseClient.js`), the four `E2E_ELF_*` credentials, Chromium (`npx playwright install chromium`, once). `TEXTS_DRY_RUN=true` is forced by `playwright.config.js`. |

**pgTAP safety.** The runner opens a transaction around each file and **always rolls it back**,
so the suite leaves the live database unchanged. Each file also starts with `begin;` and ends
with `rollback;` so it can be pasted into a SQL console on its own. The runner strips exactly
those two lines and rejects a file containing any other transaction statement (COMMIT, END,
ROLLBACK, BEGIN…). pgTAP must be installed in the `extensions` schema. The runner puts
`public, extensions` on the `search_path`.

**Playwright writes are real** (to project `hnnzoiuibnikrucncphu`), and global setup refuses
any other project. Every circle is named `[e2e] …`, and both test Elf emails end
`@secret-santa-e2e.invalid`. Global setup and teardown sweep the circles, and each spec file's
`afterAll` deletes its own `[e2e]` circles. Nothing is ever deleted by any other key. The
site is served by `tests/e2e/support/static-server.mjs` on `127.0.0.1:8787`, which refuses
dotfiles and the `supabase/`, `tests/`, `node_modules/` and `.zReference/` folders.
