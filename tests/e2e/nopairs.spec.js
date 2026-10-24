// E2E-NP-00..17: the Elf's do-not-pair UI on circle.html (Phase 4, last deferred piece).
// Spec: "Do-not-pair (optional, Elf)", "Circle status" (no-pairs are frozen unless
// `open`), "Data model" no_pairs (stored with member_a < member_b, unique per
// circle), "Draw rules", "Access rules", error table ("Can't make a draw with
// these do-not-pair rules. Try removing one.").
// Scenario IDs and the DOM contract are in tests/SCENARIOS.md (Phase 4b).
//
// SAFETY: every page uses support/fixtures.mjs: send-texts is intercepted and
// answered by a local dry-run stub, and textbelt.com is aborted. Nothing here
// sends a text at all. Circles are "[e2e] nopairs ..." owned by test Elf A,
// swept before and after, never deleted by any other key. Phones are fictional
// +1 555 555-03xx. Circles not named "[e2e]%" (for example Joe's real
// "SecretSanta Test 1") are snapshotted before the run, including their
// no_pairs, and must be unchanged after it (E2E-NP-00 / E2E-NP-17).

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
const LABEL = 'Never pair these two (optional)'
const IMPOSSIBLE = "Can't make a draw with these do-not-pair rules. Try removing one."
// first_name allows 1-40 characters; this one is exactly 40 with no spaces to wrap on.
const LONG = 'Maximilianabartholomewchristabelquinnzz'.padEnd(40, 'z')
const HTML_NAME = '<img src=x onerror=alert(1)>'

// circle key -> id, `${circleKey}.${first}` -> member id
const C = {}
const M = {}
let realSnapshot = null

// ------------------------------------------------------------------ seeding

/** Everything about circles that are NOT [e2e], including their no-pairs: the run must leave it unchanged. */
async function snapshotRealCircles (db) {
  const { rows } = await db.query(`
    select c.id, c.status, c.name,
      (select count(*)::int from public.members m where m.circle_id = c.id) as members,
      (select coalesce(string_agg(n.member_a::text || n.member_b::text, ',' order by n.member_a, n.member_b), '') from public.no_pairs n where n.circle_id = c.id) as no_pairs,
      (select coalesce(string_agg(x.giver_id::text || x.receiver_id::text, ',' order by x.giver_id), '') from public.matches x where x.circle_id = c.id) as matches,
      (select count(*)::int from public.texts t join public.members m on m.id = t.member_id where m.circle_id = c.id) as texts
    from public.circles c where c.name not like '[e2e]%' order by c.id`)
  return rows
}

async function seed () {
  await withDb(async db => {
    await sweepCircles(db)
    realSnapshot = await snapshotRealCircles(db)
    let n = 300
    const phone = () => `+1555555${String(n++).padStart(4, '0')}`

    async function circle (key) {
      const { rows: [c] } = await db.query(
        `insert into public.circles (elf_id, name, budget, swap_date, swap_place)
         values ($1, $2, 20, '2026-12-19', 'Maya''s house') returning id`,
        [user('elf_a').id, `${E2E_PREFIX} nopairs ${key} ${RUN}`])
      C[key] = c.id
    }
    async function members (key, names) {
      for (const first of names) {
        const { rows: [m] } = await db.query(
          'insert into public.members (circle_id, first_name, phone, list_done) values ($1, $2, $3, true) returning id',
          [C[key], first, phone()])
        M[`${key}.${first}`] = m.id
      }
    }
    async function pair (key, x, y) {
      const [a, b] = [M[`${key}.${x}`], M[`${key}.${y}`]].sort()
      await db.query('insert into public.no_pairs (circle_id, member_a, member_b) values ($1, $2, $3)', [C[key], a, b])
    }
    async function lock (key, pairs, status) {
      for (const [g, r] of pairs) {
        await db.query('insert into public.matches (circle_id, giver_id, receiver_id) values ($1, $2, $3)',
          [C[key], M[`${key}.${g}`], M[`${key}.${r}`]])
      }
      await db.query("update public.circles set status = 'drawn' where id = $1", [C[key]])
      if (status === 'sent') await db.query("update public.circles set status = 'sent' where id = $1", [C[key]])
    }
    const four = ['Ava', 'Ben', 'Cy', 'Dot']
    // a valid draw for four kids with Ava ✕ Ben: no Ava-Ben edge either way
    const validFour = [['Ava', 'Cy'], ['Cy', 'Ben'], ['Ben', 'Dot'], ['Dot', 'Ava']]

    await circle('quiet'); await members('quiet', ['Ava', 'Ben', 'Zed'])
    await circle('add'); await members('add', ['Ava', 'Ben', 'Zed'])
    await circle('remove'); await members('remove', ['Ava', 'Ben', 'Zed']); await pair('remove', 'Ava', 'Zed'); await pair('remove', 'Ben', 'Zed')
    await circle('grow'); await members('grow', ['Ava', 'Ben'])
    await circle('impossible'); await members('impossible', ['Ava', 'Ben', 'Cy'])
    await circle('honour'); await members('honour', four)
    await circle('drawn'); await members('drawn', four); await pair('drawn', 'Ava', 'Ben'); await lock('drawn', validFour, 'drawn')
    await circle('drawnplain'); await members('drawnplain', four); await lock('drawnplain', validFour, 'drawn')
    await circle('sent'); await members('sent', four); await pair('sent', 'Ava', 'Ben'); await lock('sent', validFour, 'sent')
    await circle('long'); await members('long', ['Ava', LONG, 'Zed'])
    await circle('escape'); await members('escape', ['Ava', HTML_NAME, 'Zed'])
    await circle('private'); await members('private', ['Ava', 'Ben', 'Cy']); await pair('private', 'Ava', 'Ben')
  })
}

