// E2E-DRAW-01..22: the Elf's draw and reveal on circle.html (Phase 4).
// Spec: "The flow" 6-9, "Reshuffle", "Peek", "Re-send", "Progress",
// "Circle status", "Draw rules", "Texting" (reveal), "Security hardening" S6.
// Approved layout: design/preview.html mock (a) draw card and (a2) after the draw.
// Scenario IDs and the DOM contract are in tests/SCENARIOS.md (Phase 4).
//
// SAFETY: every page uses support/fixtures.mjs: send-texts is intercepted and
// answered by a local dry-run stub (the deployed function is never reached),
// and textbelt.com is aborted. Circles are "[e2e] ..." owned by test Elf A
// (one check uses Elf B's session), swept before and after, never by any other
// key. Phones are fictional +1 555 555-02xx. Circles not named "[e2e]%" (for
// example Joe's real "SecretSanta Test 1") are snapshotted before the run and
// must be byte-for-byte unchanged after it (E2E-DRAW-00).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { test, expect } from './support/fixtures.mjs'
import { AUTH_DIR, E2E_PREFIX, SUPABASE_URL, publishableKey, sweepCircles, withDb } from './support/project.mjs'

const RUN = Date.now()
const user = label => JSON.parse(readFileSync(join(AUTH_DIR, `${label}.user.json`), 'utf8'))
const accessToken = label => {
  const state = JSON.parse(readFileSync(join(AUTH_DIR, `${label}.json`), 'utf8'))
  return JSON.parse(state.origins[0].localStorage[0].value).access_token
}
const PRACTICE = 'Practice mode: no real texts'
const CONFIRM_TEXT = "This texts everyone who they drew and locks the draw. You can't shuffle after this."

// circle key -> id, `${circleKey}.${first}` -> member id
const C = {}
const M = {}
let realSnapshot = null

// ------------------------------------------------------------------ seeding

/** Everything about circles that are NOT [e2e]: the run must leave it unchanged. */
async function snapshotRealCircles (db) {
  const { rows } = await db.query(`
    select c.id, c.status, c.name,
      (select count(*)::int from public.members m where m.circle_id = c.id) as members,
      (select count(*)::int from public.matches x where x.circle_id = c.id) as matches,
      (select coalesce(string_agg(x.giver_id::text || x.receiver_id::text, ',' order by x.giver_id), '') from public.matches x where x.circle_id = c.id) as pairs,
      (select count(*)::int from public.texts t join public.members m on m.id = t.member_id where m.circle_id = c.id) as texts
    from public.circles c where c.name not like '[e2e]%' order by c.id`)
  return rows
}

