// SET, BUD, RATE, PICK: the pure core of send-texts (core.ts).
// Spec: "Texting", "Texting -> HARD LIMITS", "Texting details (Phase 2 contract)",
// "Re-send". Scenario IDs are in tests/SCENARIOS.md.
//
// Run: npm run test:deno (net, env, write and run are denied).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from './test_assert.ts'
import { BASE, load, memberId } from './test_fakes.ts'

const core = () => load('./core.ts')

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const row = (o: Partial<any> = {}) => ({
  member_id: memberId('Ava'), kind: 'invite', status: 'sent', dry_run: false,
  quota_remaining: null, created_at: minutesAgo(120), ...o
})
const rows = (n: number, o: Partial<any> = {}) => Array.from({ length: n }, () => row(o))

// ---------------------------------------------------------------- SET
Deno.test('SET-01 an empty environment is dry run with links not approved', async () => {
  const { readSettings } = await core()
  const s = readSettings({})
  assertEquals(s.dryRun, true, 'missing TEXTS_DRY_RUN must mean dry run')
  assertEquals(s.linksApproved, false, 'missing TEXT_LINKS_APPROVED must mean not approved')
})

Deno.test('SET-02 TEXTS_DRY_RUN: only the exact value "false" turns on real sends', async () => {
  const { readSettings } = await core()
  assertEquals(readSettings({ TEXTS_DRY_RUN: 'true' }).dryRun, true, '"true"')
  assertEquals(readSettings({ TEXTS_DRY_RUN: 'false' }).dryRun, false, '"false"')
  for (const v of ['', '0', 'no', 'off', 'nope', 'flase', 'disabled']) {
    assertEquals(readSettings({ TEXTS_DRY_RUN: v }).dryRun, true, `TEXTS_DRY_RUN=${JSON.stringify(v)} must stay dry run`)
  }
})

Deno.test('SET-03 TEXT_LINKS_APPROVED: only the exact value "true" approves links', async () => {
  const { readSettings } = await core()
  assertEquals(readSettings({ TEXT_LINKS_APPROVED: 'true' }).linksApproved, true, '"true"')
  for (const v of [undefined, '', 'false', '1', 'yes', 'approved', 'ture']) {
    const env: Record<string, string> = v === undefined ? {} : { TEXT_LINKS_APPROVED: v }
    assertEquals(readSettings(env).linksApproved, false, `TEXT_LINKS_APPROVED=${JSON.stringify(v)} must not approve`)
  }
})

Deno.test('SET-04 APP_BASE_URL is the base for links', async () => {
  const { readSettings } = await core()
  assertEquals(readSettings({ APP_BASE_URL: BASE }).appBaseUrl.replace(/\/$/, ''), BASE)
})

// ---------------------------------------------------------------- BUD
Deno.test('BUD-01 the cap counts real rows of every status, across circles', async () => {
  const { budgetAllows } = await core()
  const texts = [...rows(40), ...rows(4, { status: 'failed' }), ...rows(1, { member_id: memberId('Zed'), kind: 'reveal' })] // 45 real
  assertEquals(budgetAllows({ texts, cap: 45, batchSize: 1 }), false, '45 used (4 failed) + 1 > 45')
  assertEquals(budgetAllows({ texts: texts.slice(1), cap: 45, batchSize: 1 }), true, '44 used + 1 = 45')
})

Deno.test('BUD-02 dry-run rows never count', async () => {
  const { budgetAllows } = await core()
  const texts = [...rows(44), ...rows(500, { dry_run: true }), ...rows(50, { dry_run: true, status: 'failed' })]
  assertEquals(budgetAllows({ texts, cap: 45, batchSize: 1 }), true)
})

Deno.test('BUD-03 the whole batch must fit: used + batch <= cap', async () => {
  const { budgetAllows } = await core()
  const texts = rows(40)
  assertEquals(budgetAllows({ texts, cap: 45, batchSize: 5 }), true, '40 + 5 = 45')
  assertEquals(budgetAllows({ texts, cap: 45, batchSize: 6 }), false, '40 + 6 > 45')
})

Deno.test('BUD-04 at the cap a single text is refused; an empty batch is allowed', async () => {
  const { budgetAllows } = await core()
  assertEquals(budgetAllows({ texts: rows(45), cap: 45, batchSize: 1 }), false)
  assertEquals(budgetAllows({ texts: rows(45), cap: 45, batchSize: 0 }), true)
  assertEquals(budgetAllows({ texts: [], cap: 45, batchSize: 45 }), true)
  assertEquals(budgetAllows({ texts: [], cap: 45, batchSize: 46 }), false)
})

Deno.test('BUD-05 the latest recorded quotaRemaining at or below 5 refuses', async () => {
  const { budgetAllows } = await core()
  const at = (q: number | null, m: number, extra: Partial<any> = {}) => row({ quota_remaining: q, created_at: minutesAgo(m), ...extra })
  assertEquals(budgetAllows({ texts: [at(30, 90), at(5, 60)], cap: 45, batchSize: 1 }), false, 'latest is 5')
  assertEquals(budgetAllows({ texts: [at(30, 90), at(4, 60)], cap: 45, batchSize: 1 }), false, 'latest is 4')
  assertEquals(budgetAllows({ texts: [at(30, 90), at(0, 60)], cap: 45, batchSize: 1 }), false, 'latest is 0')
  assertEquals(budgetAllows({ texts: [at(30, 90), at(6, 60)], cap: 45, batchSize: 1 }), true, 'latest is 6')
  assertEquals(
    budgetAllows({ texts: [at(5, 90), at(null, 30, { status: 'failed' })], cap: 45, batchSize: 1 }), false,
    'a later failed row with no quota does not reset the reserve check'
  )
  assertEquals(budgetAllows({ texts: [at(3, 90), at(200, 30)], cap: 45, batchSize: 1 }), true, 'Joe bought credit: latest is 200')
  // Order of the array must not matter, only created_at.
  assertEquals(budgetAllows({ texts: [at(5, 30), at(200, 90)], cap: 45, batchSize: 1 }), false, 'latest by time is 5')
})

