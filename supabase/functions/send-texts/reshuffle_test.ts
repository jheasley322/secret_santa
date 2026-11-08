// ST-57..86: send-texts for kind 'reshuffle' (handler.ts with injected fakes).
// Spec: "Re-shuffle after the names are sent", the kind: 'reshuffle' bullet under
// "Texting", "HARD LIMITS". Scenario IDs are in tests/SCENARIOS.md.
//
// SAFETY: the provider is always FakeProvider (records, never sends) and the
// suite runs with --deny-net. "Real mode" means TEXTS_DRY_RUN=false against the
// fake. Assertions are on outcomes: HTTP status, response JSON, rows the fake db
// ends up holding, circle status, matches, and what the fake provider received.

// deno-lint-ignore-file no-explicit-any
import { assert, assert4xx, assertEquals } from './test_assert.ts'
import {
  BASE, ENV_DRY, ENV_EMPTY, ENV_REAL, ENV_REAL_NO_LINKS, JWT_B, JWT_C,
  call, memberId, seedText, token, world
} from './test_fakes.ts'

type W = ReturnType<typeof world>

const IMPOSSIBLE = "Can't make a draw with these do-not-pair rules. Try removing one."
const RATE = 'too many texts, try again in an hour'
const link = (label: string) => `${BASE}/m/#${token(label)}`
const newText = (name: string, receiver: string) =>
  `Secret Santa! Names were reshuffled. ${name}, you now drew ${receiver}! $20, Dec 19. Their list: ${link(name)}`

/** The world's C1 is Ava -> Ben -> Cy -> Ava; the fake's new draw is the inverse. */
const sent = () => world({ status: 'sent' })
const before = (w: W) => JSON.stringify(w.db.matches)

function result (json: any, label: string) {
  return (json?.results ?? []).find((r: any) => r.member_id === memberId(label))
}

function unchanged (w: W, draw: string, what: string) {
  assertEquals(w.provider.outbox.length, 0, `${what}: the provider must not be called`)
  assertEquals(w.db.inserted.length, 0, `${what}: no texts row may be written`)
  assertEquals(JSON.stringify(w.db.matches), draw, `${what}: the matches must not change`)
}

/** spec "Honest failures": what the Elf must be told once the new draw exists. */
function honest (r: { status: number; json: any }, what: string) {
  assert(r.status >= 400, `${what}: kids were missed, so the response must be an error, got ${r.status}`)
  const msg = String(r.json?.error ?? '')
  assert(msg.includes('use Re-send or Copy link'), `${what}: must say "use Re-send or Copy link", got: ${msg}`)
  assert(/new draw/i.test(msg), `${what}: must say the new draw exists, got: ${msg}`)
  assert(/some kids may not/i.test(msg), `${what}: must say some kids may not have been told, got: ${msg}`)
  assert(!/nothing was (sent|changed)|nothing changed/i.test(msg), `${what}: must not claim nothing happened, got: ${msg}`)
}

function noPending (w: W) {
  assertEquals(w.db.texts.filter(t => t.status === 'pending').length, 0, 'no row may be left pending')
}

Deno.test('ST-57 kind reshuffle is accepted, and its rows are kind reshuffle', async () => {
  const w = sent()
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.sent, 3)
  assertEquals(w.db.inserted.map(t => t.kind), ['reshuffle', 'reshuffle', 'reshuffle'])
  assertEquals(w.db.inserted.map(t => t.status), ['sent', 'sent', 'sent'])
  assertEquals(w.db.status(w.C1), 'sent', 'the circle stays sent')
})

Deno.test('ST-58 a member_id is a bad request, even a real one in this circle', async () => {
  const w = sent()
  const draw = before(w)
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle', member_id: memberId('Ava') })
  assertEquals(r.status, 400)
  assertEquals(r.json?.error, 'bad request')
  unchanged(w, draw, 'member_id')
})

for (const status of ['open', 'drawn']) {
  Deno.test(`ST-59 a ${status} circle is refused: names have not been sent yet`, async () => {
    const w = world({ status })
    const draw = before(w)
    const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle' })
    assertEquals(r.status, 409, JSON.stringify(r.json))
    assertEquals(r.json?.error, 'names have not been sent yet')
    unchanged(w, draw, status)
    assertEquals(w.db.status(w.C1), status, 'status unchanged')
  })
}

Deno.test('ST-60 a non-owner, a stranger and no JWT are refused with nothing changed', async () => {
  for (const auth of [JWT_B, JWT_C]) {
    const w = sent()
    const draw = before(w)
    const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' }, { auth })
    assert4xx(r.status)
    assertEquals(r.json?.error, 'circle not found')
    unchanged(w, draw, auth)
  }
  const w = sent()
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' }, { auth: null })
  assert4xx(r.status)
  unchanged(w, draw, 'no JWT')
})