async function seed () {
  await withDb(async db => {
    await sweepCircles(db)
    realSnapshot = await snapshotRealCircles(db)
    let n = 200
    const phone = () => `+1555555${String(n++).padStart(4, '0')}`

    async function circle (key, owner = 'elf_a') {
      const { rows: [c] } = await db.query(
        `insert into public.circles (elf_id, name, budget, swap_date, swap_place)
         values ($1, $2, 20, '2026-12-19', 'Maya''s house') returning id`,
        [user(owner).id, `${E2E_PREFIX} draw ${key} ${RUN}`])
      C[key] = c.id
      return c.id
    }
    async function members (key, list) {
      for (const [first, done] of list) {
        const { rows: [m] } = await db.query(
          'insert into public.members (circle_id, first_name, phone, list_done) values ($1, $2, $3, $4) returning id',
          [C[key], first, phone(), done])
        M[`${key}.${first}`] = m.id
      }
    }
    async function texts (key, rows) {
      for (const [first, kind, status, dry] of rows) {
        await db.query(
          'insert into public.texts (member_id, kind, status, dry_run, body, error) values ($1, $2, $3, $4, $5, $6)',
          [M[`${key}.${first}`], kind, status, dry, dry ? `practice ${kind}` : null, status === 'failed' ? 'carrier rejected' : null])
        await db.query('select pg_sleep(0.01)') // distinct created_at, so "most recent" is well defined
      }
    }
    async function lock (key, pairs, status, opened = []) {
      for (const [g, r] of pairs) {
        await db.query('insert into public.matches (circle_id, giver_id, receiver_id, opened_at) values ($1, $2, $3, $4)',
          [C[key], M[`${key}.${g}`], M[`${key}.${r}`], opened.includes(g) ? new Date() : null])
      }
      await db.query("update public.circles set status = 'drawn' where id = $1", [C[key]])
      if (status === 'sent') await db.query("update public.circles set status = 'sent' where id = $1", [C[key]])
    }
    const kids = (done = true) => [['Ava', done], ['Ben', done], ['Cy', done]]
    const invites = key => texts(key, kids().map(([f]) => [f, 'invite', 'sent', true]))

    // happy path: open, everyone done, practice-mode invites already out
    await circle('ready'); await members('ready', kids()); await invites('ready')
    // can't draw yet
    await circle('two'); await members('two', [['Ava', true], ['Ben', true]])
    await circle('waiting'); await members('waiting', [['Ava', true], ['Ben', true], ['Cy', false]])
    // do-not-pair rules that make every draw impossible: Ava may give to nobody
    await circle('impossible'); await members('impossible', kids())
    for (const other of ['Ben', 'Cy']) {
      const [a, b] = [M['impossible.Ava'], M[`impossible.${other}`]].sort()
      await db.query('insert into public.no_pairs (circle_id, member_a, member_b) values ($1, $2, $3)', [C.impossible, a, b])
    }
    // drawn: peek, shuffle, cancel the confirm, 375px
    await circle('drawn'); await members('drawn', kids()); await invites('drawn')
    await lock('drawn', [['Ava', 'Ben'], ['Ben', 'Cy'], ['Cy', 'Ava']], 'drawn')
    // drawn: send with one failure and one skip
    await circle('mixed'); await members('mixed', kids()); await invites('mixed')
    await lock('mixed', [['Ava', 'Cy'], ['Ben', 'Ava'], ['Cy', 'Ben']], 'drawn')
    // sent: Ava opened hers; reveal texts: Ava sent, Ben failed, Cy none
    await circle('sent'); await members('sent', kids()); await invites('sent')
    await lock('sent', [['Ava', 'Ben'], ['Ben', 'Cy'], ['Cy', 'Ava']], 'sent', ['Ava'])
    await texts('sent', [['Ava', 'reveal', 'sent', true], ['Ben', 'reveal', 'failed', true]])
    // open circle whose most recent text was a REAL send (a log row only; nothing is texted)
    await circle('real'); await members('real', kids())
    await texts('real', [['Ava', 'invite', 'sent', true], ['Ben', 'invite', 'sent', false]])
    // Elf A's circle that Elf B will try to draw
    await circle('private'); await members('private', kids())
  })
}

test.beforeAll(seed)
test.afterAll(async () => {
  await withDb(async db => {
    await sweepCircles(db)
  })
})

// ------------------------------------------------------------------ helpers

const row = (page, name) => page.locator('[data-test="member-row"]', { hasText: name })
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const confirmDialog = page => page.locator('dialog[data-test="confirm-send"]')
const visibleMatchRows = page => page.locator('[data-test="match-row"]:visible')

const status = key => withDb(async db => (await db.query('select status from public.circles where id = $1', [C[key]])).rows[0].status)

/** The matches as "Giver → Receiver", sorted. */
const dbPairs = key => withDb(async db => (await db.query(
  `select g.first_name || ' → ' || r.first_name as pair
     from public.matches x join public.members g on g.id = x.giver_id join public.members r on r.id = x.receiver_id
    where x.circle_id = $1 order by 1`, [C[key]])).rows.map(r => r.pair))

const uiPairs = async page => (await visibleMatchRows(page).allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()).sort()