test.beforeAll(seed)
test.afterAll(async () => {
  await withDb(async db => {
    await sweepCircles(db)
  })
})

// ------------------------------------------------------------------ helpers

const section = page => page.locator('[data-test="nopairs"]')
const selA = page => page.locator('[data-test="nopair-a"]')
const selB = page => page.locator('[data-test="nopair-b"]')
const addBtn = page => section(page).getByRole('button', { name: /^Add( pair)?$/ })
const pairRows = page => page.locator('[data-test="nopair-row"]:visible')
const pairError = page => page.locator('[data-test="nopair-error"]')
const btn = (page, name) => page.getByRole('button', { name, exact: true })

const status = key => withDb(async db => (await db.query('select status from public.circles where id = $1', [C[key]])).rows[0].status)

/** The circle's no-pairs as sorted "Name ✕ Name" (alphabetical within a pair), plus a check that a < b. */
const dbNoPairs = key => withDb(async db => (await db.query(
  `select a.first_name as a, b.first_name as b, n.member_a < n.member_b as sorted
     from public.no_pairs n join public.members a on a.id = n.member_a join public.members b on b.id = n.member_b
    where n.circle_id = $1`, [C[key]])).rows.map(r => ({ pair: [r.a, r.b].sort().join(' ✕ '), sorted: r.sorted }))
  .sort((x, y) => x.pair.localeCompare(y.pair)))

/** The matches as [giverName, receiverName]. */
const dbMatches = key => withDb(async db => (await db.query(
  `select g.first_name as g, r.first_name as r
     from public.matches x join public.members g on g.id = x.giver_id join public.members r on r.id = x.receiver_id
    where x.circle_id = $1`, [C[key]])).rows.map(r => [r.g, r.r]))

/** Text of each visible pair row with the Remove button's label dropped, as "X ✕ Y" with the names sorted. */
async function uiPairs (page) {
  const texts = await pairRows(page).allInnerTexts()
  return texts.map(t => {
    const names = t.replace(/\bRemove\b/g, '').split('✕').map(s => s.replace(/\s+/g, ' ').trim())
    return names.sort().join(' ✕ ')
  }).sort()
}

async function openCircle (page, key) {
  await page.goto(`/circle.html?id=${C[key]}`)
  await expect(page.locator('[data-test="member-row"]').first()).toBeVisible()
}

/** Expand the quiet section if the probe isn't already showing. */
async function expand (page, probe = selA(page)) {
  if (!(await probe.isVisible())) {
    const label = page.getByText(LABEL, { exact: true })
    await expect(label, `the "${LABEL}" label`).toBeVisible()
    await label.click()
  }
  await expect(probe).toBeVisible()
}

async function addPair (page, x, y) {
  await expand(page)
  await selA(page).selectOption({ label: x })
  await selB(page).selectOption({ label: y })
  await addBtn(page).click()
}

/** Names offered by a select, ignoring a placeholder option with an empty value. */
const optionNames = sel => sel.locator('option').evaluateAll(os => os.filter(o => o.value !== '').map(o => o.textContent.trim()).sort())

