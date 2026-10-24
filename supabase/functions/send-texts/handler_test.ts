// ST-01..34: the send-texts handler (handler.ts) with injected fakes.
// Spec: "Texting", "Texting -> HARD LIMITS", "Texting details (Phase 2 contract)"
// (interface, error texts, order of checks, who gets texted, dry-run bodies),
// "Circle status", "Re-send". Scenario IDs are in tests/SCENARIOS.md.
//
// SAFETY: the provider is always FakeProvider (records, never sends) and the
// suite runs with --deny-net. "Real mode" below means TEXTS_DRY_RUN=false
// against the fake, which is the only way to test the cap and links gate.
//
// Assertions are on outcomes: HTTP status, response JSON, rows the fake db
// ends up holding, circle status, and what the fake provider received.

// deno-lint-ignore-file no-explicit-any
import { assert, assert4xx, assertEquals, assertMatch } from './test_assert.ts'
import {
  ALLOW, BASE, ENV_DRY, ENV_EMPTY, ENV_REAL, ENV_REAL_NO_LINKS, JWT_B, JWT_C,
  call, load, memberId, seedText, token, world
} from './test_fakes.ts'

const messages = () => load('../_shared/messages.js')
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/
const septets = (s: string) => [...s].reduce((n, ch) => n + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0)

function nothingHappened (w: ReturnType<typeof world>, what: string) {
  assertEquals(w.provider.outbox.length, 0, `${what}: the provider must not be called`)
  assertEquals(w.db.inserted.length, 0, `${what}: no texts row may be written`)
}

function result (json: any, label: string) {
  return (json?.results ?? []).find((r: any) => r.member_id === memberId(label))
}

/** Fill the lifetime cap with old real rows on the other circle's member. */
function useUpCap (w: ReturnType<typeof world>, n = 45) {
  for (let i = 0; i < n; i++) seedText(w.db, 'Zed', { status: i % 10 === 0 ? 'failed' : 'sent', minutesAgo: 600 })
}

// ===================================================================== auth
Deno.test('ST-01 no Authorization header is refused and sends nothing', async () => {
  const w = world()
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' }, { auth: null })
  assert4xx(r.status)
  nothingHappened(w, 'no JWT')
})

