# Secret Santa — Spec

A tiny Secret Santa app for a group of kids. One adult (the **Elf**) runs each **Circle**. Kids fill in a wish list, the Elf starts the draw, and the app texts each kid who they drew.

**Guiding rule: super simple.** Wherever two designs both work, pick the one with fewer screens, fields and moving parts.

---

## Roles

| Role | Who | How they get in |
|---|---|---|
| **Elf** | A parent who runs the circle. Not in the draw. | Email magic link (Supabase Auth, built in and free). |
| **Member** | A kid in the circle. | A private personal link, `/m/#<token>`. No account, no password, no email. |

Members never create Supabase accounts. Their link is their login.

## Privacy rules (enforced in the database, not just hidden on the page)

1. **Wish lists are public within the circle.** Any member of the circle can read every member's list. Nobody outside the circle can.
2. **Matches are private.** A member can see only their own match. The Elf can see all of them.
3. **Collect as little as possible about the kids.** First name and a mobile number, nothing else. No emails, birthdays or schools.
4. **Phone numbers are for sending texts only.** The Elf and the server-side texting function can read them. Members never see anyone's number, including through `member_view`. Numbers are erased 7 days after the swap date.

---

## The flow

1. **Elf signs in** with email and creates a Circle: name, **budget** (e.g. $20), **swap date**, and an optional place.
2. **Elf adds members** by first name and mobile number. Each member gets a personal link.
3. **The app texts each member their link** when the Elf taps **Send invites**: "Hi Maya! 🎅 You're in the Secret Santa for *Ava's Crew*. Add your wish list here: <link>".
4. **Members fill in their list** (see *Wish list* below) and tap **I'm done**.
5. **Elf watches progress**: a checklist showing which lists are done, e.g. "6 of 8 done".
6. **Elf draws names** once every list is done. The draw happens in the database (see *Draw rules*). Nothing is sent yet. The Elf can peek and **Shuffle again** as often as they like.
7. **Elf taps Send the names.** The app texts every member who they drew: "🎁 Maya, you drew **Ava**! Budget $20 · swap Fri Dec 19. Ava's wish list: <link>". This locks the draw.
8. **Members open their link** for the full list. Their page shows **"You drew: ___"** with that person's wish list underneath.
9. **Elf watches delivery**: each member shows whether their text was sent, failed or opened.

---

## Features

### Circle details
- Budget (whole dollars), swap date, optional place.
- Shown at the top of every member's page: **"$20 · Fri Dec 19 · Maya's house"**.
- The Elf can edit these at any time.

### Wish list (one per member)
- **Wishes**: up to 10 items, each with text and an optional link.
- **About me** (all optional, single short text fields):
  - Favorite color
  - Favorite snack / treat
  - Sizes (shirt, shoe, etc. as one free-text field)
  - Please no… (allergies, things they already have, dislikes)
- **I'm done** button. This marks the list done for the Elf's progress checklist.
- **Lists stay editable after the draw.** Kids can keep adding ideas, and their Santa sees the updates.

### Progress (Elf)
- Before the draw: each member with ✓ or ✗ for list done, plus "X of Y done".
- After the draw: each member with ✓ or ✗ for "opened their match".

### Do-not-pair (optional, Elf)
- The Elf can add pairs who must not draw each other, in either direction (e.g. siblings).
- Off by default. Nothing appears unless the Elf adds a pair.
- If the pairs make a valid draw impossible, the draw fails with a plain message: "Can't make a draw with these do-not-pair rules. Try removing one."

### Re-send (Elf)
- Every member row has a **Re-send** button. Before the names are sent, it re-sends the invite. After, it re-sends the "you drew" text.
- It uses the **same** link, so an old text still works.
- **Copy link** is also there as a backup in case a text doesn't arrive.
- Limited to 3 re-sends per member per hour, so a stuck button can't run up the texting bill.

### Reshuffle (Elf)
- **Shuffle again** throws away the current draw and makes a new one.
- **Only allowed until the Elf taps Send the names.** After that the button is disabled with the note "Names have already been sent."

### Peek (Elf)
- The full who-drew-whom list is hidden behind a **Show matches** toggle, so it isn't on screen by accident.

---

## Draw rules

- At least **3 members**. With 2, each kid would know who drew them.
- Every member's list is marked done.
- **Nobody draws themselves.**
- No do-not-pair rule is broken, in either direction.
- Each member gives exactly one gift and gets exactly one.
- The result is uniformly random among valid draws. For circles this small, "shuffle, check, retry up to 1,000 times" is fine.
- Two kids drawing each other (A→B and B→A) is allowed.
- The draw runs inside one database function, so it either fully succeeds or changes nothing.

