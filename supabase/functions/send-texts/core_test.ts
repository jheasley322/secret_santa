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
// Revised 2026-10-24 for spec "Security hardening" S1: the cap and reserve are
// read from private.text_budget (used, cap, last_quota), not by counting texts
// rows. budgetAllows is the handler's read-only pre-check (it keeps "cap before
// links" in the order of checks); the database's claim is the real gate.
Deno.test('BUD-01 the cap is used + batch <= cap, from the counter', async () => {
  const { budgetAllows } = await core()
  assertEquals(budgetAllows({ used: 44, cap: 45, lastQuota: null, batchSize: 1 }), true, '44 + 1 = 45')
  assertEquals(budgetAllows({ used: 45, cap: 45, lastQuota: null, batchSize: 1 }), false, '45 + 1 > 45')
})

Deno.test('BUD-02 the texts table is not an input (deleted rows cannot reset the cap)', async () => {
  const { budgetAllows } = await core()
  // A caller passing an empty texts list alongside a full counter is still refused.
  assertEquals(budgetAllows({ used: 45, cap: 45, lastQuota: null, batchSize: 1, texts: [] } as any), false)
})

Deno.test('BUD-03 the whole batch must fit', async () => {
  const { budgetAllows } = await core()
  assertEquals(budgetAllows({ used: 40, cap: 45, lastQuota: null, batchSize: 5 }), true, '40 + 5 = 45')
  assertEquals(budgetAllows({ used: 40, cap: 45, lastQuota: null, batchSize: 6 }), false, '40 + 6 > 45')
})

Deno.test('BUD-04 at the cap a single text is refused; an empty batch is allowed', async () => {
  const { budgetAllows } = await core()
  assertEquals(budgetAllows({ used: 45, cap: 45, lastQuota: null, batchSize: 1 }), false)
  assertEquals(budgetAllows({ used: 45, cap: 45, lastQuota: null, batchSize: 0 }), true)
  assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: null, batchSize: 45 }), true)
  assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: null, batchSize: 46 }), false)
})

Deno.test('BUD-05 last_quota at or below 5 refuses; null (no send yet) and 6 allow', async () => {
  const { budgetAllows } = await core()
  for (const q of [5, 4, 0]) assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: q, batchSize: 1 }), false, `last_quota ${q}`)
  assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: 6, batchSize: 1 }), true, 'last_quota 6')
  assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: null, batchSize: 1 }), true, 'no quota recorded yet')
  assertEquals(budgetAllows({ used: 0, cap: 45, lastQuota: 200, batchSize: 1 }), true, 'Joe bought credit')
})

Deno.test('BUD-06 an empty batch fits even at the reserve', async () => {
  const { budgetAllows } = await core()
  assertEquals(budgetAllows({ used: 45, cap: 45, lastQuota: 1, batchSize: 0 }), true)
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

Deno.test('RATE-05 dry-run rows count toward the hourly limit (Decision 2)', async () => {
  const { isRateLimited } = await core()
  const texts = rows(3, { dry_run: true, created_at: minutesAgo(5) })
  assertEquals(isRateLimited({ texts, memberId: memberId('Ava'), now: new Date() }), true)
})

Deno.test('RATE-06 pending rows count toward the hourly limit (spec S3)', async () => {
  const { isRateLimited } = await core()
  const texts = rows(3, { status: 'pending', created_at: minutesAgo(5) })
  assertEquals(isRateLimited({ texts, memberId: memberId('Ava'), now: new Date() }), true)
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

Deno.test('PICK-06 a dry-run invite does not count as already invited (Decision 1)', async () => {
  const { pickRecipients } = await core()
  const members = [m('Ava'), m('Ben')]
  const texts = [row({ member_id: memberId('Ava'), kind: 'invite', status: 'sent', dry_run: true })]
  const r = pickRecipients({ kind: 'invite', members, texts })
  assertEquals(ids(r.send), [memberId('Ava'), memberId('Ben')].sort(), 'the first real Send invites still texts Ava')
})

Deno.test('PICK-07 a pending real invite counts as already invited (spec S3)', async () => {
  const { pickRecipients } = await core()
  const members = [m('Ava'), m('Ben')]
  const texts = [
    row({ member_id: memberId('Ava'), kind: 'invite', status: 'pending', dry_run: false }),
    row({ member_id: memberId('Ben'), kind: 'invite', status: 'pending', dry_run: true })
  ]
  const r = pickRecipients({ kind: 'invite', members, texts })
  assertEquals(ids(r.send), [memberId('Ben')], 'Ava has a real invite in flight; Ben only a dry-run one')
})