Deno.test('ST-02 a caller who is not the circle\'s Elf gets "circle not found"', async () => {
  const w = world({ status: 'drawn' })
  for (const body of [{ circle_id: w.C1, kind: 'invite' }, { circle_id: w.C1, kind: 'reveal' }, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') }]) {
    const r = await call(w, ENV_REAL, body, { auth: JWT_B })
    assert4xx(r.status, JSON.stringify(body))
    assertEquals(r.json?.error, 'circle not found', JSON.stringify(body))
  }
  nothingHappened(w, 'non-owner')
  assertEquals(w.db.status(w.C1), 'drawn', 'status unchanged')
})

Deno.test('ST-03 an unknown circle_id gets "circle not found"', async () => {
  const w = world()
  const r = await call(w, ENV_REAL, { circle_id: '33333333-3333-4333-8333-333333333333', kind: 'invite' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'circle not found')
  nothingHappened(w, 'unknown circle')
})

Deno.test('ST-04 a member_id from another circle is refused and nobody is texted', async () => {
  const w = world()
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Zed') })
  assert4xx(r.status)
  nothingHappened(w, 'foreign member')
})

Deno.test('ST-05 malformed requests are refused and send nothing', async () => {
  const w = world()
  for (const body of ['{not json', {}, { kind: 'invite' }, { circle_id: w.C1 }, { circle_id: w.C1, kind: 'hello' }, { circle_id: w.C1, kind: 'INVITE' }, { circle_id: 42, kind: 'invite' }]) {
    const r = await call(w, ENV_REAL, body)
    assert4xx(r.status, `body ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
  nothingHappened(w, 'malformed')
})

Deno.test('ST-06 a CORS preflight succeeds with an allow-origin header and sends nothing', async () => {
  const w = world()
  const r = await call(w, ENV_REAL, null, { method: 'OPTIONS', auth: null })
  assert(r.status >= 200 && r.status < 300, `preflight got HTTP ${r.status}`)
  assert(r.headers.get('access-control-allow-origin'), 'Access-Control-Allow-Origin missing')
  nothingHappened(w, 'preflight')
})

// =================================================================== status
Deno.test('ST-07 a whole-circle reveal while open gets "names have not been drawn yet"', async () => {
  const w = world({ status: 'open' })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'names have not been drawn yet')
  nothingHappened(w, 'reveal while open')
  assertEquals(w.db.status(w.C1), 'open')
})

Deno.test('ST-08 a whole-circle reveal while sent is refused (nobody texted twice)', async () => {
  const w = world({ status: 'sent' })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assert4xx(r.status)
  nothingHappened(w, 'second reveal')
})

Deno.test('ST-09 a one-member reveal before the names are sent is refused', async () => {
  const w = world({ status: 'drawn' })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ava') })
  assert4xx(r.status)
  nothingHappened(w, 'early single reveal')
  assertEquals(w.db.status(w.C1), 'drawn')
})

// ==================================================================== order
Deno.test('ST-10 order: ownership is checked before status and cap', async () => {
  const w = world({ status: 'open' })
  useUpCap(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' }, { auth: JWT_B })
  assertEquals(r.json?.error, 'circle not found')
  nothingHappened(w, 'order 1')
})

Deno.test('ST-11 order: status is checked before cap and links', async () => {
  const w = world({ status: 'open' })
  useUpCap(w)
  const r = await call(w, ENV_REAL_NO_LINKS, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(r.json?.error, 'names have not been drawn yet')
  nothingHappened(w, 'order 2')
})

Deno.test('ST-12 order: cap is checked before links and rate limit', async () => {
  const w = world()
  useUpCap(w, 42)
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { minutesAgo: 10 }) // 45 real in total, and Ava is rate-limited
  const r = await call(w, ENV_REAL_NO_LINKS, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(w, 'order 3')
})

Deno.test('ST-13 order: links are checked before the rate limit', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { minutesAgo: 10 })
  const r = await call(w, ENV_REAL_NO_LINKS, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r.json?.error, 'links not approved yet')
  nothingHappened(w, 'order 4')
})

Deno.test('ST-14 order: the rate limit is last before sending', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { minutesAgo: 10 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'too many texts, try again in an hour')
  nothingHappened(w, 'order 5')
})

// ============================================================ credit safety
function capWorld () {
  // 43 real rows used: Cy's successful invite (1) + Zed in another circle (39 sent + 3 failed).
  // Plus 200 dry-run rows that must not count.
  const w = world({ extra: [{ label: 'Dee', phone: '+15555550104' }] })
  seedText(w.db, 'Cy', { minutesAgo: 300 })
  for (let i = 0; i < 39; i++) seedText(w.db, 'Zed', { minutesAgo: 300 })
  for (let i = 0; i < 3; i++) seedText(w.db, 'Zed', { status: 'failed', minutesAgo: 300 })
  // On the other circle's member, so this test says nothing about whether a
  // dry-run invite counts as "already invited" (open question 3).
  for (let i = 0; i < 200; i++) seedText(w.db, 'Zed', { dry_run: true, minutesAgo: 300 })
  return w
}

Deno.test('ST-15 cap: a batch that fits is sent; one over refuses the whole batch', async () => {
  // Fits: Ava + Ben (Dee removed) = 2 -> 45.
  const fits = capWorld()
  fits.db.members = fits.db.members.filter(m => m.first_name !== 'Dee')
  const ok = await call(fits, ENV_REAL, { circle_id: fits.C1, kind: 'invite' })
  assertEquals(ok.status, 200, `expected 200, got ${ok.status} ${JSON.stringify(ok.json)}`)
  assertEquals(fits.provider.outbox.map(s => s.phone).sort(), ['+15555550101', '+15555550102'])

  // Over: Ava + Ben + Dee = 3 -> 46 > 45.
  const over = capWorld()
  const r = await call(over, ENV_REAL, { circle_id: over.C1, kind: 'invite' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(over, 'batch over the cap')
})

Deno.test('ST-16 cap: the cap comes from the database (Joe raises it to 46)', async () => {
  const w = capWorld()
  w.db.cap = 46
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.length, 3)
})

Deno.test('ST-17 cap: at the cap a single Re-send is refused before the provider', async () => {
  const w = world()
  useUpCap(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(w, 'at cap')
})

Deno.test('ST-18 reserve: last quotaRemaining 5 refuses; 6 sends', async () => {
  const low = world()
  seedText(low.db, 'Zed', { quota_remaining: 5, minutesAgo: 300 })
  const r = await call(low, ENV_REAL, { circle_id: low.C1, kind: 'invite', member_id: memberId('Ava') })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(low, 'quota at reserve')

  const ok = world()
  seedText(ok.db, 'Zed', { quota_remaining: 6, minutesAgo: 300 })
  const r2 = await call(ok, ENV_REAL, { circle_id: ok.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r2.status, 200, JSON.stringify(r2.json))
  assertEquals(ok.provider.outbox.length, 1)
})

Deno.test('ST-19 reserve mid-batch: after quotaRemaining 5, nothing more is sent', async () => {
  const w = world({ extra: [{ label: 'Dee', phone: '+15555550104' }] })
  w.provider.script = [
    { success: true, textId: 'tb-a', quotaRemaining: 6 },
    { success: true, textId: 'tb-b', quotaRemaining: 5 }
  ]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(w.provider.outbox.length, 2, 'exactly two texts may reach the provider')
  assertEquals(w.db.inserted.filter(t => t.status === 'sent').length, 2, 'only two rows may say sent')
  const sentInResults = (r.json?.results ?? []).filter((x: any) => x.status === 'sent').length
  assert(sentInResults <= 2, `response claims ${sentInResults} sent`)

  // And the next request is refused before the provider.
  const before = w.provider.outbox.length
  const r2 = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r2.json?.error, 'text budget used up')
  assertEquals(w.provider.outbox.length, before)
})

// ==================================================================== links
Deno.test('ST-20 links gate: real sends refused while links are not approved', async () => {
  for (const env of [ENV_REAL_NO_LINKS, { ...ENV_REAL_NO_LINKS, TEXT_LINKS_APPROVED: 'false' }]) {
    const inv = world()
    const r = await call(inv, env, { circle_id: inv.C1, kind: 'invite' })
    assert4xx(r.status)
    assertEquals(r.json?.error, 'links not approved yet')
    nothingHappened(inv, 'invite, links not approved')

    const rev = world({ status: 'drawn' })
    const r2 = await call(rev, env, { circle_id: rev.C1, kind: 'reveal' })
    assertEquals(r2.json?.error, 'links not approved yet')
    nothingHappened(rev, 'reveal, links not approved')
    assertEquals(rev.db.status(rev.C1), 'drawn', 'a refused reveal must not lock the circle')
  }
})

Deno.test('ST-21 links gate: dry run still runs and logs the full link', async () => {
  const w = world()
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite' }) // no TEXT_LINKS_APPROVED
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.inserted.length, 3)
  for (const t of w.db.inserted) {
    const m = w.db.members.find(x => x.id === t.member_id)!
    assert(t.body?.includes(`${BASE}/m/#${m.token}`), `body for ${m.first_name} lacks the full link: ${t.body}`)
  }
})

// ==================================================================== batch
Deno.test('ST-22 Send invites: skips the invited, re-texts the failed, reports no-phone', async () => {
  const w = world({ extra: [{ label: 'Dee', phone: null }] })
  seedText(w.db, 'Ava', { kind: 'invite', status: 'sent', minutesAgo: 300 })
  seedText(w.db, 'Ben', { kind: 'invite', status: 'failed', minutesAgo: 300 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.map(s => s.phone).sort(), ['+15555550102', '+15555550103'], 'Ben and Cy only')
  const j = r.json
  for (const k of ['sent', 'failed', 'skipped', 'dry_run', 'results']) assert(k in (j ?? {}), `response lacks "${k}"`)
  assertEquals(j.sent, 2)
  assertEquals(j.failed, 0)
  assertEquals(j.dry_run, false)
  assertEquals(result(j, 'Ben')?.status, 'sent')
  assertEquals(result(j, 'Cy')?.status, 'sent')
  assertEquals(result(j, 'Dee')?.status, 'skipped', 'a member with no phone is reported as skipped')
  assert(result(j, 'Ava')?.status !== 'sent', 'Ava already had an invite')
  assertEquals(j.skipped, j.results.filter((x: any) => x.status === 'skipped').length, 'skipped count matches results')
  assert(j.skipped >= 1)
})

Deno.test('ST-23 Re-send to one already-invited member sends exactly one invite', async () => {
  const w = world()
  seedText(w.db, 'Ava', { kind: 'invite', status: 'sent', minutesAgo: 300 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.map(s => s.phone), ['+15555550101'])
  assertEquals(w.db.inserted.map(t => [t.member_id, t.kind]), [[memberId('Ava'), 'invite']])
})

Deno.test('ST-24 rate: the 4th text to one member within an hour is refused', async () => {
  const w = world()
  seedText(w.db, 'Ava', { minutesAgo: 30 })
  seedText(w.db, 'Ava', { status: 'failed', minutesAgo: 20 })
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ben', { minutesAgo: 61 + i }) // over an hour ago
  const resend = (label: string) => call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId(label) })

  const third = await resend('Ava')
  assertEquals(third.status, 200, `the 3rd text in the hour is allowed: ${JSON.stringify(third.json)}`)
  assertEquals(w.provider.outbox.length, 1)

  const fourth = await resend('Ava')
  assert4xx(fourth.status)
  assertEquals(fourth.json?.error, 'too many texts, try again in an hour')
  assertEquals(w.provider.outbox.length, 1, 'the 4th must not reach the provider')

  const ben = await resend('Ben')
  assertEquals(ben.status, 200, 'texts older than an hour do not count')
  const cy = await resend('Cy')
  assertEquals(cy.status, 200, 'another member is unaffected')
  assertEquals(w.provider.outbox.length, 3)
})

Deno.test('ST-25 rate (dry run): dry-run rows count toward the hourly limit', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { dry_run: true, minutesAgo: 10 })
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'too many texts, try again in an hour')
  assertEquals(w.db.inserted.length, 0)
})