### Circle status
`open` → `drawn` → `sent`.
- `drawn`: matches exist, and only the Elf can see them. **Shuffle again** is allowed. Members can't be added or removed, and do-not-pair rules can't be changed. **Undo draw** goes back to `open`.
- `sent`: the reveal texts have gone out. The draw is final.
- Members see their match only once the circle is `sent`.

---

## Data model (Supabase / Postgres)

```
circles
  id            uuid pk
  elf_id        uuid → auth.users        -- owner
  name          text
  budget        int  (dollars, nullable)
  swap_date     date not null              -- required (Joe, 2026-10-24); the Elf can change it any time
  swap_place    text (nullable)
  status        text  'open' | 'drawn' | 'sent'
  created_at    timestamptz

members
  id            uuid pk
  circle_id     uuid → circles
  first_name    text
  phone         text  (E.164, e.g. +15551234567; erased 7 days after swap_date)
  token         text unique              -- 12 random bytes (96 bits), base64url = exactly 16 chars, no padding (Joe, 2026-10-24: shorter links)
  fav_color     text
  fav_snack     text
  sizes         text
  please_no     text
  list_done     bool default false
  created_at    timestamptz

wish_items
  id            uuid pk
  member_id     uuid → members
  text          text
  url           text (nullable, must be http/https)
  position      int

no_pairs
  circle_id     uuid → circles
  member_a      uuid → members
  member_b      uuid → members           -- stored with a < b; unique per circle

matches
  circle_id     uuid → circles
  giver_id      uuid → members  unique
  receiver_id   uuid → members  unique
  opened_at     timestamptz (nullable)   -- set the first time the giver views it

texts                                     -- one row per text sent; drives the delivery column
  id            uuid pk
  member_id     uuid → members
  kind          text  'invite' | 'reveal'
  status        text  'sent' | 'failed'
  provider_id   text (nullable)          -- the texting provider's message id
  error         text (nullable)
  created_at    timestamptz
```

The token is stored in plain text so the Elf can re-send the same link. Only the Elf who owns the circle can read it.

## Access rules

**Elf** (signed in, `auth.uid() = circles.elf_id`):
- Uses row-level security (RLS) for full read/write on their own circles, members, wish items and no-pairs. Read-only on matches and texts.
- Can only draw or reshuffle through `start_draw(circle_id)`, `reshuffle(circle_id)` and `undo_draw(circle_id)`, which check ownership and the draw rules.
- Sends texts only through the `send-texts` Edge Function (see *Texting*).

**Member** (anonymous, holds a token):
- Has **no** direct table access. The anon role is granted nothing on these tables.
- Gets everything through a few `SECURITY DEFINER` functions that look up the member by token:
  - `member_view(token)`: circle details, every member's first name and list, and, if the circle is `sent`, **only this member's own match**. It also sets `opened_at` the first time the match is returned.
  - `save_my_list(token, about_me, items)`: replaces this member's own list.
  - `set_list_done(token, done)`
- An unknown token gets a generic "link not found" error, which reveals nothing.
- Each function sets `search_path` explicitly.

### Interface contract (tests and implementation both follow this exactly)

**Member RPCs** (granted to `anon, authenticated`; `security definer`):

```
member_view(p_token text) returns jsonb
  {
    "circle":  { "name", "budget", "swap_date", "swap_place", "status" },
    "me":      <member>,
    "members": [ <member>, ... ],        -- everyone in the circle including me, ordered by first_name
    "match":   null | <member>           -- non-null only when circle.status = 'sent'
  }
  <member> = { "id", "first_name", "fav_color", "fav_snack", "sizes", "please_no", "list_done",
               "items": [ { "text", "url", "position" }, ... ] }   -- ordered by position
  -- Never contains: phone, token, created_at, opened_at, no-pair data, anyone else's match.
  -- Sets matches.opened_at = now() the first time a non-null match is returned.

save_my_list(p_token text, p_about jsonb, p_items jsonb) returns void
  p_about: { "fav_color", "fav_snack", "sizes", "please_no" }   -- each nullable, trimmed, ≤ 200 chars
  p_items: [ { "text", "url" } ]   -- ≤ 10 items; text trimmed, 1–200 chars; url null or http(s) only, ≤ 500 chars
  Replaces all of this member's items; position = array index. Allowed in every circle status.

set_list_done(p_token text, p_done boolean) returns void
```

