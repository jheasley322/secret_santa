// E2E-ELF-01..10: the Elf pages (index.html, circle.html).
// Spec: "The flow" 1-5, "Circle details", "Re-send", "Progress", "Pages",
// "Privacy rules". Scenario IDs are in tests/SCENARIOS.md.
//
// SAFETY: every page uses the fixtures in support/fixtures.mjs, which stub
// send-texts (dry-run rows only) and block textbelt.com. Circles are named
// "[e2e] ..." and swept before and after the run. Phones are fictional.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { test, expect } from './support/fixtures.mjs'
import { AUTH_DIR, E2E_PREFIX, SUPABASE_URL, publishableKey, sweepCircles, withDb } from './support/project.mjs'

const user = label => JSON.parse(readFileSync(join(AUTH_DIR, `${label}.user.json`), 'utf8'))
const NAME = `${E2E_PREFIX} Ava's Crew ${Date.now()}`

test.afterAll(async () => { await withDb(sweepCircles) })

async function circleIdByName (name) {
  return withDb(async db => (await db.query('select id from public.circles where name = $1', [name])).rows[0]?.id)
}

async function makeCircleFor (label, name, members = []) {
  return withDb(async db => {
    const { rows: [c] } = await db.query(
      'insert into public.circles (elf_id, name, budget, swap_date, swap_place) values ($1, $2, 10, $3, $4) returning id',
      [user(label).id, name, '2026-12-20', 'Secret Spot']
    )
    for (const [first, phone] of members) {
      await db.query('insert into public.members (circle_id, first_name, phone) values ($1, $2, $3)', [c.id, first, phone])
    }
    return c.id
  })
}

async function addMember (page, first, phone) {
  await page.getByLabel(/first name/i).fill(first)
  await page.getByLabel(/mobile/i).fill(phone)
  await page.getByRole('button', { name: /^add$/i }).click()
  await expect(page.locator('[data-test="member-row"]', { hasText: first })).toBeVisible()
}

const row = (page, name) => page.locator('[data-test="member-row"]', { hasText: name })

// ------------------------------------------------------------------ signed out
test.describe('signed out', () => {
  test('E2E-ELF-01 sign-in asks for an email and says "check your email"', async ({ page }) => {
    let otpCalls = 0
    await page.route('**/auth/v1/otp**', route => { otpCalls++; return route.fulfill({ status: 200, json: {} }) })
    await page.goto('/index.html')
    await page.getByLabel(/email/i).fill(`nobody@${'secret-santa-e2e.invalid'}`)
    await page.getByRole('button', { name: /sign-in link|sign in/i }).click()
    await expect(page.getByText(/check your email/i)).toBeVisible()
    expect(otpCalls).toBe(1)
  })

  // spec "Security hardening" S2: sign-ups are off, and the client asks for a
  // link only for an existing Elf. supabase-js sends shouldCreateUser: false
  // as create_user: false in the OTP request body.
  test('E2E-ELF-12 the sign-in request never creates an account (shouldCreateUser: false)', async ({ page }) => {
    const bodies = []
    await page.route('**/auth/v1/otp**', route => {
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, json: {} })
    })
    await page.goto('/index.html')
    await page.getByLabel(/email/i).fill(`nobody@${'secret-santa-e2e.invalid'}`)
    await page.getByRole('button', { name: /sign-in link|sign in/i }).click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0].create_user).toBe(false)
  })
})