// =================================================================== reveal
Deno.test('ST-26 reveal locks to sent first; each giver gets their own receiver and own link', async () => {
  const w = world({ status: 'drawn' })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.status(w.C1), 'sent')
  assertEquals(w.provider.outbox.length, 3, 'every member texted once')
  assertEquals(new Set(w.provider.outbox.map(s => s.phone)).size, 3)
  const receiverOf: Record<string, string> = { Ava: 'Ben', Ben: 'Cy', Cy: 'Ava' }
  for (const s of w.provider.outbox) {
    assertEquals(s.circleStatuses[w.C1], 'sent', 'the circle must already be sent when a reveal leaves')
    const giver = w.db.members.find(m => m.phone === s.phone)!
    const receiver = receiverOf[giver.first_name]
    assertMatch(s.message, new RegExp(`you drew ${receiver}!`), `${giver.first_name}'s text`)
    assert(s.message.includes(`/m/#${giver.token}`), `${giver.first_name}'s text must carry their own link`)
    for (const other of w.db.members.filter(m => m.id !== giver.id)) {
      assert(!s.message.includes(other.token), `${giver.first_name}'s text contains ${other.first_name}'s token`)
    }
  }
  assertEquals(w.db.inserted.filter(t => t.kind === 'reveal' && t.status === 'sent').length, 3)
})

