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
  swap_date     date (nullable)
  swap_place    text (nullable)
  status        text  'open' | 'drawn' | 'sent'
  created_at    timestamptz

members
  id            uuid pk
  circle_id     uuid → circles
  first_name    text
  phone         text  (E.164, e.g. +15551234567; erased 7 days after swap_date)
  token         text unique              -- 32 random bytes, base64url
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
