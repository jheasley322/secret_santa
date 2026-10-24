// E2E-MEM-01..20: the member page, /m/#<token>.
// Spec: "Pages", "The flow" 4 and 8, "Wish list" (incl. "Lists stay editable
// after the draw"), "Circle details", "Privacy rules", "Access rules -> Member",
// "Stack" (escaping, rel="noopener noreferrer"), "Shorter links".
// Lead scope decision 2026-10-24: the member side of the reveal is in Phase 3.
// Scenario IDs and the DOM contract are in tests/SCENARIOS.md (Phase 3).
//
// SAFETY: every page uses support/fixtures.mjs (send-texts stubbed to dry-run
// rows, textbelt.com blocked). The member page must never call send-texts at
// all (E2E-MEM-16). Circles are "[e2e] ..." owned by test Elf A and are swept
// before and after the run, never by any other key. Phones are fictional
// +1 555 555-01xx numbers.
//
// Tokens and phones are never printed: assertions about them compare booleans,
// and pages are opened through openAs(), which keeps the token out of
// Playwright's step log. (A retained failure trace under test-results/, which is
// gitignored, can still hold these throwaway tokens; they die with the sweep.)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './support/fixtures.mjs'
import { AUTH_DIR, E2E_PREFIX, sweepCircles, withDb } from './support/project.mjs'

const elfA = () => JSON.parse(readFileSync(join(AUTH_DIR, 'elf_a.user.json'), 'utf8'))
const RUN = Date.now()
const OPEN_NAME = `${E2E_PREFIX} Ava's <i>Crew</i> ${RUN}`
const DRAWN_NAME = `${E2E_PREFIX} Drawn crew ${RUN}`
const SENT_NAME = `${E2E_PREFIX} Sent crew ${RUN}`
const LONG_WORD = 'Super' + 'a'.repeat(115) // 120 characters, no spaces
const XSS_WISH = '<img src=x onerror="window.__xss=1">'
const XSS_ABOUT = '<b>Hot chocolate</b>'

// Filled by beforeAll. Never logged.
const S = { tokens: {}, ids: {}, phones: [], circles: {} }

// ------------------------------------------------------------------ setup

async function seed () {
  Object.assign(S, { tokens: {}, ids: {}, phones: [], circles: {} })
  await withDb(async db => {
    await sweepCircles(db)
    const elf = elfA().id
    let n = 110
    const phone = () => { const p = `+1555555${String(n++).padStart(4, '0')}`; S.phones.push(p); return p }

    async function circle (key, name) {
      const { rows: [c] } = await db.query(
        `insert into public.circles (elf_id, name, budget, swap_date, swap_place)
         values ($1, $2, 20, '2026-12-19', 'Maya''s house') returning id`, [elf, name])
      S.circles[key] = c.id
      return c.id
    }
    async function member (circleId, first, about = {}, done = false, items = []) {
      const { rows: [m] } = await db.query(
        `insert into public.members (circle_id, first_name, phone, fav_color, fav_snack, sizes, please_no, list_done)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, token`,
        [circleId, first, phone(), about.fav_color ?? null, about.fav_snack ?? null, about.sizes ?? null, about.please_no ?? null, done])
      S.tokens[first] = m.token
      S.ids[first] = m.id
      for (const [i, [text, url]] of items.entries()) {
        await db.query('insert into public.wish_items (member_id, text, url, position) values ($1, $2, $3, $4)', [m.id, text, url ?? null, i])
      }
      return m.id
    }
    async function lockWith (circleId, pairs, status) {
      for (const [g, r] of pairs) {
        await db.query('insert into public.matches (circle_id, giver_id, receiver_id) values ($1, $2, $3)', [circleId, S.ids[g], S.ids[r]])
      }
      await db.query("update public.circles set status = 'drawn' where id = $1", [circleId])
      if (status === 'sent') await db.query("update public.circles set status = 'sent' where id = $1", [circleId])
    }

    // open circle: the happy path (Ava) and the unhappy paths (Dot)
    const open = await circle('open', OPEN_NAME)
    await member(open, 'Ava')
    await member(open, 'Ben', { fav_color: 'Purple', fav_snack: XSS_ABOUT, sizes: 'Youth S, shoe 4', please_no: 'Glitter' }, true, [
      ['Watercolor paint set', 'https://example.com/paint'],
      [XSS_WISH, null],
      [LONG_WORD, `https://example.com/${'b'.repeat(150)}`]
    ])
    await member(open, 'Cy')
    await member(open, 'Dot')

    // drawn circle: matches exist, members must see none of them
    const drawn = await circle('drawn', DRAWN_NAME)
    for (const k of ['Gus', 'Hal', 'Ivy']) await member(drawn, k, {}, true, k === 'Hal' ? [['Yo-yo', null]] : [])
    await lockWith(drawn, [['Gus', 'Hal'], ['Hal', 'Ivy'], ['Ivy', 'Gus']], 'drawn')

    // sent circle: Dee -> Eli -> Fay -> Dee
    const sent = await circle('sent', SENT_NAME)
    await member(sent, 'Dee', {}, true)
    await member(sent, 'Eli', { fav_color: 'Green', fav_snack: 'Popcorn' }, true, [
      ['Dragon book', 'https://example.com/dragons'],
      ['Kite', null]
    ])
    await member(sent, 'Fay', {}, true)
    await lockWith(sent, [['Dee', 'Eli'], ['Eli', 'Fay'], ['Fay', 'Dee']], 'sent')
  })
}