Deno.test('ST-27 reveal: a failed send is logged failed and the lock stays', async () => {
  const w = world({ status: 'drawn' })
  w.provider.script = [{ success: false, error: 'Out of quota' }, 'throw']
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(w.db.status(w.C1), 'sent', 'no rollback of the lock')
  assertEquals(w.provider.outbox.length, 3, 'the third member is still texted')
  const failed = w.db.inserted.filter(t => t.status === 'failed')
  const sent = w.db.inserted.filter(t => t.status === 'sent')
  assertEquals(failed.length, 2)
  assertEquals(sent.length, 1)
  for (const t of failed) {
    assert(t.error && t.error.length > 0, 'a failed row records its error')
    assertEquals(t.dry_run, false)
    assertEquals(t.kind, 'reveal')
  }
  assertEquals(r.json?.failed, 2)
  assertEquals(r.json?.sent, 1)
})

Deno.test('ST-28 reveal: if the drawn -> sent lock does not take, nothing is sent', async () => {
  const w = world({ status: 'drawn' })
  w.db.lockTakes = false
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assert4xx(r.status)
  nothingHappened(w, 'lost the lock race')
})

Deno.test('ST-29 reveal: a cap refusal leaves the circle drawn', async () => {
  const w = world({ status: 'drawn' })
  useUpCap(w, 43) // 43 + 3 > 45
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(w, 'reveal over cap')
  assertEquals(w.db.status(w.C1), 'drawn')
})

Deno.test('ST-30 reveal Re-send once sent: that member\'s reveal only', async () => {
  const w = world({ status: 'sent' })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ben') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.length, 1)
  assertEquals(w.provider.outbox[0].phone, '+15555550102')
  assertMatch(w.provider.outbox[0].message, /you drew Cy!/)
  assert(w.provider.outbox[0].message.includes(`/m/#${token('Ben')}`))
  assertEquals(w.db.inserted.map(t => [t.member_id, t.kind]), [[memberId('Ben'), 'reveal']])
})