Deno.test('ST-61 messages use the new matches read after the claim, in the exact spec wording', async () => {
  const w = sent()
  await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  const got = Object.fromEntries(w.provider.outbox.map(s => [s.phone, s.message]))
  assertEquals(got['+15555550101'], newText('Ava', 'Cy'))
  assertEquals(got['+15555550102'], newText('Ben', 'Ava'))
  assertEquals(got['+15555550103'], newText('Cy', 'Ben'))
})

Deno.test('ST-61 a scripted new draw is what the kids are told', async () => {
  const w = world({ status: 'sent', extra: [{ label: 'Dee', phone: '+15555550104' }] })
  w.db.matches = w.db.matches.filter(x => x.circle_id !== w.C1)
  for (const [g, r] of [['Ava', 'Ben'], ['Ben', 'Cy'], ['Cy', 'Dee'], ['Dee', 'Ava']]) {
    w.db.matches.push({ circle_id: w.C1, giver_id: memberId(g), receiver_id: memberId(r) })
  }
  w.db.nextDraw = [['Ava', 'Dee'], ['Dee', 'Cy'], ['Cy', 'Ben'], ['Ben', 'Ava']]
  await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  const got = Object.fromEntries(w.provider.outbox.map(s => [s.phone, s.message]))
  assertEquals(got['+15555550101'], newText('Ava', 'Dee'))
  assertEquals(got['+15555550104'], newText('Dee', 'Cy'))
})

Deno.test('ST-62 dry run: nothing sent, the exact new message logged, no credits, even at the cap', async () => {
  const w = sent()
  w.db.used = w.db.cap
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.dry_run, true)
  assertEquals(w.provider.outbox.length, 0, 'a dry run never reaches the provider')
  assertEquals(w.db.used, w.db.cap, 'no credits spent')
  const body = (label: string) => w.db.inserted.find(t => t.member_id === memberId(label))?.body
  assertEquals(body('Ava'), newText('Ava', 'Cy'))
  assertEquals(body('Ben'), newText('Ben', 'Ava'))
  assertEquals(body('Cy'), newText('Cy', 'Ben'))
  assert(w.db.inserted.every(t => t.dry_run), 'every row is a dry-run row')
  noPending(w)
})

Deno.test('ST-63 an empty env is a dry run: the provider is never called', async () => {
  const w = sent()
  const r = await call(w, ENV_EMPTY, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.dry_run, true)
  assertEquals(w.provider.outbox.length, 0)
})

Deno.test('ST-64 real mode: one text per kid, rows sent, credits claimed before the first text', async () => {
  const w = sent()
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.sent, 3)
  assertEquals(r.json.dry_run, false)
  assertEquals(w.provider.outbox.length, 3)
  assertEquals(w.provider.outbox[0].usedAtSend, 3, 'all 3 credits are claimed before the first text')
  assertEquals(w.provider.outbox[0].pendingAtSend.length, 3, 'all 3 rows are pending at the first text')
  assertEquals(w.db.used, 3)
  assert(w.db.inserted.every(t => t.status === 'sent' && !t.dry_run && t.body === null), 'real rows are sent, with no body')
  noPending(w)
})

Deno.test('ST-65 an impossible draw: the message verbatim, no text, matches unchanged', async () => {
  const w = sent()
  w.db.drawImpossible = true
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assert4xx(r.status)
  assertEquals(r.json?.error, IMPOSSIBLE)
  unchanged(w, draw, 'impossible')
})

Deno.test('ST-66 over the cap: 403, no text, matches unchanged', async () => {
  const w = sent()
  w.db.used = w.db.cap - 2
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 403, JSON.stringify(r.json))
  assertEquals(r.json?.error, 'text budget used up')
  unchanged(w, draw, 'cap')
})

Deno.test('ST-66 a claim that loses the cap race: 403, no text, matches unchanged', async () => {
  const w = sent()
  w.db.used = w.db.cap - 3
  w.db.raceUsed = 1 // another request spends a credit between the pre-check and the claim
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 403, JSON.stringify(r.json))
  assertEquals(r.json?.error, 'text budget used up')
  unchanged(w, draw, 'race')
})

Deno.test('ST-67 one kid at the hourly limit: nobody is texted and matches are unchanged', async () => {
  for (const env of [ENV_REAL, ENV_DRY]) {
    const w = sent()
    for (let i = 0; i < 3; i++) seedText(w.db, 'Ben', { minutesAgo: 10 + i, dry_run: true })
    const draw = before(w)
    const r = await call(w, env, { circle_id: w.C1, kind: 'reshuffle' })
    assert4xx(r.status)
    assertEquals(r.json?.error, RATE)
    unchanged(w, draw, 'rate limit')
    assertEquals(w.db.used, 0, 'no credits spent')
  }
})