Deno.test('BUD-06 dry-run rows quota values are ignored', async () => {
  const { budgetAllows } = await core()
  const texts = [row({ quota_remaining: 30, created_at: minutesAgo(90) }), row({ dry_run: true, quota_remaining: 1, created_at: minutesAgo(10) })]
  assertEquals(budgetAllows({ texts, cap: 45, batchSize: 1 }), true)
})

// ---------------------------------------------------------------- RATE
Deno.test('RATE-01 three texts in the last hour make the next one the 4th', async () => {
  const { isRateLimited } = await core()
  const now = new Date()
  const recent = (n: number) => rows(n, { created_at: minutesAgo(10) })
  assertEquals(isRateLimited({ texts: recent(2), memberId: memberId('Ava'), now }), false, '2 in the hour')
  assertEquals(isRateLimited({ texts: recent(3), memberId: memberId('Ava'), now }), true, '3 in the hour')
})

Deno.test('RATE-02 failed texts count', async () => {
  const { isRateLimited } = await core()
  const texts = rows(3, { status: 'failed', created_at: minutesAgo(5) })
  assertEquals(isRateLimited({ texts, memberId: memberId('Ava'), now: new Date() }), true)
})

Deno.test('RATE-03 texts older than an hour do not count', async () => {
  const { isRateLimited } = await core()
  const texts = [...rows(3, { created_at: minutesAgo(61) }), ...rows(2, { created_at: minutesAgo(59) })]
  assertEquals(isRateLimited({ texts, memberId: memberId('Ava'), now: new Date() }), false)
})

Deno.test('RATE-04 only this member\'s texts count', async () => {
  const { isRateLimited } = await core()
  const texts = rows(10, { member_id: memberId('Ben'), created_at: minutesAgo(5) })
  assertEquals(isRateLimited({ texts, memberId: memberId('Ava'), now: new Date() }), false)
  assertEquals(isRateLimited({ texts, memberId: memberId('Ben'), now: new Date() }), true)
})

// ---------------------------------------------------------------- PICK
const m = (label: string, phone: string | null = '+15555550100') => ({ id: memberId(label), circle_id: 'c1', first_name: label, phone, token: `tok-${label}` })
const ids = (list: any[]) => list.map((x: any) => x.id).sort()

Deno.test('PICK-01 invite batch skips successful real invites, re-texts failed ones', async () => {
  const { pickRecipients } = await core()
  const members = [m('Ava'), m('Ben'), m('Cy')]
  const texts = [
    row({ member_id: memberId('Ava'), kind: 'invite', status: 'sent' }),
    row({ member_id: memberId('Ben'), kind: 'invite', status: 'failed' })
  ]
  const r = pickRecipients({ kind: 'invite', members, texts })
  assertEquals(ids(r.send), [memberId('Ben'), memberId('Cy')].sort())
})

Deno.test('PICK-02 invite batch: no phone is skipped and reported', async () => {
  const { pickRecipients } = await core()
  const r = pickRecipients({ kind: 'invite', members: [m('Ava'), m('Dee', null)], texts: [] })
  assertEquals(ids(r.send), [memberId('Ava')])
  assert(r.skipped.some((s: any) => s.member_id === memberId('Dee')), 'Dee (no phone) must be reported as skipped')
})

Deno.test('PICK-03 reveal batch: every member with a phone once, invites notwithstanding', async () => {
  const { pickRecipients } = await core()
  const members = [m('Ava'), m('Ben'), m('Cy'), m('Dee', null)]
  const texts = [row({ member_id: memberId('Ava'), kind: 'invite' }), row({ member_id: memberId('Ben'), kind: 'invite' })]
  const r = pickRecipients({ kind: 'reveal', members, texts })
  assertEquals(ids(r.send), [memberId('Ava'), memberId('Ben'), memberId('Cy')].sort())
  assert(r.skipped.some((s: any) => s.member_id === memberId('Dee')))
})

Deno.test('PICK-04 one member: just that member, even if already invited', async () => {
  const { pickRecipients } = await core()
  const members = [m('Ava'), m('Ben')]
  const texts = [row({ member_id: memberId('Ava'), kind: 'invite', status: 'sent' })]
  const r = pickRecipients({ kind: 'invite', members, texts, memberId: memberId('Ava') })
  assertEquals(ids(r.send), [memberId('Ava')])
})

Deno.test('PICK-05 one member with no phone is skipped', async () => {
  const { pickRecipients } = await core()
  const r = pickRecipients({ kind: 'invite', members: [m('Ava'), m('Dee', null)], texts: [], memberId: memberId('Dee') })
  assertEquals(r.send.length, 0)
  assert(r.skipped.some((s: any) => s.member_id === memberId('Dee')))
})