// ================================================================== dry run
Deno.test('ST-31 empty env is a dry run: nothing reaches the provider; rows carry the body', async () => {
  const w = world()
  const r = await call(w, ENV_EMPTY, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.length, 0, 'a missing TEXTS_DRY_RUN must never call the provider')
  assertEquals(r.json?.dry_run, true)
  assertEquals(r.json?.sent, 3)
  assertEquals(w.db.inserted.length, 3)
  for (const t of w.db.inserted) {
    const m = w.db.members.find(x => x.id === t.member_id)!
    assertEquals(t.dry_run, true)
    assertEquals(t.status, 'sent')
    assertEquals(t.kind, 'invite')
    assertEquals(t.provider_id, null)
    assertEquals(t.quota_remaining, null)
    assert(typeof t.body === 'string' && t.body.startsWith(`Secret Santa! Hi ${m.first_name}, `), `body: ${t.body}`)
    assert(t.body!.endsWith(`/m/#${m.token}`), 'body ends with the member link')
  }
})

Deno.test('ST-31 dry-run body is exactly the message that would have been sent', async () => {
  const { inviteText, memberLink } = await messages()
  const w = world()
  await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite' })
  assertEquals(w.provider.outbox.length, 0)
  for (const t of w.db.inserted) {
    const m = w.db.members.find(x => x.id === t.member_id)!
    assertEquals(t.body, inviteText({ name: m.first_name, circle: "Ava's Crew", link: memberLink(BASE, m.token) }))
  }
})

Deno.test('ST-32 real rows: no body, provider id and quota recorded', async () => {
  const w = world()
  w.provider.script = [{ success: true, textId: 'tb-xyz', quotaRemaining: 37 }]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json?.dry_run, false)
  assertEquals(w.db.inserted.length, 1)
  const t = w.db.inserted[0]
  assertEquals(t.dry_run, false)
  assertEquals(t.body ?? null, null, 'real rows never store the body')
  assertEquals(t.provider_id, 'tb-xyz')
  assertEquals(t.quota_remaining, 37)
  assertEquals(t.status, 'sent')
})

Deno.test('ST-33 real message: E.164 phone, the spec invite text, one GSM-7 segment', async () => {
  const { inviteText, memberLink } = await messages()
  const w = world()
  await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(w.provider.outbox.length, 1)
  const s = w.provider.outbox[0]
  assertEquals(s.phone, '+15555550101')
  assertEquals(s.message, inviteText({ name: 'Ava', circle: "Ava's Crew", link: memberLink(BASE, token('Ava')) }))
  assertMatch(s.message, /^Secret Santa! Hi Ava, add your wish list for Ava's Crew: https:\/\/\S+\/m\/#\S+$/)
  assertMatch(s.message, GSM7, 'GSM-7 only')
  assert(septets(s.message) <= 160, `${septets(s.message)} septets`)
})

Deno.test('ST-34 texts and bodies hold no phone, no other token, no place', async () => {
  const texts: { who: string; text: string }[] = []
  for (const [env, status, kind] of [[ENV_DRY, 'open', 'invite'], [ENV_REAL, 'open', 'invite'], [ENV_DRY, 'drawn', 'reveal'], [ENV_REAL, 'drawn', 'reveal']] as const) {
    const w = world({ status })
    await call(w, env, { circle_id: w.C1, kind })
    for (const s of w.provider.outbox) texts.push({ who: w.db.members.find(m => m.phone === s.phone)!.id, text: s.message })
    for (const t of w.db.inserted) if (t.body) texts.push({ who: t.member_id, text: t.body })
  }
  assert(texts.length >= 12, `expected 12 texts to inspect, got ${texts.length}`)
  const w = world()
  for (const { who, text } of texts) {
    assert(!/\d{7,}/.test(text.replace(/[\s().-]/g, '')), `something phone-like in: ${text}`)
    for (const m of w.db.members) {
      if (m.phone) assert(!text.includes(m.phone.slice(2)), `${m.first_name}'s phone in: ${text}`)
      if (m.id !== who) assert(!text.includes(m.token), `${m.first_name}'s token in a text to someone else: ${text}`)
    }
    assert(!text.includes('Nonna'), `the swap place is not an allowed field: ${text}`)
  }
})

// ============================================================ more safety
Deno.test('ST-35 junk TEXTS_DRY_RUN stays dry run even with links approved', async () => {
  for (const v of ['yes', 'FALSE', '0', 'off', '']) {
    const w = world()
    const r = await call(w, { ELF_USER_IDS: ALLOW, TEXTS_DRY_RUN: v, TEXT_LINKS_APPROVED: 'true', APP_BASE_URL: BASE }, { circle_id: w.C1, kind: 'invite' })
    assertEquals(r.status, 200, `TEXTS_DRY_RUN=${JSON.stringify(v)}: ${JSON.stringify(r.json)}`)
    assertEquals(w.provider.outbox.length, 0, `TEXTS_DRY_RUN=${JSON.stringify(v)} must never reach the provider`)
    assertEquals(r.json?.dry_run, true)
    assert(w.db.inserted.every(t => t.dry_run === true), 'every row is a dry-run row')
  }
})

Deno.test('ST-36 Send invites with nobody left to invite: 200, sent 0, nothing sent', async () => {
  const w = world()
  for (const l of ['Ava', 'Ben', 'Cy']) seedText(w.db, l, { minutesAgo: 300 })
  useUpCap(w) // an empty batch always fits (BUD-04)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json?.sent, 0)
  nothingHappened(w, 'nobody to invite')
})

Deno.test('ST-37 reveal: a member with no phone is skipped and reported, the rest are texted', async () => {
  const w = world({ status: 'drawn', extra: [{ label: 'Dee', phone: null }] })
  w.db.matches = w.db.matches.filter(m => m.giver_id !== memberId('Cy'))
  w.db.matches.push({ circle_id: w.C1, giver_id: memberId('Cy'), receiver_id: memberId('Dee') })
  w.db.matches.push({ circle_id: w.C1, giver_id: memberId('Dee'), receiver_id: memberId('Ava') })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.status(w.C1), 'sent')
  assertEquals(w.provider.outbox.length, 3)
  assertEquals(result(r.json, 'Dee')?.status, 'skipped')
  assertEquals(r.json?.skipped, 1)
})