/** Name the member with the larger id first, so the UI has to sort before inserting. */
function reversedOrder (key, x, y) {
  return M[`${key}.${x}`] > M[`${key}.${y}`] ? [x, y] : [y, x]
}

async function noHorizontalScroll (page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
}

function watchNativeDialogs (page) {
  const seen = []
  page.on('dialog', d => { seen.push(d.type()); d.dismiss().catch(() => {}) })
  return seen
}

// ------------------------------------------------------------------ the guard

test('E2E-NP-00 seeding touched no circle outside [e2e] (e.g. "SecretSanta Test 1")', async () => {
  expect(await withDb(snapshotRealCircles)).toEqual(realSnapshot)
})

// ------------------------------------------------------------------ Elf A
test.describe('Elf A', () => {
  test.use({ storageState: join(AUTH_DIR, 'elf_a.json') })

  test('E2E-NP-01 off by default: a quiet "Never pair these two (optional)" label, no selects or pairs until opened', async ({ page }) => {
    await openCircle(page, 'quiet')
    await expect(section(page)).toHaveCount(1)
    await expect(page.getByText(LABEL, { exact: true })).toBeVisible()
    await expect(selA(page)).toBeHidden()
    await expect(selB(page)).toBeHidden()
    await expect(addBtn(page)).toBeHidden()
    await expect(pairRows(page)).toHaveCount(0)
    await page.getByText(LABEL, { exact: true }).click()
    await expect(selA(page)).toBeVisible()
    await expect(selB(page)).toBeVisible()
    await expect(addBtn(page)).toBeVisible()
    // both selects offer exactly this circle's kids
    expect(await optionNames(selA(page))).toEqual(['Ava', 'Ben', 'Zed'])
    expect(await optionNames(selB(page))).toEqual(['Ava', 'Ben', 'Zed'])
    expect(await dbNoPairs('quiet')).toEqual([])
  })

  test.describe('adding', () => {
    test.describe.configure({ mode: 'serial' })

    test('E2E-NP-02 picking the same kid twice shows an inline error and adds nothing', async ({ page }) => {
      await openCircle(page, 'add')
      await addPair(page, 'Ava', 'Ava')
      await expect(pairError(page)).toBeVisible()
      await expect(pairError(page)).toContainText(/different/i)
      await expect(pairRows(page)).toHaveCount(0)
      expect(await dbNoPairs('add')).toEqual([])
    })

    test('E2E-NP-03 adding a pair in "wrong" id order stores it sorted (member_a < member_b) and lists "Ava ✕ Zed"', async ({ page }) => {
      const native = watchNativeDialogs(page)
      await openCircle(page, 'add')
      const [first, second] = reversedOrder('add', 'Ava', 'Zed') // larger id first: the UI must sort
      await addPair(page, first, second)
      await expect.poll(() => dbNoPairs('add')).toEqual([{ pair: 'Ava ✕ Zed', sorted: true }])
      await expect(pairRows(page)).toHaveCount(1)
      expect(await uiPairs(page)).toEqual(['Ava ✕ Zed'])
      await expect(pairRows(page).first()).toContainText('✕')
      await expect(pairError(page)).toBeHidden()
      // it is read from the table, so it survives a reload
      await page.reload()
      await expand(page, pairRows(page).first())
      expect(await uiPairs(page)).toEqual(['Ava ✕ Zed'])
      expect(native).toEqual([])
    })

    test('E2E-NP-04 the same pair again, in either order, gives a friendly error and no new row', async ({ page }) => {
      await openCircle(page, 'add')
      for (const [x, y] of [['Zed', 'Ava'], ['Ava', 'Zed']]) {
        await addPair(page, x, y)
        await expect(pairError(page)).toBeVisible()
        await expect(pairError(page)).toContainText(/already/i)
        await expect(pairError(page)).not.toContainText(/duplicate key|violates|constraint|23505|check/i)
        await expect(page.locator('#notices')).not.toContainText(/duplicate key|violates|constraint|23505/i)
        expect(await dbNoPairs('add')).toEqual([{ pair: 'Ava ✕ Zed', sorted: true }])
        await expect(pairRows(page)).toHaveCount(1)
      }
    })
  })

  test('E2E-NP-05 Remove on a pair row deletes that pair only, with no native dialog', async ({ page }) => {
    const native = watchNativeDialogs(page)
    await openCircle(page, 'remove')
    await expand(page, pairRows(page).first())
    expect(await uiPairs(page)).toEqual(['Ava ✕ Zed', 'Ben ✕ Zed'])
    const avaZed = pairRows(page).filter({ hasText: 'Ava' })
    await avaZed.getByRole('button', { name: 'Remove' }).click()
    await expect.poll(() => dbNoPairs('remove')).toEqual([{ pair: 'Ben ✕ Zed', sorted: true }])
    await expect(pairRows(page)).toHaveCount(1)
    expect(await uiPairs(page)).toEqual(['Ben ✕ Zed'])
    // the kids themselves are untouched
    await expect(page.locator('[data-test="member-row"]')).toHaveCount(3)
    expect(native).toEqual([])
  })

  test('E2E-NP-06 a kid added on the page shows up in both selects without a reload', async ({ page }) => {
    await openCircle(page, 'grow')
    await page.getByLabel(/first name/i).fill('Cy')
    await page.getByLabel(/mobile/i).fill('(555) 555-0399')
    await page.locator('#add-member').getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.locator('[data-test="member-row"]', { hasText: 'Cy' })).toBeVisible()
    await expand(page)
    await expect.poll(() => optionNames(selA(page))).toEqual(['Ava', 'Ben', 'Cy'])
    await expect.poll(() => optionNames(selB(page))).toEqual(['Ava', 'Ben', 'Cy'])
  })

  test('E2E-NP-07 pairs added on the page that make a draw impossible: Draw names shows the exact message, nothing changes', async ({ page }) => {
    await openCircle(page, 'impossible')
    await addPair(page, 'Ava', 'Ben')
    await expect.poll(() => dbNoPairs('impossible')).toHaveLength(1)
    await addPair(page, 'Cy', 'Ava')
    await expect.poll(() => dbNoPairs('impossible')).toHaveLength(2)
    await btn(page, 'Draw names').click()
    await expect(page.getByText(IMPOSSIBLE, { exact: true })).toBeVisible()
    expect(await status('impossible')).toBe('open')
    expect(await dbMatches('impossible')).toEqual([])
    // still open, so the rules can still be changed
    await expand(page, pairRows(page).first())
    expect(await uiPairs(page)).toEqual(['Ava ✕ Ben', 'Ava ✕ Cy'])
    await expect(pairRows(page).first().getByRole('button', { name: 'Remove' })).toBeVisible()
  })

  test('E2E-NP-08 the draw and every shuffle honour a pair added on the page, in both directions', async ({ page }) => {
    await openCircle(page, 'honour')
    await addPair(page, 'Ben', 'Ava')
    await expect.poll(() => dbNoPairs('honour')).toEqual([{ pair: 'Ava ✕ Ben', sorted: true }])
    await btn(page, 'Draw names').click()
    await expect(btn(page, 'Shuffle again')).toBeVisible()
    const check = async () => {
      const ms = await dbMatches('honour')
      expect(ms).toHaveLength(4)
      for (const [g, r] of ms) {
        expect(`${g} → ${r}`).not.toBe('Ava → Ben')
        expect(`${g} → ${r}`).not.toBe('Ben → Ava')
        expect(g).not.toBe(r)
      }
    }
    await check()
    for (let i = 0; i < 8; i++) {
      const done = page.waitForResponse(r => r.url().includes('/rest/v1/rpc/reshuffle'))
      await btn(page, 'Shuffle again').click()
      expect((await done).ok()).toBe(true)
      await check()
    }
    expect(await status('honour')).toBe('drawn')
  })

  test('E2E-NP-09 drawn: existing pairs are shown read-only (no selects, no Add, no Remove)', async ({ page }) => {
    await openCircle(page, 'drawn')
    await expand(page, pairRows(page).first())
    expect(await uiPairs(page)).toEqual(['Ava ✕ Ben'])
    await expect(selA(page)).toHaveCount(0)
    await expect(selB(page)).toHaveCount(0)
    await expect(addBtn(page)).toHaveCount(0)
    await expect(section(page).getByRole('button', { name: 'Remove' })).toHaveCount(0)
    expect(await dbNoPairs('drawn')).toEqual([{ pair: 'Ava ✕ Ben', sorted: true }])
  })

  test('E2E-NP-10 drawn with no pairs: the section does not appear at all', async ({ page }) => {
    await openCircle(page, 'drawnplain')
    await expect(page.getByText(LABEL, { exact: true })).toHaveCount(0)
    await expect(page.locator('[data-test="nopairs"]:visible')).toHaveCount(0)
    await expect(selA(page)).toHaveCount(0)
  })

  test('E2E-NP-11 sent: existing pairs are shown read-only, and the rows are unchanged', async ({ page }) => {
    await openCircle(page, 'sent')
    await expand(page, pairRows(page).first())
    expect(await uiPairs(page)).toEqual(['Ava ✕ Ben'])
    await expect(selA(page)).toHaveCount(0)
    await expect(addBtn(page)).toHaveCount(0)
    await expect(section(page).getByRole('button', { name: 'Remove' })).toHaveCount(0)
    expect(await dbNoPairs('sent')).toEqual([{ pair: 'Ava ✕ Ben', sorted: true }])
  })

  test('E2E-NP-12 after Undo draw the section is editable again', async ({ page }) => {
    await openCircle(page, 'drawn')
    await btn(page, 'Undo draw').click()
    const dlg = page.locator('dialog[open]')
    if (await dlg.count()) await dlg.getByRole('button').filter({ hasNotText: /cancel/i }).first().click()
    await expect(btn(page, 'Draw names')).toBeVisible()
    await expand(page)
    await expect(addBtn(page)).toBeVisible()
    await expect(pairRows(page).first().getByRole('button', { name: 'Remove' })).toBeVisible()
  })

  test('E2E-NP-13 a name with HTML in it is shown as text in the selects and the pair row', async ({ page }) => {
    let alerted = false
    page.on('dialog', d => { alerted = true; d.dismiss().catch(() => {}) })
    await openCircle(page, 'escape')
    await addPair(page, HTML_NAME, 'Zed')
    await expect.poll(() => dbNoPairs('escape')).toHaveLength(1)
    expect(await optionNames(selA(page))).toContain(HTML_NAME)
    await expect(pairRows(page).first()).toContainText(HTML_NAME)
    await expect(section(page).locator('img')).toHaveCount(0)
    expect(alerted).toBe(false)
  })

  test('E2E-NP-14 at 375px a 40-character name neither overflows the selects nor scrolls the page sideways', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await openCircle(page, 'long')
    await expand(page)
    await noHorizontalScroll(page)
    await selA(page).selectOption({ label: LONG })
    await selB(page).selectOption({ label: 'Zed' })
    for (const sel of [selA(page), selB(page), addBtn(page)]) {
      const box = await sel.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(375)
    }
    await noHorizontalScroll(page)
    await addBtn(page).click()
    await expect.poll(() => dbNoPairs('long')).toHaveLength(1)
    const rowBox = await pairRows(page).first().boundingBox()
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(375)
    await noHorizontalScroll(page)
  })
})