Deno.test('ST-68 the claim finds the circle no longer sent: 409 and no text', async () => {
  const w = sent()
  w.db.claimSeesNotSent = true
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 409, JSON.stringify(r.json))
  assertEquals(r.json?.error, 'names have not been sent yet')
  unchanged(w, draw, 'race')
})

Deno.test('ST-69 no provider key, or links not approved: refused before anyone is re-matched', async () => {
  const w = sent()
  w.provider.configured = false
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 503)
  assertEquals(r.json?.error, 'texting is not set up yet')
  unchanged(w, draw, 'no key')

  const w2 = sent()
  const draw2 = before(w2)
  const r2 = await call(w2, ENV_REAL_NO_LINKS, { circle_id: w2.C1, kind: 'reshuffle' })
  assertEquals(r2.status, 403)
  assertEquals(r2.json?.error, 'links not approved yet')
  unchanged(w2, draw2, 'links gate')
})

Deno.test('ST-70 a phoneless kid is re-matched, skipped and reported; the others are texted', async () => {
  const w = world({ status: 'sent', extra: [{ label: 'Dee', phone: null }] })
  w.db.matches = w.db.matches.filter(x => x.circle_id !== w.C1)
  for (const [g, r] of [['Ava', 'Ben'], ['Ben', 'Cy'], ['Cy', 'Dee'], ['Dee', 'Ava']]) {
    w.db.matches.push({ circle_id: w.C1, giver_id: memberId(g), receiver_id: memberId(r) })
  }
  w.db.nextDraw = [['Ava', 'Dee'], ['Dee', 'Cy'], ['Cy', 'Ben'], ['Ben', 'Ava']]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.sent, 3)
  assertEquals(r.json.skipped, 1)
  assertEquals(result(r.json, 'Dee')?.status, 'skipped')
  assertEquals(result(r.json, 'Dee')?.error, 'no phone number')
  assertEquals(w.db.matches.find(x => x.giver_id === memberId('Dee'))?.receiver_id, memberId('Cy'), 'Dee is re-matched')
  assertEquals(w.provider.outbox.length, 3)
  assertEquals(w.db.used, 3, 'no credit for Dee')
})

Deno.test('ST-71 a provider failure or error is logged failed; the other kids still go', async () => {
  const w = sent()
  w.provider.script = [{ success: false, error: 'carrier rejected' }, 'throw', { success: true, textId: 'tb-3', quotaRemaining: 40 }]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(r.json.failed, 2)
  assertEquals(r.json.sent, 1)
  assertEquals(w.provider.outbox.length, 3, 'every kid was attempted')
  assertEquals(w.db.inserted.filter(t => t.status === 'failed').length, 2)
  assert(w.db.inserted.filter(t => t.status === 'failed').every(t => t.error), 'each failed row has its error')
  assertEquals(w.db.status(w.C1), 'sent')
  assertEquals(w.db.used, 3, 'a failed send stays counted')
  noPending(w)
})

Deno.test('ST-72 a failed log write stops the batch and tells the Elf the truth', async () => {
  const w = sent()
  w.db.failFinish = true
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  honest(r, 'log write')
  assertEquals(w.provider.outbox.length, 1, 'nothing more is sent after a failed log write')
  assertEquals(w.db.used, 3, 'the claimed credits stay counted')
})

Deno.test('ST-73 reserve reached mid-batch: nothing more goes out, the rest end failed, and the Elf is told', async () => {
  const w = sent()
  w.provider.script = [{ success: true, textId: 'tb-1', quotaRemaining: 5 }]
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  honest(r, 'reserve')
  assertEquals(w.provider.outbox.length, 1)
  assertEquals(w.db.inserted.filter(t => t.status === 'sent').length, 1)
  assertEquals(w.db.inserted.filter(t => t.status === 'failed' && t.error === 'text budget used up').length, 2)
  noPending(w)
})

Deno.test('ST-74 messages come from the claim: a re-shuffle needs no read of the matches', async () => {
  const w = sent()
  w.db.failMatches = true
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  const got = Object.fromEntries(w.provider.outbox.map(s => [s.phone, s.message]))
  assertEquals(got['+15555550101'], newText('Ava', 'Cy'))
  assertEquals(got['+15555550102'], newText('Ben', 'Ava'))
  assertEquals(got['+15555550103'], newText('Cy', 'Ben'))
  noPending(w)
})