**Elf RPCs** (granted to `authenticated` only; caller must own the circle):

```
start_draw(p_circle_id uuid) returns void   -- open  → drawn
reshuffle(p_circle_id uuid)  returns void   -- drawn → drawn, new matches
undo_draw(p_circle_id uuid)  returns void   -- drawn → open, matches deleted
```

**Internal** (no client grant): `erase_old_phones() returns int`. Run daily by pg_cron. It sets
`phone = null` where `swap_date + 7 < current_date` and returns the count.

**Elf direct table access (RLS):**
- `circles`: insert / select / update / delete their own. `elf_id` defaults to `auth.uid()`.
  **`status` and `elf_id` are not client-writable.** Only the RPCs and the Edge Function change
  status.
- `members`: insert / select / update / delete in their own circles. `token` is generated by
  default and isn't client-writable.
- `wish_items`: full access in their own circles.
- `no_pairs`: insert / select / delete in their own circles.
- `matches` and `texts`: select only.

**Constraints:**
- `first_name`: trimmed, 1–40 characters, unique per circle case-insensitively.
- `phone`: null or E.164 (`^\+[1-9][0-9]{7,14}$`).
- `budget`: ≥ 0.
- `no_pairs`: `member_a < member_b`, both in the same circle.
- `matches`: giver ≠ receiver, both in the same circle as the match.

**Error messages** (exact text; tests match on it):

| Situation | Message |
|---|---|
| Unknown / malformed token | `link not found` |
| Elf RPC on a circle that isn't theirs, or doesn't exist | `circle not found` |
| Draw with < 3 members | `need at least 3 members` |
| Draw while a list isn't done | `every list must be done before the draw` |
| No valid draw exists | `Can't make a draw with these do-not-pair rules. Try removing one.` |
| `start_draw` when not `open` | `names have already been drawn` |
| `reshuffle` / `undo_draw` when `open` | `names have not been drawn yet` |
| `reshuffle` / `undo_draw` when `sent` | `names have already been sent` |
| Add/remove member or change no-pairs when not `open` | `circle is locked after the draw` |
| `save_my_list` validation failure | `invalid list: <reason>` |

**Never exposed to members:** phone numbers (including their own), other members' tokens, other members' matches, no-pair rules.

---

## Texting

The app sends every text itself, through one Supabase **Edge Function**, `send-texts`.