test.beforeAll(seed)
test.afterAll(async () => { await withDb(sweepCircles) })

// ------------------------------------------------------------------ helpers

/** Open /m/#<token> as a fresh page load, without the token in Playwright's step log. */
async function openAs (page, token) {
  await page.goto('/__start') // a same-origin 404, so the next load is a real navigation
  await page.evaluate(t => { window.location.assign(`/m/#${t}`) }, token)
  await page.waitForURL(u => u.pathname === '/m/' || u.pathname === '/m/index.html')
  await page.waitForLoadState('domcontentloaded')
}

/** Change the fragment in place, as editing the address bar does (a hashchange, no reload). */
async function setHash (page, token) {
  await page.evaluate(t => { window.location.hash = t }, token)
}

const greeting = page => page.getByRole('heading', { level: 1 })
const header = page => page.locator('header').first()
const wishRows = page => page.locator('[data-test="wish-edit"]')
const addWishButton = page => page.getByRole('button', { name: /add.*wish/i })
const saveButton = page => page.getByRole('button', { name: /^save/i })
const doneButton = page => page.getByRole('button', { name: /i['’]m done/i })
const person = (page, name) => page.locator('[data-test="person"]')
  .filter({ has: page.getByRole('heading', { name: new RegExp(`^\\s*${name}\\b`) }) })
const wishText = row => row.getByLabel(/what do you wish for/i)
const wishLink = row => row.getByLabel(/link/i)

async function ensureRows (page, n) {
  for (let i = 0; i < 12 && (await wishRows(page).count()) < n; i++) await addWishButton(page).click()
  await expect(wishRows(page)).toHaveCount(n)
}

async function save (page) {
  await saveButton(page).click()
  await expect(page.locator('[data-test="save-status"]')).toContainText(/saved/i)
}

async function itemsOf (name) {
  return withDb(async db => (await db.query(
    'select text, url, position from public.wish_items where member_id = $1 order by position', [S.ids[name]])).rows)
}

async function memberRow (name) {
  return withDb(async db => (await db.query(
    'select fav_color, fav_snack, sizes, please_no, list_done from public.members where id = $1', [S.ids[name]])).rows[0])
}

async function openedAt (circleKey) {
  return withDb(async db => (await db.query(
    `select g.first_name, mt.opened_at is not null as opened
       from public.matches mt join public.members g on g.id = mt.giver_id
      where mt.circle_id = $1 order by g.first_name`, [S.circles[circleKey]])).rows)
}

/** Record every request, and every Supabase response body, on this page. */
function capture (page) {
  const requests = []
  const bodies = []
  const views = []
  page.on('request', req => requests.push({ url: req.url(), method: req.method(), headers: req.headers(), body: req.postData() ?? '' }))
  page.on('response', res => {
    if (!/supabase\.co/.test(res.url())) return
    bodies.push(res.text().catch(() => ''))
    if (/\/rest\/v1\/rpc\/member_view$/.test(new URL(res.url()).pathname)) views.push(res.json().catch(() => null))
  })
  return { requests, bodies: () => Promise.all(bodies), views: () => Promise.all(views) }
}

async function bodyText (page) { return page.locator('body').innerText() }

// ------------------------------------------------------------------ tests

// Not serial: one red must not hide the others. Tests run in file order on one
// worker. After a failure Playwright starts a new worker, which re-runs seed()
// with fresh circles. Only MEM-02 -> 03 -> 04 build on each other (Ava's list),
// and MEM-12/13 expect Dot's list empty, so they come before MEM-14/15.
test.describe('member page', () => {

  test('E2E-MEM-01 the header shows the circle and a greeting with my name', async ({ page }) => {
    await openAs(page, S.tokens.Ava)
    await expect(greeting(page)).toContainText('Hi Ava')
    await expect(header(page)).toContainText(OPEN_NAME)
    await expect(header(page)).toContainText('$20')
    await expect(header(page)).toContainText('Dec 19')
    await expect(header(page)).toContainText("Maya's house")
  })

  test('E2E-MEM-02 fill About me and three wishes, save, and it persists on reload', async ({ page }) => {
    await openAs(page, S.tokens.Ava)
    await expect(greeting(page)).toContainText('Hi Ava')
    await page.getByLabel(/favorite color/i).fill('  Teal ')
    await page.getByLabel(/favorite snack/i).fill('Sour gummy worms')
    await page.getByLabel(/sizes/i).fill('Youth M shirt, shoe 5')
    await page.getByLabel(/please no/i).fill('Nuts (allergy)')
    const wishes = [
      ['  Glow-in-the-dark bracelet kit ', 'https://example.com/bracelets'],
      ['Fuzzy socks', ''],
      ['A big sketchbook', '']
    ]
    await ensureRows(page, 3)
    for (const [i, [text, url]] of wishes.entries()) {
      await wishText(wishRows(page).nth(i)).fill(text)
      await wishLink(wishRows(page).nth(i)).fill(url)
    }
    await save(page)

    expect(await memberRow('Ava')).toMatchObject({
      fav_color: 'Teal', fav_snack: 'Sour gummy worms', sizes: 'Youth M shirt, shoe 5', please_no: 'Nuts (allergy)'
    })
    expect(await itemsOf('Ava')).toEqual([
      { text: 'Glow-in-the-dark bracelet kit', url: 'https://example.com/bracelets', position: 0 },
      { text: 'Fuzzy socks', url: null, position: 1 },
      { text: 'A big sketchbook', url: null, position: 2 }
    ])

    await page.reload()
    await expect(page.getByLabel(/favorite color/i)).toHaveValue('Teal')
    await expect(page.getByLabel(/please no/i)).toHaveValue('Nuts (allergy)')
    await expect(wishRows(page)).toHaveCount(3)
    await expect(wishText(wishRows(page).nth(0))).toHaveValue('Glow-in-the-dark bracelet kit')
    await expect(wishLink(wishRows(page).nth(0))).toHaveValue('https://example.com/bracelets')
    await expect(wishText(wishRows(page).nth(2))).toHaveValue('A big sketchbook')
  })

  test('E2E-MEM-03 edit one wish and remove another; the database matches', async ({ page }) => {
    await openAs(page, S.tokens.Ava)
    await expect(wishRows(page)).toHaveCount(3)
    await wishText(wishRows(page).nth(1)).fill('Fuzzy rainbow socks')
    await wishRows(page).nth(0).getByRole('button', { name: /remove/i }).click()
    await expect(wishRows(page)).toHaveCount(2)
    await save(page)
    expect(await itemsOf('Ava')).toEqual([
      { text: 'Fuzzy rainbow socks', url: null, position: 0 },
      { text: 'A big sketchbook', url: null, position: 1 }
    ])
  })

  test("E2E-MEM-04 I'm done marks the list done, and the state shows after a reload", async ({ page }) => {
    await openAs(page, S.tokens.Ava)
    await doneButton(page).click()
    await expect(page.locator('[data-test="done-state"]')).toBeVisible()
    await expect.poll(async () => (await memberRow('Ava')).list_done).toBe(true)
    await page.reload()
    await expect(page.locator('[data-test="done-state"]')).toBeVisible()
  })

  test("E2E-MEM-05 everyone's lists show other members' About me, wishes and links", async ({ page }) => {
    await openAs(page, S.tokens.Ava)
    const ben = person(page, 'Ben')
    await expect(ben).toHaveCount(1)
    for (const t of ['Purple', 'Youth S, shoe 4', 'Glitter', 'Watercolor paint set']) await expect(ben).toContainText(t)
    await expect(ben.getByRole('link').first()).toHaveAttribute('href', 'https://example.com/paint')
    await expect(ben).not.toContainText(/not done yet/i)
    await expect(person(page, 'Cy')).toContainText(/not done yet/i)
    await expect(person(page, 'Dot')).toHaveCount(1)

    // members arrive ordered by first name; the page keeps that order
    const headings = await page.locator('[data-test="person"]').evaluateAll(els =>
      els.map(el => (el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent ?? '').trim()))
    const order = headings.map(h => ['Ava', 'Ben', 'Cy', 'Dot'].find(n => h.startsWith(n))).filter(Boolean)
    expect(order).toEqual([...order].sort())
    expect(order).toEqual(expect.arrayContaining(['Ben', 'Cy', 'Dot']))
  })

  test('E2E-MEM-06 while open there is no hint of a match anywhere', async ({ page }) => {
    const net = capture(page)
    await openAs(page, S.tokens.Ava)
    await expect(person(page, 'Ben')).toHaveCount(1)
    expect((await page.content()).toLowerCase()).not.toContain('you drew')
    await expect(page.locator('[data-test="drawn-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="match-list"]')).toHaveCount(0)
    const views = (await net.views()).filter(Boolean)
    expect(views.length).toBeGreaterThan(0)
    for (const v of views) expect(v.match).toBeNull()
  })

  test('E2E-MEM-07 while drawn there is still no hint of a match, and nothing is marked opened', async ({ page }) => {
    const net = capture(page)
    await openAs(page, S.tokens.Gus)
    await expect(greeting(page)).toContainText('Hi Gus')
    await expect(header(page)).toContainText(DRAWN_NAME)
    await expect(person(page, 'Hal')).toContainText('Yo-yo') // lists are public; the match is not
    expect((await page.content()).toLowerCase()).not.toContain('you drew')
    await expect(page.locator('[data-test="drawn-name"]')).toHaveCount(0)
    await expect(page.locator('[data-test="match-list"]')).toHaveCount(0)
    for (const v of (await net.views()).filter(Boolean)) expect(v.match).toBeNull()
    expect((await openedAt('drawn')).every(r => r.opened === false)).toBe(true)
  })

  test("E2E-MEM-08 once sent, I see 'You drew' with my own match and their list", async ({ page }) => {
    await openAs(page, S.tokens.Dee)
    await expect(greeting(page)).toContainText('Hi Dee')
    await expect(page.getByText(/you drew/i).first()).toBeVisible()
    await expect(page.locator('[data-test="drawn-name"]')).toContainText('Eli')
    await expect(page.locator('[data-test="drawn-name"]')).not.toContainText(/Fay|Dee/)
    const list = page.locator('[data-test="match-list"]')
    for (const t of ['Green', 'Popcorn', 'Dragon book', 'Kite']) await expect(list).toContainText(t)
    await expect(list.getByRole('link').first()).toHaveAttribute('href', 'https://example.com/dragons')
    await expect.poll(async () => openedAt('sent')).toEqual([
      { first_name: 'Dee', opened: true },
      { first_name: 'Eli', opened: false },
      { first_name: 'Fay', opened: false }
    ])
  })

  test('E2E-MEM-09 once sent, I can still edit and save my own list', async ({ page }) => {
    await openAs(page, S.tokens.Dee)
    await expect(page.locator('[data-test="drawn-name"]')).toContainText('Eli')
    const edit = page.getByRole('button', { name: /edit my list/i })
    if (await edit.isVisible()) await edit.click()
    await ensureRows(page, 1)
    await wishText(wishRows(page).nth(0)).fill('Snow globe')
    await save(page)
    expect(await itemsOf('Dee')).toEqual([{ text: 'Snow globe', url: null, position: 0 }])
  })

  test('E2E-MEM-10 an unknown or garbled link shows "link not found" and no data', async ({ page }) => {
    const ava = S.tokens.Ava
    const cases = [
      'Zz9_Qq8-Xx7_Ww6-', // 16 characters, nobody's token
      '<b>hi</b>',
      `${ava}${ava}`, // old-length token
      ava.slice(0, 8)
    ]
    const check = async () => {
      await expect(page.getByText(/link not found/i).first()).toBeVisible()
      await expect(wishRows(page)).toHaveCount(0)
      await expect(saveButton(page)).toHaveCount(0)
      await expect(page.locator('[data-test="person"]')).toHaveCount(0)
      const text = await bodyText(page)
      for (const leak of [OPEN_NAME, 'Ava', 'Ben', 'Watercolor', '$20', "Maya's house"]) {
        expect(text.includes(leak), `"${leak}" must not appear on a not-found page`).toBe(false)
      }
    }
    for (const t of cases) { await openAs(page, t); await check() }
    await page.goto('/m/') // no fragment at all
    await check()
  })

  test('E2E-MEM-11 editing the fragment in place never shows the old data', async ({ page }) => {
    const ava = S.tokens.Ava
    const garbled = ava.slice(0, 15) + (ava[15] === 'A' ? 'B' : 'A')
    await openAs(page, ava)
    await expect(greeting(page)).toContainText('Hi Ava')

    await setHash(page, garbled)
    await expect(page.getByText(/link not found/i).first()).toBeVisible()
    await expect(wishRows(page)).toHaveCount(0)
    let text = await bodyText(page)
    for (const leak of [OPEN_NAME, 'Hi Ava', 'Ben', 'Watercolor', 'Fuzzy rainbow socks']) {
      expect(text.includes(leak), `"${leak}" must not survive a fragment change`).toBe(false)
    }

    await openAs(page, ava)
    await expect(greeting(page)).toContainText('Hi Ava')
    await setHash(page, S.tokens.Hal) // a token from another circle
    await expect(greeting(page)).toContainText('Hi Hal')
    await expect(header(page)).toContainText(DRAWN_NAME)
    text = await bodyText(page)
    for (const leak of [OPEN_NAME, 'Hi Ava', 'Ben', 'Watercolor', 'Fuzzy rainbow socks', 'Teal']) {
      expect(text.includes(leak), `"${leak}" from the other circle must not show`).toBe(false)
    }
  })

  test('E2E-MEM-12 a wish with a link but no text shows an inline error and saves nothing', async ({ page }) => {
    await openAs(page, S.tokens.Dot)
    await expect(greeting(page)).toContainText('Hi Dot')
    await ensureRows(page, 1)
    const row = wishRows(page).nth(0)
    await wishText(row).fill('   ')
    await wishLink(row).fill('https://example.com/x')
    await saveButton(page).click()
    await expect(wishText(row)).toHaveAttribute('aria-invalid', 'true')
    await expect(wishText(row)).toHaveAccessibleDescription(/\S/)
    expect(await itemsOf('Dot')).toEqual([])
  })

  test('E2E-MEM-13 javascript: and scheme-less links are refused inline and save nothing', async ({ page }) => {
    let dialogs = 0
    page.on('dialog', d => { dialogs++; d.dismiss() })
    for (const bad of ['javascript:alert(1)', 'example.com/socks']) {
      await openAs(page, S.tokens.Dot)
      await expect(greeting(page)).toContainText('Hi Dot')
      await ensureRows(page, 1)
      const row = wishRows(page).nth(0)
      await wishText(row).fill('Socks')
      await wishLink(row).fill(bad)
      await saveButton(page).click()
      await expect(wishLink(row)).toHaveAttribute('aria-invalid', 'true')
      await expect(wishLink(row)).toHaveAccessibleDescription(/http/i)
      expect(await itemsOf('Dot')).toEqual([])
    }
    expect(dialogs).toBe(0)
  })

  test('E2E-MEM-14 long text is capped at 200 (links at 500)', async ({ page }) => {
    await openAs(page, S.tokens.Dot)
    await expect(greeting(page)).toContainText('Hi Dot')
    const color = page.getByLabel(/favorite color/i)
    await expect(color).toHaveAttribute('maxlength', '200')
    await color.fill('c'.repeat(250))
    expect((await color.inputValue()).length).toBeLessThanOrEqual(200)

    await ensureRows(page, 1)
    const row = wishRows(page).nth(0)
    await expect(wishText(row)).toHaveAttribute('maxlength', '200')
    await expect(wishLink(row)).toHaveAttribute('maxlength', '500')
    await wishText(row).fill('w'.repeat(250))
    expect((await wishText(row).inputValue()).length).toBeLessThanOrEqual(200)
    await wishLink(row).fill(`https://example.com/${'a'.repeat(600)}`)
    expect((await wishLink(row).inputValue()).length).toBeLessThanOrEqual(500)

    await save(page)
    expect((await memberRow('Dot')).fav_color.length).toBeLessThanOrEqual(200)
    const items = await itemsOf('Dot')
    expect(items).toHaveLength(1)
    expect(items[0].text.length).toBeLessThanOrEqual(200)
    expect(items[0].url.length).toBeLessThanOrEqual(500)
  })

  test('E2E-MEM-15 an 11th wish is blocked', async ({ page }) => {
    await openAs(page, S.tokens.Dot)
    await expect(greeting(page)).toContainText('Hi Dot')
    await ensureRows(page, 10)
    for (let i = 0; i < 10; i++) await wishText(wishRows(page).nth(i)).fill(`Wish ${i + 1}`)
    const add = addWishButton(page)
    const blocked = (await add.count()) === 0 || !(await add.isVisible()) || (await add.isDisabled())
    expect(blocked, 'the add button must be disabled or hidden at 10 wishes').toBe(true)
    if (await add.count()) await add.click({ force: true, timeout: 2000 }).catch(() => {})
    await expect(wishRows(page)).toHaveCount(10)
    await save(page)
    expect(await itemsOf('Dot')).toHaveLength(10)
  })

  test('E2E-MEM-16 the token travels only in RPC bodies; the page calls only the member RPCs', async ({ page, sendCalls }) => {
    const net = capture(page)
    const token = S.tokens.Cy // not done yet, so "I'm done" is there to tap
    await openAs(page, token)
    await expect(greeting(page)).toContainText('Hi Cy')
    await save(page) // save_my_list
    await doneButton(page).click() // set_list_done
    await expect(page.locator('[data-test="done-state"]')).toBeVisible()

    const inUrl = net.requests.filter(r => r.url.includes(token)).length
    expect(inUrl, 'requests with the token in their URL').toBe(0)
    const inHeaders = net.requests.filter(r => Object.values(r.headers).some(v => String(v).includes(token))).length
    expect(inHeaders, 'requests with the token in a header').toBe(0)

    const carrying = net.requests.filter(r => r.body.includes(token))
    expect(carrying.length, 'the token must reach the RPCs in a body').toBeGreaterThan(0)
    const rpcPath = /^\/rest\/v1\/rpc\/(member_view|save_my_list|set_list_done)$/
    const wrong = carrying.filter(r => r.method !== 'POST' || !rpcPath.test(new URL(r.url).pathname)).length
    expect(wrong, 'token-carrying requests that are not POSTs to a member RPC').toBe(0)

    const supa = net.requests.filter(r => /supabase\.co/.test(r.url) && r.method !== 'OPTIONS')
    const paths = [...new Set(supa.map(r => new URL(r.url).pathname))]
    for (const p of paths) expect(p).toMatch(rpcPath)
    for (const fn of ['member_view', 'save_my_list', 'set_list_done']) expect(paths).toContain(`/rest/v1/rpc/${fn}`)
    expect(sendCalls).toHaveLength(0)
  })

  test('E2E-MEM-17 no phone number appears in the page or in any response', async ({ page }) => {
    const net = capture(page)
    const forms = S.phones.flatMap(p => [p, p.slice(2)]) // +15555550110 and 5555550110
    for (const name of ['Ava', 'Dee']) {
      await openAs(page, S.tokens[name])
      await expect(greeting(page)).toContainText(`Hi ${name}`)
      const html = await page.content()
      const inPage = forms.filter(f => html.includes(f)).length
      expect(inPage, `phone numbers in ${name}'s page`).toBe(0)
    }
    const bodies = await net.bodies()
    expect(bodies.length).toBeGreaterThan(0)
    const leaks = bodies.filter(b => forms.some(f => b.includes(f))).length
    expect(leaks, 'Supabase responses containing a phone number').toBe(0)
  })

  test('E2E-MEM-18 text that looks like HTML is shown as text, never run', async ({ page }) => {
    let dialogs = 0
    page.on('dialog', d => { dialogs++; d.dismiss() })
    await openAs(page, S.tokens.Ava)
    const ben = person(page, 'Ben')
    await expect(ben).toContainText(XSS_WISH)
    await expect(ben).toContainText(XSS_ABOUT)
    await expect(header(page)).toContainText('<i>Crew</i>')
    await expect(page.locator('img[src="x"]')).toHaveCount(0)
    await expect(page.locator('b', { hasText: 'Hot chocolate' })).toHaveCount(0)
    await expect(page.locator('i', { hasText: 'Crew' })).toHaveCount(0)
    expect(await page.evaluate(() => window.__xss)).toBeUndefined()
    expect(dialogs).toBe(0)
  })

  test('E2E-MEM-19 every wish link opens safely (target _blank, rel noopener noreferrer)', async ({ page }) => {
    const checkLinks = async (scope, min) => {
      const links = await scope.locator('a[href]').evaluateAll(as => as.map(a => ({
        href: a.getAttribute('href'), target: a.getAttribute('target'), rel: (a.getAttribute('rel') ?? '').split(/\s+/)
      })))
      expect(links.length).toBeGreaterThanOrEqual(min)
      for (const l of links) {
        expect(l.href).toMatch(/^https?:\/\//i)
        expect(l.target).toBe('_blank')
        expect(l.rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
      }
    }
    await openAs(page, S.tokens.Ava)
    await expect(person(page, 'Ben')).toHaveCount(1)
    await checkLinks(page.locator('[data-test="person"]'), 2)
    await expect(page.locator('a[href^="javascript:" i]')).toHaveCount(0)

    await openAs(page, S.tokens.Dee)
    await expect(page.locator('[data-test="match-list"]')).toBeVisible()
    await checkLinks(page.locator('[data-test="match-list"]'), 1)
  })

  test('E2E-MEM-20 no horizontal scroll at 375px, on the list page and the reveal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

    await openAs(page, S.tokens.Ava)
    await expect(person(page, 'Ben')).toContainText(LONG_WORD.slice(0, 20))
    expect(await overflow()).toBeLessThanOrEqual(0)

    await openAs(page, S.tokens.Dee)
    await expect(page.locator('[data-test="drawn-name"]')).toBeVisible()
    expect(await overflow()).toBeLessThanOrEqual(0)
  })
})