Deno.test('ST-38 batch: a rate-limited member is skipped and reported; the others are texted', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { status: 'failed', minutesAgo: 10 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.map(s => s.phone).sort(), ['+15555550102', '+15555550103'])
  assertEquals(result(r.json, 'Ava')?.status, 'skipped')
  assertMatch(result(r.json, 'Ava')?.error ?? '', /too many texts/)
})

Deno.test('ST-39 invites are refused once the names are sent (Re-send then means the reveal)', async () => {
  for (const body of [{ kind: 'invite' }, { kind: 'invite', member_id: memberId('Ava') }]) {
    const w = world({ status: 'sent' })
    const r = await call(w, ENV_REAL, { circle_id: w.C1, ...body })
    assert4xx(r.status, JSON.stringify(body))
    nothingHappened(w, `invite while sent ${JSON.stringify(body)}`)
  }
})

Deno.test('ST-40 only index.ts touches Deno.env, fetch, supabase-js or Textbelt', async () => {
  for (const file of ['./handler.ts', './core.ts', '../_shared/messages.js']) {
    let src = ''
    try { src = await Deno.readTextFile(new URL(file, import.meta.url)) } catch { throw new Error(`${file} isn't built yet`) }
    assert(!/Deno\.env/.test(src), `${file} reads Deno.env`)
    assert(!/\bfetch\s*\(/.test(src), `${file} calls fetch`)
    assert(!/textbelt\.com/i.test(src), `${file} names textbelt.com`)
    assert(!/createClient|supabase-js/.test(src), `${file} creates a supabase client`)
  }
})

// ============================================ 2026-10-24: Joe's decisions + S1-S4
// Spec: "Texting details -> Decisions from Joe (2026-10-24)" 1-4 and 6, and
// "Security hardening (from the audit, 2026-10-24)" S1-S4. Contract: the
// db.getBudget / claimTexts / finishText / recordQuota and provider.configured
// rows of "Interface the tests assume" in tests/SCENARIOS.md.

const pending = (w: ReturnType<typeof world>) => w.db.texts.filter(t => t.status === 'pending')

Deno.test('ST-41 claim before provider: credits and pending rows exist when the first text goes', async () => {
  const w = world()
  w.db.used = 10
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.length, 3)
  const first = w.provider.outbox[0]
  assertEquals(first.usedAtSend, 13, 'the whole batch (3) is claimed in the database before the first provider call')
  assertEquals(first.pendingAtSend.slice().sort(), [memberId('Ava'), memberId('Ben'), memberId('Cy')].sort(),
    'every member in the batch has a pending row before the first provider call')
  assertEquals(w.db.used, 13, 'the counter ends at 13: 3 real texts')
})