- **Provider: [Textbelt](https://textbelt.com)** (paid, about $3 per 50 texts). There's no monthly fee and no carrier registration, and an 8-kid circle costs well under $1. Twilio's free trial can only text 5 pre-verified numbers and adds a "trial account" prefix. Twilio's paid plan needs a monthly number fee plus carrier registration.
- **Swappable.** The provider call is about 10 lines inside the Edge Function, so switching to Twilio later doesn't touch anything else.
- **Links need approval.** Textbelt blocks texts containing URLs until the account is activated for the app's domain, via their whitelist request. Shortened links (bit.ly etc.) are always blocked, so we send the full link. **This is a setup step before the first real invite.**
- **The API key** is stored as a Supabase Edge Function secret. It never appears in the browser or the repo.
- **Inputs:** `{ circle_id, kind: 'invite' | 'reveal', member_id? }`. The function checks that the caller is the circle's Elf. It reads names, numbers and matches with the service role, sends the texts, and logs a row in `texts` for each one.
- `kind: 'reveal'` for the whole circle is allowed only from `drawn` and moves the circle to `sent`.
- Rate limit: at most 3 texts per member per hour.
- **Test mode:** with `TEXTS_DRY_RUN=true`, nothing is sent. The function logs the message text to `texts` instead, for local development and tests.

### HARD LIMITS (Joe, 2026-10-18; these override everything else in this section)

**1. Texts are scarce and paid for.** The key starts with **50 credits** (as of 2026-10-18). Joe
may buy more later, up to about 700 in total.
- The Edge Function enforces a **lifetime cap** on real sends. The cap is a value in the
  database, **starting at 45** (keeping 5 in reserve), and only Joe changes it, for example when
  he buys more credit. The function counts every row in `texts` with `dry_run = false`,
  including failed sends, since a failed send may still have cost a credit. At the cap it
  refuses with `text budget used up`. The refusal happens **before** the provider is called.
- After every real send, the function records Textbelt's `quotaRemaining`. It refuses further
  sends once that value is at or below the reserve (5), even if the cap hasn't been reached.
- Before a batch (invites or reveal for a whole circle), the function checks that the whole
  batch fits under the cap. If it doesn't, it sends nothing.
- **Testing never uses real credits.** Unit, Deno and e2e tests use dry run only. Integration
  with Textbelt is checked with Textbelt's `_test` key suffix (no send, no charge), and only if
  Joe allows it.
- **No agent ever sends a real text.** Joe sends real texts himself. The only real texts during
  development are ones Joe explicitly asks for, one at a time, to his own phone.

**2. No texts containing links until Joe says the Textbelt URL whitelist is approved.** **Joe confirmed the approval on 2026-10-24**, so `TEXT_LINKS_APPROVED=true` may be set at deploy. Real sends still happen only when Joe triggers them.
- A setting, `TEXT_LINKS_APPROVED`, defaults to **false**. Only Joe flips it.
- While it's false, any real send whose message contains a URL is refused **before** calling
  the provider, with `links not approved yet`, and doesn't count against the cap. Dry runs can
  still contain links.
- The only real texts allowed before approval are link-free test texts to Joe's phone, sent
  when Joe asks.

`texts` gains `dry_run boolean not null` and `quota_remaining int null`.

### Texting details (Phase 2 contract)

**Where the cap lives.** In `private.text_budget`, a single-row table holding `cap int not null default 45`.
It has no client grants, and Joe changes the value with SQL.

**Dry-run bodies.** `texts` gains `body text null`. It's filled **only** for dry-run rows, so
tests and the Elf can see exactly what would have been sent. It stays null for real sends.

**Message format (credit-saving; one text must equal one credit):**
- **≤ 160 characters, GSM-7 characters only. No emoji, no curly quotes.** An emoji or a
  161st character splits the text into multiple billed segments. The builder replaces curly
  quotes and dashes with plain ones and drops anything else outside GSM-7.
- Circle names and first names are shortened (with `...`) to make the text fit. The link is
  never shortened.
- Link format: `https://jheasley322.github.io/secret_santa/m/#<token>`. The base URL is a
  setting, `APP_BASE_URL`.
- Invite: `Secret Santa! Hi {name}, add your wish list for {circle}: {link}`
- Reveal: `Secret Santa! {name}, you drew {receiver}! {budget/date if set}. Their list: {link}`
- Before Joe approves links (`TEXT_LINKS_APPROVED=false`), **real** invites and reveals are
  refused (`links not approved yet`). There's no link-free fallback, because the link is the
  whole point.

**Who gets texted (don't waste credits):**
- **Send invites** (whole circle) texts only members with **no successful invite yet**.
  Members with a sent invite are skipped.
- **Send the names** (whole circle) texts every member once.
- **Re-send** (one member) is explicit: an invite while the circle isn't `sent`, a reveal once
  it is. It's subject to the 3-per-member-per-hour limit.
- A member with no phone number is skipped and reported, never an error for the whole batch.

**Edge Function interface:**
- `POST send-texts` with `{ circle_id, kind: 'invite' | 'reveal', member_id? }` and the
  Elf's JWT.
- The response is `{ sent, failed, skipped, dry_run, results: [{ member_id, status, error? }] }`,
  where `status` is `sent`, `failed` or `skipped`.
- Refusals for the whole request return HTTP 4xx with `{ error }`, using exactly these texts:
  - `circle not found`
  - `text budget used up`
  - `links not approved yet`
  - `too many texts, try again in an hour`
  - `names have not been drawn yet` (a reveal before `drawn`)
- **Order of checks:** auth and ownership, then status, then cap (the whole batch must fit),
  then the links gate, then the per-member rate limit, then send.

**Decisions from Joe (2026-10-24):**
1. **Dry-run invites don't count as "already invited".** The first real Send invites still
   texts everyone.
2. **Dry-run sends count toward the 3-per-member-per-hour rate limit**, but never toward the
   credit cap.
3. **In a batch, a rate-limited member is skipped** (`skipped`) and the rest still send.
4. **Reveal wording is approved:** `Secret Santa! Maya, you drew Ava! $20, Dec 19. Their list: <link>`
5. **A phone number is required** when adding a member. A kid without a phone uses a parent's
   number.
6. **Concurrent sends must not get past the cap.** Two simultaneous `send-texts` calls for any
   circle must be serialised in the database, so the cap check and the reservation of the
   batch's slots are atomic. The worst case must be zero over-spend, not "one extra batch".
7. **Every circle must have a swap date.** It's required when the circle is created, and the
   Elf can change it later in any status. This means every phone number is eventually erased.
8. **Help pages point people to "ask your Elf"**, never a named person.

**Security hardening (from the audit, 2026-10-24; lead decisions):**
- **S1. A lifetime counter that deletes can't reset.** `private.text_budget` gains
  `used int not null default 0` and `last_quota int`. Every real send is claimed **before**
  calling the provider, through `public.claim_text_credits(p_circle_id uuid, p_n int)`
  (service_role only). In one transaction, it:
  - locks the circle row,
  - re-checks the cap (`used + n <= cap`) and the reserve (`last_quota` is null or `> 5`),
  - increments `used`.
  Deleting circles, members or texts never lowers `used`. Claimed-but-unsent credits stay
  counted (fail closed). `last_quota` is written after each real send through a service-role
  RPC. This replaces counting `texts` rows for the cap.
- **S2. Only approved Elves.**
  - Supabase Auth sign-ups are disabled (Joe, in the dashboard), and the client uses
    `shouldCreateUser: false`.
  - `send-texts` also checks an `ELF_USER_IDS` allow-list (an Edge secret) straight after
    verifying the JWT and before any service-role client. Anyone not on the list gets
    `circle not found`.
  - Phone numbers are **US only** (`+1`) at the DB check.
- **S3. Serialise per circle.** The duplicate-invite filter and the 3-per-hour rate limit are
  re-checked under the same circle lock as S1. `pending` text rows are inserted in that
  transaction and updated to `sent`/`failed` after the provider call, so parallel requests
  can't double-text a kid.
- **S4.** The "texting is not set up" check moves after the auth check.
- **S5.** Revoke execute on `public.rls_auto_enable()` from public, anon and authenticated.
- **S6. Practice mode is loud.** The Phase 4 UI shows a "Practice mode: no real texts" banner
  whenever dry run is on, and confirms before a dry-run Send the names locks the draw.

**Lead decisions on the S1–S3 contract (2026-10-24; full contract in tests/SCENARIOS.md under CLM, CT and RLSA):**
- Use `claim_texts(p_circle_id, p_kind, p_member_ids, p_dry_run, p_resend) returns jsonb` plus
  `claim_text_credits` and `record_text_quota`. All three are service_role only.
- Inside `claim_texts`, lock the circle with `FOR UPDATE` as its own statement, then read.
- **A whole-circle reveal moves `drawn → sent` inside `claim_texts`**, atomically with the
  claim, so a losing concurrent reveal claims nothing.
- Phone is required on insert (BEFORE INSERT trigger, `phone number required`). The Elf
  (`authenticated`) also can't update a phone to null. Only erasure (postgres or service_role)
  can null it.
- **US phones:** `^\+1[0-9]{10}$`.
- A missing or empty `ELF_USER_IDS` lets nobody in.
- **Shorter links (Joe, 2026-10-24):**
  - Member tokens are 16 base64url characters (12 random bytes, 96 bits).
  - Existing members get new 16-character tokens in the same migration. That's safe while
    nobody has been texted; after real texts go out, tokens must never be reissued.
  - The link becomes `https://jheasley322.github.io/secret_santa/m/#<16 chars>`, about 61
    characters.
- Claimed but unsent `pending` rows end as `failed`, which keeps them counted. If writing a log
  row fails, **stop the batch** (fail closed) and report an error.


---

## Stack

- Static HTML + ES modules + one CSS file. No build step, no npm runtime dependencies.
- `supabase-js` loaded from a CDN with a pinned version.
- Free hosting (GitHub Pages or Netlify).
- Supabase free tier. The built-in auth email limit (a few per hour) is fine for one Elf.
- One Supabase Edge Function (`send-texts`, Deno) for SMS. This is the only server code.
- Everything a user typed is escaped when shown. Wish links open with `rel="noopener noreferrer"`.

## Pages

| Page | Who | Purpose |
|---|---|---|
| `/` | Elf | Sign in, list my circles, create a circle |
| `/circle.html?id=…` | Elf | Circle details, members (name + number) with Re-send / Copy link and text status, progress, do-not-pair, draw / shuffle again / show matches / send the names |
| `/m/#<token>` | Member | Circle header, my list editor + I'm done, everyone's lists; after the draw: "You drew ___" + their list |

The token lives in the URL **fragment** (`#`), so it isn't sent to the server or written to access logs.

---

## Out of scope
Chat, anonymous questions, member accounts, push or email notifications, replies to texts, multiple Elfs per circle, gift purchase tracking.
