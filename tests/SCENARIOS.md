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
| CON-06 | Phone may be null or a valid E.164 number. |
| CON-07 | Malformed phones are rejected: no `+`, leading 0, spaces, dashes, too short, too long, letters, empty string. |
| CON-08 | Budget below 0 is rejected; 0 and null are accepted. |
| CON-09 | Circle status defaults to `open` and accepts only `open`, `drawn`, `sent`. |
| CON-10 | Every member gets a generated token (32 random bytes, base64url, 43 characters), tokens differ, and a duplicate token is rejected. |
| CON-11 | `list_done` defaults to false. |
| CON-12 | A no-pair must be stored with `member_a < member_b`; the reverse order is rejected. |
| CON-13 | The same no-pair can't be stored twice in one circle. |
| CON-14 | A no-pair can't name a member from another circle. |
| CON-15 | A match where giver = receiver is rejected. |
| CON-16 | A match can't name a giver or receiver from another circle. |
| CON-17 | A member can be a giver only once and a receiver only once. |
| CON-18 | A wish-item link must be http or https; `javascript:` and `data:` are rejected at the table too. |
| CON-19 | Text `kind` is only `invite`/`reveal`; text `status` is only `sent`/`failed`. |

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
| MV-01 | Unknown or malformed tokens (empty, garbage, right length but wrong, a prefix of a real token, a real token in upper case, an injection string, null) all get `link not found`. |
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
| ERASE-02 | Phones are kept when the swap date was exactly 7 days ago, 6 days ago, today, in the future, or isn't set. |
| ERASE-03 | The function returns the number of phones it erased. |
| ERASE-04 | Erasing keeps everything else: members, names, lists and matches. |
| ERASE-05 | Erasing works on a `sent` circle (the lock doesn't get in the way). |
| ERASE-06 | Running it again straight away erases 0. |
| ERASE-07 | A pg_cron job runs it daily. |

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
| `supabase/functions/send-texts/core.ts` (pure, no imports except `../_shared/`) | `readSettings(env) → { dryRun, linksApproved, appBaseUrl }`, `budgetAllows({ texts, cap, batchSize }) → boolean`, `isRateLimited({ texts, memberId, now }) → boolean`, `pickRecipients({ kind, members, texts, memberId? }) → { send: Member[], skipped: { member_id, reason }[] }` |
| `supabase/functions/send-texts/provider.ts` | `makeTextbeltProvider({ key, fetch }) → { send(phone, message) }`. The only code that knows Textbelt. `fetch` is injected so tests never touch the network. |
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
db.getCap()               → private.text_budget.cap
db.insertText(row)        → row = { member_id, kind, status, provider_id, error, dry_run, quota_remaining, body }
db.lockCircleSent(id)     → boolean   // update ... set status='sent' where id=$1 and status='drawn'; true if a row changed
```

A text row in `getTexts()` is the raw row, so the cap, quota, rate-limit and "already invited"
rules are computed in `core.ts`, where they're tested. They aren't hidden in SQL the Deno suite
can't see.

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

| ID | Scenario |
|---|---|
| BUD-01 | The cap counts every real row (`dry_run = false`), **failed ones included**, across all circles. |
| BUD-02 | Dry-run rows never count, however many there are. |
| BUD-03 | A batch is allowed only if `used + batch ≤ cap`. One over the cap refuses the whole batch. |
| BUD-04 | At the cap, even a single text is refused. A batch of 0 is always allowed. |
| BUD-05 | The most recent recorded `quotaRemaining` at or below 5 refuses, and 6 allows. A later real row with no quota (a failed send) doesn't reset it. A later higher value (Joe bought credit) allows again. |
| BUD-06 | Dry-run rows' quota values (if any) are ignored. |

### RATE: 3 texts per member per hour (`core_test.ts`)

Spec: *Re-send* ("Limited to 3 re-sends per member per hour"), *Texting* ("at most 3 texts per member per hour").

| ID | Scenario |
|---|---|
| RATE-01 | 2 texts in the last hour: not limited. 3: limited (the next would be the 4th). |
| RATE-02 | Failed texts count. |
| RATE-03 | Texts older than an hour don't count. |
| RATE-04 | Only this member's texts count. |

### PICK: who gets texted (`core_test.ts`)

Spec: *Texting details → Who gets texted*.

| ID | Scenario |
|---|---|
| PICK-01 | Invite batch: members with a successful real invite are not texted. Members whose only invite **failed** are texted again. |
| PICK-02 | Invite batch: a member with no phone is skipped and reported (`skipped` includes them), not an error. |
| PICK-03 | Reveal batch: every member with a phone is texted exactly once, even if they had invites. |
| PICK-04 | One member (`memberId`): just that member, even if they already have a successful invite (Re-send is explicit). |
| PICK-05 | One member with no phone: skipped, not texted. |

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
| ST-28 | **Reveal:** if the `drawn → sent` lock doesn't take (someone else already sent), nothing is sent. |
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

### PH: phone normalisation (`tests/unit/phone.test.js`)

Spec: *Data model* (E.164), *Constraints* (`^\+[1-9][0-9]{7,14}$`), *The flow* 2.

| ID | Scenario |
|---|---|
| PH-01 | US 10-digit numbers in every common format (`5555550123`, `555-555-0123`, `(555) 555-0123`, `555.555.0123`, `555 555 0123`) become `+15555550123`. |
| PH-02 | 11 digits with a leading 1 (`1 555 555 0123`, `1-555-555-0123`) and `+1` forms become `+15555550123`. |
| PH-03 | An international number already in `+` form is kept (`+44 20 7946 0958` becomes `+442079460958`). |
| PH-04 | Junk gives null: empty, spaces, null, undefined, letters, a vanity number (`1-800-FLOWERS`), 7 digits, 9 digits, 11 digits not starting with 1, 16+ digits, an extension, `++1…`, `+0…`, punctuation only, emoji, and an object. |
| PH-05 | Every non-null output matches the spec's E.164 pattern. |
| PH-06 | Normalising twice gives the same answer. |

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

## Later phases (planned, no test files yet)

These come from the agent brief and the spec, and they get written at the start of their phase.

| Area | Scenario | Spec | Phase | Planned file |
|---|---|---|---|---|
| Playwright | Elf: draw, shuffle, send the names, and "Names have already been sent." after | *The flow* 6–9, *Reshuffle* | 4 | `tests/e2e/elf.spec.js` (extend) |
| Playwright | Member happy path: open link, fill list, I'm done, "You drew" after the draw | *The flow* 4 and 8 | 3, 4 | `tests/e2e/member.spec.js` |
| Playwright | A member edits the URL fragment to another token | *Privacy rules* | 3 | `tests/e2e/unhappy.spec.js` |
| Playwright | The Elf tries to shuffle after sending ("Names have already been sent.") | *Reshuffle* | 4 | `tests/e2e/unhappy.spec.js` |
| Playwright | 375px wide, no horizontal scroll on the member page (the Elf circle page is E2E-ELF-11) | master plan phase 5 | 5 | `tests/e2e/layout.spec.js` |

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