Deno.test('ST-42 a refused claim means zero provider calls and "text budget used up"', async () => {
  // The read-only pre-check sees room (used 40 of 45); another request claims
  // 4 credits before ours does, so our claim of 3 is refused in the database.
  const w = world()
  w.db.used = 40
  w.db.raceUsed = 4
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(w, 'claim refused')
  assertEquals(w.db.used, 44, 'nothing of ours is counted')
})

Deno.test('ST-43 a refused claim on Send the names leaves the circle drawn', async () => {
  const w = world({ status: 'drawn' })
  w.db.used = 42
  w.db.raceUsed = 1
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'text budget used up')
  nothingHappened(w, 'reveal claim refused')
  assertEquals(w.db.status(w.C1), 'drawn', 'the draw is not locked when nothing can be sent')
})

Deno.test('ST-44 a provider call followed by a failed log write still leaves the credit counted', async () => {
  const w = world()
  w.db.used = 20
  w.db.failFinish = true
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(w.provider.outbox.length, 1, 'the text went out')
  assert(r.status >= 400, `a failed log write is reported as an error, got ${r.status}`)
  assertEquals(w.db.used, 21, 'the credit was claimed before the provider call and stays counted')
  assert(w.db.texts.some(t => t.member_id === memberId('Ava') && t.status === 'pending' && !t.dry_run),
    'the claimed row is left pending (fail closed), never deleted')

  // That pending row keeps protecting Ava: the next Send invites skips her.
  w.db.failFinish = false
  const before = w.provider.outbox.length
  const next = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(next.status, 200, JSON.stringify(next.json))
  assertEquals(w.provider.outbox.slice(before).map(s => s.phone).sort(), ['+15555550102', '+15555550103'],
    'Ava, whose send may have gone, is not texted again')
})

Deno.test('ST-45 no row is left pending after a request that finishes', async () => {
  // Plain batch, a failed provider call, a mid-batch reserve stop, and a dry run.
  const plain = world()
  await call(plain, ENV_REAL, { circle_id: plain.C1, kind: 'invite' })
  const failing = world()
  failing.provider.script = [{ success: false, error: 'carrier said no' }, 'throw']
  await call(failing, ENV_REAL, { circle_id: failing.C1, kind: 'invite' })
  const reserve = world({ extra: [{ label: 'Dee', phone: '+15555550104' }] })
  reserve.provider.script = [{ success: true, textId: 'tb-1', quotaRemaining: 5 }]
  await call(reserve, ENV_REAL, { circle_id: reserve.C1, kind: 'invite' })
  const dry = world()
  await call(dry, ENV_DRY, { circle_id: dry.C1, kind: 'invite' })
  for (const [name, w] of [['plain', plain], ['failing', failing], ['reserve stop', reserve], ['dry run', dry]] as const) {
    assertEquals(pending(w).length, 0, `${name}: every pending row is finished as sent or failed`)
  }
  assertEquals(reserve.provider.outbox.length, 1, 'reserve stop: nothing more went after quotaRemaining 5')
})

Deno.test('ST-46 the quota Textbelt reports is recorded in the database', async () => {
  const w = world()
  w.provider.script = [{ success: true, textId: 'tb-1', quotaRemaining: 37 }]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite', member_id: memberId('Ava') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.lastQuota, 37)
})

Deno.test('ST-47 dry runs never touch the credit counter, even at the cap (Decision 2)', async () => {
  const w = world()
  useUpCap(w)
  const usedBefore = w.db.used
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, `a dry run at the cap still runs: ${JSON.stringify(r.json)}`)
  assertEquals(w.provider.outbox.length, 0)
  assertEquals(w.db.inserted.filter(t => t.dry_run && t.status === 'sent').length, 3)
  assertEquals(w.db.used, usedBefore, 'used is unchanged')
})