// ------------------------------------------------------------------ Elf B
test.describe('Elf B', () => {
  test.use({ storageState: join(AUTH_DIR, 'elf_b.json') })

  test('E2E-NP-15 Elf B opening Elf A\'s circle sees "not found" and no do-not-pair section', async ({ page }) => {
    await page.goto(`/circle.html?id=${C.private}`)
    await expect(page.getByText(/circle not found/i)).toBeVisible()
    await expect(page.locator('[data-test="nopairs"]:visible')).toHaveCount(0)
    await expect(pairRows(page)).toHaveCount(0)
    const body = await page.locator('body').innerText()
    for (const n of ['Ava', 'Ben', 'Cy', '✕']) expect(body).not.toContain(n)
  })

  test('E2E-NP-16 Elf B can\'t read, add or remove Elf A\'s pairs through the API (RLS)', async () => {
    const elfB = createClient(SUPABASE_URL, publishableKey(), {
      auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${accessToken('elf_b')}` } }
    })
    const before = await dbNoPairs('private')
    const { data: seen } = await elfB.from('no_pairs').select('*').eq('circle_id', C.private)
    expect(seen ?? []).toEqual([])
    const [a, b] = [M['private.Ben'], M['private.Cy']].sort()
    const { error: insErr } = await elfB.from('no_pairs').insert({ circle_id: C.private, member_a: a, member_b: b })
    expect(insErr).not.toBeNull()
    const [x, y] = [M['private.Ava'], M['private.Ben']].sort()
    await elfB.from('no_pairs').delete().eq('circle_id', C.private).eq('member_a', x).eq('member_b', y)
    expect(await dbNoPairs('private')).toEqual(before)
  })
})

test('E2E-NP-17 the run touched no circle outside [e2e]', async () => {
  expect(await withDb(snapshotRealCircles)).toEqual(realSnapshot)
})