Deno.test('ST-75 Re-send after a re-shuffle uses the normal "you drew" text with the new match', async () => {
  const w = sent()
  await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle' })
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ava') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  const row = w.db.inserted.filter(t => t.member_id === memberId('Ava') && t.kind === 'reveal')
  assertEquals(row.length, 1)
  assertEquals(row[0].body, `Secret Santa! Ava, you drew Cy! $20, Dec 19. Their list: ${link('Ava')}`)
})

Deno.test('ST-76 index.ts calls claim_reshuffle with the spec\'s named arguments', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  const at = src.indexOf("'claim_reshuffle'")
  assert(at >= 0, "index.ts must call rpc('claim_reshuffle')")
  const call = src.slice(at, at + 200)
  for (const arg of ['p_circle_id', 'p_member_ids', 'p_dry_run']) {
    assert(call.includes(arg), `the call must pass ${arg}`)
  }
})

Deno.test('ST-77 a failed log write in a dry run is honest too', async () => {
  const w = sent()
  w.db.failFinish = true
  honest(await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reshuffle' }), 'dry-run log write')
  assertEquals(w.provider.outbox.length, 0)
})

Deno.test('ST-78 an unexpected throw after the claim is honest', async () => {
  const w = sent()
  w.db.claimResultThrows = true
  honest(await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' }), 'unexpected throw')
})

Deno.test('ST-79 a claimed text that names an unknown receiver stops the batch, honestly', async () => {
  const w = sent()
  w.db.claimReceiverUnknown = true
  honest(await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' }), 'unknown receiver')
  assert(!w.provider.outbox.some(s => /undefined|null|your match/.test(s.message)), 'no text may name a made-up receiver')
  assert(w.provider.outbox.every(s => s.message.startsWith('Secret Santa! Names were reshuffled.')), `only re-shuffle texts may go out: ${JSON.stringify(w.provider.outbox.map(s => s.message))}`)
  noPending(w)
})

Deno.test('ST-80 a pending text refuses a re-shuffle: a send is already in progress', async () => {
  const w = sent()
  seedText(w.db, 'Ben', { kind: 'reveal', status: 'pending', minutesAgo: 1 })
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'a send is already in progress')
  unchanged(w, draw, 'in progress')
})

Deno.test('ST-81 a stale pending row does not refuse a re-shuffle', async () => {
  const w = sent()
  seedText(w.db, 'Ben', { kind: 'reveal', status: 'pending', minutesAgo: 11 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  assertEquals(w.provider.outbox.length, 3)
})

Deno.test('ST-82 a Re-send is refused while a re-shuffle is pending', async () => {
  const w = sent()
  seedText(w.db, 'Ben', { kind: 'reshuffle', status: 'pending', minutesAgo: 1 })
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ava') })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'a send is already in progress')
  assertEquals(w.provider.outbox.length, 0)
  assertEquals(w.db.inserted.length, 0)
})

Deno.test('ST-83 a Re-send names the match read after its claim', async () => {
  const w = sent()
  w.db.drawDuringClaim = [['Ava', 'Cy'], ['Ben', 'Ava'], ['Cy', 'Ben']]
  const r = await call(w, ENV_DRY, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ava') })
  assertEquals(r.status, 200, JSON.stringify(r.json))
  const row = w.db.inserted.find(t => t.kind === 'reveal')
  assertEquals(row?.body, `Secret Santa! Ava, you drew Cy! $20, Dec 19. Their list: ${link('Ava')}`)
})

Deno.test('ST-84 a Re-send whose match cannot be read after the claim texts nobody and leaves no row pending', async () => {
  const w = sent()
  w.db.drawDuringClaim = [['Ben', 'Ava'], ['Cy', 'Ben']] // Ava has no match once the claim is done
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reveal', member_id: memberId('Ava') })
  assertEquals(w.provider.outbox.length, 0, 'a kid is never texted a stale name')
  assert(r.status >= 400 || r.json?.skipped === 1 || r.json?.failed === 1, `the Elf must hear about it: ${JSON.stringify(r.json)}`)
  noPending(w)
})

Deno.test('ST-85 nobody has a phone: refused with nobody can be texted, matches unchanged', async () => {
  const w = sent()
  for (const m of w.db.members) if (m.circle_id === w.C1) m.phone = null
  const draw = before(w)
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assert4xx(r.status)
  assertEquals(r.json?.error, 'nobody can be texted')
  unchanged(w, draw, 'no phones')
})

Deno.test('ST-86 a refused claim does not get the "new draw exists" message', async () => {
  const w = sent()
  w.db.drawImpossible = true
  const r = await call(w, ENV_REAL, { circle_id: w.C1, kind: 'reshuffle' })
  assert(!String(r.json?.error).includes('use Re-send or Copy link'), 'no new draw exists, so the Elf must not be told one does')
})