Deno.test('ST-48 a dry-run invite does not count as invited: the first real Send invites texts everyone (Decision 1)', async () => {
  const w = world()
  for (const l of ['Ava', 'Ben', 'Cy']) seedText(w.db, l, { dry_run: true, minutesAgo: 90 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.map(s => s.phone).sort(), ['+15555550101', '+15555550102', '+15555550103'])
})

Deno.test('ST-49 a dry-run batch skips a member rate-limited by dry-run rows; the rest still go (Decisions 2, 3)', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) seedText(w.db, 'Ava', { dry_run: true, minutesAgo: 10 })
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(result(r.json, 'Ava')?.status, 'skipped')
  assertMatch(result(r.json, 'Ava')?.error ?? '', /too many texts/)
  assertEquals(w.db.inserted.filter(t => t.status === 'sent').map(t => t.member_id).sort(),
    [memberId('Ben'), memberId('Cy')].sort())
  assertEquals([r.json?.sent, r.json?.skipped], [2, 1])
})

Deno.test('ST-50 the reveal wording is exactly as Joe approved (Decision 4)', async () => {
  const w = world({ status: 'drawn', budget: 20, swap_date: '2026-12-19' })
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reveal' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  const body = w.db.inserted.find(t => t.member_id === memberId('Ava'))?.body
  assertEquals(body, `Secret Santa! Ava, you drew Ben! $20, Dec 19. Their list: ${BASE}/m/#${token('Ava')}`)
})

// ------------------------------------------------------------ S2 allow-list
Deno.test('ST-51 a signed-in user not on ELF_USER_IDS gets "circle not found", before any database use', async () => {
  for (const kind of ['invite', 'reveal']) {
    const w = world({ status: kind === 'reveal' ? 'drawn' : 'open' })
    w.db.poisoned = true
    const r = await call(w, ENV_REAL, { circle_id: w.C1, kind }, { auth: JWT_C })
    assertEquals(r.status, 404, `${kind}: ${JSON.stringify(r.json)}`)
    assertEquals(r.json?.error, 'circle not found')
    w.db.poisoned = false
    nothingHappened(w, `stranger ${kind}`)
  }
})

Deno.test('ST-52 a missing or empty ELF_USER_IDS lets nobody in (fail closed)', async () => {
  for (const list of [undefined, '', ' , ']) {
    const w = world()
    const env: Record<string, string> = { ...ENV_DRY }
    if (list === undefined) delete env.ELF_USER_IDS
    else env.ELF_USER_IDS = list
    const r = await call(w, env, { circle_id: w.C1, kind: 'invite' })
    assertEquals(r.status, 404, `ELF_USER_IDS=${JSON.stringify(list)}`)
    assertEquals(r.json?.error, 'circle not found')
    nothingHappened(w, `allow-list ${JSON.stringify(list)}`)
  }
})

Deno.test('ST-53 ELF_USER_IDS is a comma-separated list; spaces around ids are ignored', async () => {
  const w = world()
  const r = await call(w, { ...ENV_DRY, ELF_USER_IDS: ` ${'00000000-0000-4000-8000-0000000000ff'} , ${w.db.circles.get(w.C1)!.elf_id} ` },
    { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.inserted.length, 3)
})

// ------------------------------------------------------------ S4 not set up
Deno.test('ST-54 "texting is not set up yet" (503) comes only after auth and the allow-list', async () => {
  const mk = () => { const w = world(); w.provider.configured = false; return w }
  const anon = mk()
  const a = await call(anon, ENV_REAL, { circle_id: anon.C1, kind: 'invite' }, { auth: null })
  assertEquals(a.status, 401, `no JWT: sign in first, not 503 (${JSON.stringify(a.json)})`)
  const stranger = mk()
  const s = await call(stranger, ENV_REAL, { circle_id: stranger.C1, kind: 'invite' }, { auth: JWT_C })
  assertEquals([s.status, s.json?.error], [404, 'circle not found'], 'not on the allow-list: circle not found, not 503')
  const elf = mk()
  const e = await call(elf, ENV_REAL, { circle_id: elf.C1, kind: 'invite' })
  assertEquals([e.status, e.json?.error], [503, 'texting is not set up yet'])
  nothingHappened(elf, 'not set up')
  assertEquals(elf.db.used, 0, 'no credit claimed')
})

Deno.test('ST-55 dry run needs no Textbelt key', async () => {
  const w = world()
  w.provider.configured = false
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'invite' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.db.inserted.length, 3)
})

Deno.test('ST-56 index.ts passes ELF_USER_IDS to the handler and no longer answers 503 before auth', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(/ELF_USER_IDS/.test(src), 'index.ts must read ELF_USER_IDS and hand it to the handler')
  assert(!/texting is not set up/.test(src), 'the not-set-up refusal belongs in handler.ts, after auth (spec S4)')
})