// ------------------------------------------------------------------ Elf A
test.describe('Elf A', () => {
  test.use({ storageState: join(AUTH_DIR, 'elf_a.json') })
  test.describe.configure({ mode: 'serial' })

  let circleId

  test('E2E-ELF-02 create a circle and land on its page', async ({ page }) => {
    await page.goto('/index.html')
    await page.getByLabel(/circle name/i).fill(NAME)
    await page.getByLabel(/budget/i).fill('20')
    await page.getByLabel(/swap date/i).fill('2026-12-19')
    await page.getByLabel(/place/i).fill("Maya's house")
    await page.getByRole('button', { name: 'Create circle' }).click()
    await expect(page).toHaveURL(/circle\.html\?id=[0-9a-f-]{36}/)
    circleId = new URL(page.url()).searchParams.get('id')
    expect(circleId).toBe(await circleIdByName(NAME))
    const header = page.locator('header')
    await expect(header).toContainText(NAME)
    await expect(header).toContainText('$20')
    await expect(header).toContainText('Dec 19')
    await expect(header).toContainText("Maya's house")
  })

  test('E2E-ELF-03 add three kids; phones are stored as E.164', async ({ page }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    await addMember(page, 'Ava', '(555) 555-0101')
    await addMember(page, 'Ben', '555-555-0102')
    await addMember(page, 'Cy', '555.555.0103')
    for (const n of ['Ava', 'Ben', 'Cy']) await expect(row(page, n)).toContainText('Not sent yet')
    const phones = await withDb(async db => (await db.query(
      'select first_name, phone from public.members where circle_id = $1 order by first_name', [circleId])).rows)
    expect(phones).toEqual([
      { first_name: 'Ava', phone: '+15555550101' },
      { first_name: 'Ben', phone: '+15555550102' },
      { first_name: 'Cy', phone: '+15555550103' }
    ])
  })

  test('E2E-ELF-04 Send invites calls send-texts for the circle; rows show Text sent', async ({ page, sendCalls }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    await page.getByRole('button', { name: 'Send invites' }).click()
    for (const n of ['Ava', 'Ben', 'Cy']) await expect(row(page, n)).toContainText('Text sent')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].body).toEqual({ circle_id: circleId, kind: 'invite' })
    expect(sendCalls[0].authorization).toMatch(/^Bearer .+/)
    const rows = await withDb(async db => (await db.query(
      `select t.dry_run from public.texts t join public.members m on m.id = t.member_id where m.circle_id = $1`, [circleId])).rows)
    expect(rows.length).toBe(3)
    expect(rows.every(r => r.dry_run === true)).toBe(true)
  })

  test('E2E-ELF-05 progress shows 0 of 3 done, then 1 of 3 after a kid finishes', async ({ page }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    await expect(page.getByText('0 of 3 done').first()).toBeVisible()
    const token = await withDb(async db => (await db.query(
      "select token from public.members where circle_id = $1 and first_name = 'Ava'", [circleId])).rows[0].token)
    const kid = createClient(SUPABASE_URL, publishableKey(), { auth: { persistSession: false } })
    const { error } = await kid.rpc('set_list_done', { p_token: token, p_done: true })
    expect(error).toBeNull()
    await page.reload()
    await expect(page.getByText('1 of 3 done').first()).toBeVisible()
  })

  test('E2E-ELF-06 Copy link copies the full member link', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/circle.html?id=${circleId}`)
    await row(page, 'Ben').getByRole('button', { name: 'Copy link' }).click()
    const token = await withDb(async db => (await db.query(
      "select token from public.members where circle_id = $1 and first_name = 'Ben'", [circleId])).rows[0].token)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(`https://jheasley322.github.io/secret_santa/m/#${token}`)
  })

  test('E2E-ELF-07 Re-send sends for that one member only', async ({ page, sendCalls }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    const benId = await withDb(async db => (await db.query(
      "select id from public.members where circle_id = $1 and first_name = 'Ben'", [circleId])).rows[0].id)
    await row(page, 'Ben').getByRole('button', { name: 'Re-send' }).click()
    await expect.poll(() => sendCalls.length).toBe(1)
    expect(sendCalls[0].body).toEqual({ circle_id: circleId, kind: 'invite', member_id: benId })
  })

  test('E2E-ELF-08 my circles lists mine and not Elf B\'s', async ({ page }) => {
    const otherName = `${E2E_PREFIX} B's secret circle ${Date.now()}`
    await makeCircleFor('elf_b', otherName)
    await page.goto('/index.html')
    await expect(page.getByRole('link', { name: NAME })).toBeVisible()
    await expect(page.getByText(otherName)).toHaveCount(0)
  })

  test('E2E-ELF-09 an invalid phone shows an inline error and adds nobody', async ({ page }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    for (const bad of ['555-0101', 'call me']) {
      await page.getByLabel(/first name/i).fill('Dot')
      const phone = page.getByLabel(/mobile/i)
      await phone.fill(bad)
      await page.getByRole('button', { name: /^add$/i }).click()
      await expect(phone).toHaveAttribute('aria-invalid', 'true')
      await expect(phone).toHaveAccessibleDescription(/.+/)
    }
    await expect(row(page, 'Dot')).toHaveCount(0)
    const n = await withDb(async db => (await db.query(
      "select count(*)::int as n from public.members where circle_id = $1 and first_name = 'Dot'", [circleId])).rows[0].n)
    expect(n).toBe(0)
  })

  // Joe, Decision 5: a phone number is required when adding a member.
  test('E2E-ELF-13 adding a kid with no phone number shows an inline error and adds nobody', async ({ page }) => {
    await page.goto(`/circle.html?id=${circleId}`)
    await page.getByLabel(/first name/i).fill('Nell')
    const phone = page.getByLabel(/mobile/i)
    await phone.fill('')
    await page.getByRole('button', { name: /^add$/i }).click()
    await expect.poll(() => phone.evaluate(el => el.matches(':invalid') || el.getAttribute('aria-invalid') === 'true')).toBe(true)
    await expect(row(page, 'Nell')).toHaveCount(0)
    const n = await withDb(async db => (await db.query(
      "select count(*)::int as n from public.members where circle_id = $1 and first_name = 'Nell'", [circleId])).rows[0].n)
    expect(n).toBe(0)
  })

  // Joe, Decision 7: every circle must have a swap date.
  test('E2E-ELF-14 creating a circle without a swap date is refused and creates nothing', async ({ page }) => {
    const noDate = `${E2E_PREFIX} no date ${Date.now()}`
    await page.goto('/index.html')
    await page.getByLabel(/circle name/i).fill(noDate)
    const date = page.getByLabel(/swap date/i)
    await date.fill('')
    await page.getByRole('button', { name: 'Create circle' }).click()
    await expect.poll(() => date.evaluate(el => el.matches(':invalid') || el.getAttribute('aria-invalid') === 'true')).toBe(true)
    await expect(page).not.toHaveURL(/circle\.html/)
    expect(await circleIdByName(noDate)).toBeUndefined()
  })

  test('E2E-ELF-10 Elf B\'s circle page shows "not found" and none of its data', async ({ page }) => {
    const otherName = `${E2E_PREFIX} B's hidden circle ${Date.now()}`
    const id = await makeCircleFor('elf_b', otherName, [['Zed', '+15555550199']])
    await page.goto(`/circle.html?id=${id}`)
    await expect(page.getByText(/circle not found/i)).toBeVisible()
    const body = await page.locator('body').innerText()
    expect(body).not.toContain(otherName)
    expect(body).not.toContain('Zed')
    expect(body).not.toContain('0199')
    expect(body).not.toContain('Secret Spot')
  })

  test('E2E-ELF-11 the circle page has no horizontal scroll at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await page.goto(`/circle.html?id=${circleId}`)
    await expect(row(page, 'Ava')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