/** Any native alert/confirm/prompt is recorded (and dismissed). Phase 4 must use an in-page <dialog>. */
function watchNativeDialogs (page) {
  const seen = []
  page.on('dialog', d => { seen.push(d.type()); d.dismiss().catch(() => {}) })
  return seen
}

async function openCircle (page, key) {
  await page.goto(`/circle.html?id=${C[key]}`)
  await expect(row(page, 'Ava')).toBeVisible()
}

async function noHorizontalScroll (page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

// ------------------------------------------------------------------ the guard

test('E2E-DRAW-00 seeding touched no circle outside [e2e] (e.g. "SecretSanta Test 1")', async () => {
  expect(await withDb(snapshotRealCircles)).toEqual(realSnapshot)
})

// ------------------------------------------------------------------ Elf A
test.describe('Elf A', () => {
  test.use({ storageState: join(AUTH_DIR, 'elf_a.json') })

  test.describe('draw button rules', () => {
    test('E2E-DRAW-01 with 2 members, Draw names is disabled and says at least 3 are needed', async ({ page }) => {
      await openCircle(page, 'two')
      await expect(btn(page, 'Draw names')).toBeDisabled()
      await expect(page.locator('[data-test="draw-reason"]')).toContainText(/at least 3/i)
    })

    test('E2E-DRAW-02 with a list not done, Draw names is disabled and names who it is waiting for', async ({ page }) => {
      await openCircle(page, 'waiting')
      await expect(btn(page, 'Draw names')).toBeDisabled()
      const reason = page.locator('[data-test="draw-reason"]')
      await expect(reason).toContainText(/every list must be done/i)
      await expect(reason).toContainText('Cy')
      await expect(reason).not.toContainText('Ava')
    })

    test('E2E-DRAW-03 impossible do-not-pair rules: the spec message shows and nothing changes', async ({ page }) => {
      await openCircle(page, 'impossible')
      await btn(page, 'Draw names').click()
      await expect(page.getByText("Can't make a draw with these do-not-pair rules. Try removing one.")).toBeVisible()
      expect(await status('impossible')).toBe('open')
      expect(await dbPairs('impossible')).toEqual([])
      await expect(btn(page, 'Shuffle again')).toHaveCount(0)
    })
  })

  // Draw -> undo -> draw -> send, on one circle, in order.
  test.describe('happy path', () => {
    test.describe.configure({ mode: 'serial' })

    test('E2E-DRAW-04 Draw names: enabled when ready, makes the draw, shows no matches by default', async ({ page }) => {
      await openCircle(page, 'ready')
      const draw = btn(page, 'Draw names')
      await expect(draw).toBeEnabled()
      await expect(btn(page, 'Shuffle again')).toHaveCount(0)
      await expect(btn(page, 'Send the names')).toHaveCount(0)
      await draw.click()
      await expect(btn(page, 'Shuffle again')).toBeVisible()
      await expect(btn(page, 'Undo draw')).toBeVisible()
      await expect(btn(page, 'Send the names')).toBeVisible()
      await expect(btn(page, 'Draw names')).toHaveCount(0)
      expect(await status('ready')).toBe('drawn')
      const pairs = await dbPairs('ready')
      expect(pairs).toHaveLength(3)
      // Peek is off: no match row is on screen and no "giver → receiver" text is visible.
      await expect(page.locator('[data-test="show-matches"]')).not.toBeChecked()
      await expect(visibleMatchRows(page)).toHaveCount(0)
      const shown = await page.locator('body').innerText()
      for (const p of pairs) expect(shown).not.toContain(p)
    })

    test('E2E-DRAW-05 Undo draw goes back to open and deletes the matches', async ({ page }) => {
      await openCircle(page, 'ready')
      await btn(page, 'Undo draw').click()
      // An in-page confirm for Undo is allowed but not required.
      const dlg = page.locator('dialog[open]')
      if (await dlg.count()) await dlg.getByRole('button').filter({ hasNotText: /cancel/i }).first().click()
      await expect(btn(page, 'Draw names')).toBeEnabled()
      await expect(btn(page, 'Shuffle again')).toHaveCount(0)
      expect(await status('ready')).toBe('open')
      expect(await dbPairs('ready')).toEqual([])
    })

    test('E2E-DRAW-06 Send the names: in-page confirm in practice mode, reveal for the whole circle, locks to sent', async ({ page, sendCalls }) => {
      const native = watchNativeDialogs(page)
      await openCircle(page, 'ready')
      await btn(page, 'Draw names').click()
      await expect(btn(page, 'Send the names')).toBeVisible()
      await btn(page, 'Send the names').click()

      const dlg = confirmDialog(page)
      await expect(dlg).toBeVisible()
      expect(await dlg.evaluate(el => el.tagName === 'DIALOG' && el.open)).toBe(true)
      await expect(dlg).toContainText(CONFIRM_TEXT)
      await expect(dlg).toContainText(PRACTICE) // the circle's latest text is a dry run
      expect(sendCalls).toHaveLength(0) // nothing is sent before the Elf confirms
      expect(await status('ready')).toBe('drawn')

      await dlg.getByRole('button', { name: /send the names/i }).click()
      await expect.poll(() => sendCalls.length).toBe(1)
      expect(sendCalls[0].body).toEqual({ circle_id: C.ready, kind: 'reveal' })
      expect(sendCalls[0].authorization).toMatch(/^Bearer .+/)
      await expect.poll(() => status('ready')).toBe('sent')

      // per-member results from the response
      for (const n of ['Ava', 'Ben', 'Cy']) {
        const r = page.locator(`[data-test="send-result"][data-member-id="${M[`ready.${n}`]}"]`)
        await expect(r).toContainText(n)
        await expect(r).toContainText(/sent/i)
      }
      // S6: the response said dry_run, so the banner shows
      await expect(page.locator('[data-test="practice-banner"]')).toContainText(PRACTICE)
      // now locked: no draw/undo, shuffle gone or disabled, and the spec's note
      await expect(page.getByText('Names have already been sent.')).toBeVisible()
      await expect(btn(page, 'Undo draw')).toHaveCount(0)
      await expect(btn(page, 'Draw names')).toHaveCount(0)
      const shuffle = btn(page, 'Shuffle again')
      if (await shuffle.count()) await expect(shuffle).toBeDisabled()
      expect(native).toEqual([])
    })
  })

  test.describe('drawn', () => {
    test('E2E-DRAW-07 Show matches lists every giver → receiver from the matches table, and is not remembered', async ({ page }) => {
      await openCircle(page, 'drawn')
      const toggle = page.locator('[data-test="show-matches"]')
      await expect(toggle).not.toBeChecked()
      await expect(visibleMatchRows(page)).toHaveCount(0)
      await toggle.check()
      await expect(visibleMatchRows(page)).toHaveCount(3)
      expect(await uiPairs(page)).toEqual(await dbPairs('drawn'))
      await toggle.uncheck()
      await expect(visibleMatchRows(page)).toHaveCount(0)

      await toggle.check()
      await page.reload()
      await expect(row(page, 'Ava')).toBeVisible()
      await expect(page.locator('[data-test="show-matches"]')).not.toBeChecked()
      await expect(visibleMatchRows(page)).toHaveCount(0)
    })

    test('E2E-DRAW-08 Shuffle again calls reshuffle; the matches change within 10 shuffles and the list follows', async ({ page }) => {
      await openCircle(page, 'drawn')
      await page.locator('[data-test="show-matches"]').check()
      const first = await dbPairs('drawn')
      let changed = false
      for (let i = 0; i < 10 && !changed; i++) {
        const done = page.waitForResponse(r => r.url().includes('/rest/v1/rpc/reshuffle'))
        await btn(page, 'Shuffle again').click()
        expect((await done).ok()).toBe(true)
        const now = await dbPairs('drawn')
        expect(now).toHaveLength(3)
        expect(await status('drawn')).toBe('drawn')
        // whatever is shown is the current draw, never a stale one
        // (the builder may leave Peek on or turn it off after a shuffle)
        const toggle = page.locator('[data-test="show-matches"]')
        await expect.poll(async () => {
          const ui = await uiPairs(page)
          return (await toggle.isChecked()) ? ui.join() === now.join() : ui.length === 0
        }).toBe(true)
        changed = now.join() !== first.join()
      }
      expect(changed).toBe(true)
    })

    test('E2E-DRAW-09 Cancel in the confirm sends nothing and keeps the draw', async ({ page, sendCalls }) => {
      const native = watchNativeDialogs(page)
      await openCircle(page, 'drawn')
      const before = await dbPairs('drawn')
      await btn(page, 'Send the names').click()
      const dlg = confirmDialog(page)
      await expect(dlg).toBeVisible()
      await dlg.getByRole('button', { name: /cancel/i }).click()
      await expect(dlg).toBeHidden()
      expect(sendCalls).toHaveLength(0)
      expect(await status('drawn')).toBe('drawn')
      expect(await dbPairs('drawn')).toEqual(before)
      await expect(btn(page, 'Shuffle again')).toBeEnabled()
      expect(native).toEqual([])
    })

    test('E2E-DRAW-10 per-member results show sent, failed and skipped from the response', async ({ page, sendCalls, sendStub }) => {
      sendStub.fail.add(M['mixed.Ben'])
      sendStub.skip.set(M['mixed.Cy'], 'too many texts, try again in an hour')
      await openCircle(page, 'mixed')
      await btn(page, 'Send the names').click()
      await confirmDialog(page).getByRole('button', { name: /send the names/i }).click()
      await expect.poll(() => sendCalls.length).toBe(1)
      const result = n => page.locator(`[data-test="send-result"][data-member-id="${M[`mixed.${n}`]}"]`)
      await expect(result('Ava')).toContainText(/sent/i)
      await expect(result('Ben')).toContainText(/failed/i)
      await expect(result('Cy')).toContainText(/skipped/i) // skipped writes no texts row: this can only come from the response
      await expect(row(page, 'Ben')).toContainText('Text failed')
    })

    test('E2E-DRAW-11 the drawn page, matches shown, has no horizontal scroll at 375px', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 })
      await openCircle(page, 'drawn')
      await page.locator('[data-test="show-matches"]').check()
      await expect(visibleMatchRows(page)).toHaveCount(3)
      await noHorizontalScroll(page)
      await btn(page, 'Send the names').click()
      await expect(confirmDialog(page)).toBeVisible()
      await noHorizontalScroll(page)
    })
  })

  test.describe('sent', () => {
    test('E2E-DRAW-12 no draw, shuffle or undo controls; "Names have already been sent."', async ({ page }) => {
      await openCircle(page, 'sent')
      await expect(page.getByText('Names have already been sent.')).toBeVisible()
      await expect(btn(page, 'Draw names')).toHaveCount(0)
      await expect(btn(page, 'Undo draw')).toHaveCount(0)
      await expect(btn(page, 'Send the names')).toHaveCount(0)
      const shuffle = btn(page, 'Shuffle again')
      if (await shuffle.count()) await expect(shuffle).toBeDisabled()
    })

    test('E2E-DRAW-13 each row shows its reveal text status and Opened ✓ / Not opened yet', async ({ page }) => {
      await openCircle(page, 'sent')
      await expect(row(page, 'Ava')).toContainText('Text sent')
      await expect(row(page, 'Ben')).toContainText('Text failed')
      await expect(row(page, 'Cy')).toContainText('Not sent yet')
      await expect(row(page, 'Ava')).toContainText(/Opened\s*✓/)
      await expect(row(page, 'Ava')).not.toContainText('Not opened yet')
      for (const n of ['Ben', 'Cy']) await expect(row(page, n)).toContainText('Not opened yet')
    })

    test('E2E-DRAW-14 Re-send on one row sends that member\'s reveal only', async ({ page, sendCalls }) => {
      await openCircle(page, 'sent')
      await row(page, 'Cy').getByRole('button', { name: 'Re-send' }).click()
      await expect.poll(() => sendCalls.length).toBe(1)
      expect(sendCalls[0].body).toEqual({ circle_id: C.sent, kind: 'reveal', member_id: M['sent.Cy'] })
    })

    test('E2E-DRAW-15 the Elf shuffling after sending is refused by the database and nothing changes', async () => {
      const before = await dbPairs('sent')
      const elf = createClient(SUPABASE_URL, publishableKey(), {
        auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken('elf_a')}` } }
      })
      for (const fn of ['reshuffle', 'undo_draw', 'start_draw']) {
        const { error } = await elf.rpc(fn, { p_circle_id: C.sent })
        expect(error?.message, fn).toMatch(/names have already been (sent|drawn)/)
      }
      expect(await dbPairs('sent')).toEqual(before)
      expect(await status('sent')).toBe('sent')
    })

    test('E2E-DRAW-16 the sent page has no horizontal scroll at 375px', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 800 })
      await openCircle(page, 'sent')
      await noHorizontalScroll(page)
    })
  })

  test.describe('practice-mode banner (S6)', () => {
    test('E2E-DRAW-17 shows on load when the circle\'s most recent text is a dry run', async ({ page }) => {
      await openCircle(page, 'sent')
      await expect(page.locator('[data-test="practice-banner"]')).toBeVisible()
      await expect(page.locator('[data-test="practice-banner"]')).toContainText(PRACTICE)
    })

    test('E2E-DRAW-18 does not show when the most recent text was a real send', async ({ page }) => {
      await openCircle(page, 'real')
      await expect(page.locator('[data-test="practice-banner"]:visible')).toHaveCount(0)
    })

    test('E2E-DRAW-19 shows after any send whose response says dry_run: true', async ({ page }) => {
      await openCircle(page, 'real')
      await row(page, 'Cy').getByRole('button', { name: 'Re-send' }).click()
      await expect(page.locator('[data-test="practice-banner"]')).toContainText(PRACTICE)
    })
  })
})

// ------------------------------------------------------------------ Elf B
test.describe('Elf B', () => {
  test.use({ storageState: join(AUTH_DIR, 'elf_b.json') })

  test('E2E-DRAW-20 Elf B sees "not found" for Elf A\'s circle, and no draw control', async ({ page }) => {
    await page.goto(`/circle.html?id=${C.private}`)
    await expect(page.getByText(/circle not found/i)).toBeVisible()
    await expect(btn(page, 'Draw names')).toHaveCount(0)
    await expect(btn(page, 'Shuffle again')).toHaveCount(0)
    const body = await page.locator('body').innerText()
    for (const n of ['Ava', 'Ben', 'Cy']) expect(body).not.toContain(n)
  })

  test('E2E-DRAW-21 Elf B calling start_draw / reshuffle / undo_draw on Elf A\'s circle gets "circle not found"', async () => {
    const elfB = createClient(SUPABASE_URL, publishableKey(), {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken('elf_b')}` } }
    })
    for (const [fn, key] of [['start_draw', 'private'], ['reshuffle', 'drawn'], ['undo_draw', 'drawn']]) {
      const before = await dbPairs(key)
      const { error } = await elfB.rpc(fn, { p_circle_id: C[key] })
      expect(error?.message, fn).toBe('circle not found')
      expect(await dbPairs(key)).toEqual(before)
    }
    expect(await status('private')).toBe('open')
    expect(await status('drawn')).toBe('drawn')
  })
})

test('E2E-DRAW-22 the run touched no circle outside [e2e]', async () => {
  expect(await withDb(snapshotRealCircles)).toEqual(realSnapshot)
})
