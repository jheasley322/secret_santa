// Test doubles for the send-texts Deno tests. Not a test file itself, and never
// imported by index.ts, so it is never deployed.
//
// SAFETY: nothing here can send a text. FakeProvider only records what it was
// handed. The suite also runs with --deny-net, so even a real fetch would fail.
//
// The fakes model the contract in tests/SCENARIOS.md ("Interface the tests
// assume"). Tests assert on what these fakes end up holding (rows, statuses,
// the provider's outbox), not on which methods were called.

// deno-lint-ignore-file no-explicit-any

export const BASE = 'https://jheasley322.github.io/secret_santa'
export const ELF_A = '00000000-0000-4000-8000-0000000000a1'
export const ELF_B = '00000000-0000-4000-8000-0000000000b2'
export const JWT_A = 'Bearer jwt-for-elf-a'
export const JWT_B = 'Bearer jwt-for-elf-b'
/** A real, signed-in Supabase user who is NOT on the ELF_USER_IDS allow-list (spec S2). */
export const ELF_C = '00000000-0000-4000-8000-0000000000c3'
export const JWT_C = 'Bearer jwt-for-stranger-c'
/** spec "Security hardening" S2: the Edge secret listing the approved Elves. */
export const ALLOW = `${ELF_A},${ELF_B}`

/** Environments. Real mode is only ever paired with FakeProvider. */
// Every environment carries the S2 allow-list, so the older tests keep their
// intent. ENV_EMPTY means "no texting settings at all" (only the allow-list).
export const ENV_EMPTY: Record<string, string> = { ELF_USER_IDS: ALLOW }
export const ENV_DRY: Record<string, string> = { ELF_USER_IDS: ALLOW, TEXTS_DRY_RUN: 'true', APP_BASE_URL: BASE }
export const ENV_REAL: Record<string, string> = { ELF_USER_IDS: ALLOW, TEXTS_DRY_RUN: 'false', TEXT_LINKS_APPROVED: 'true', APP_BASE_URL: BASE }
export const ENV_REAL_NO_LINKS: Record<string, string> = { ELF_USER_IDS: ALLOW, TEXTS_DRY_RUN: 'false', APP_BASE_URL: BASE }

/** Load a module under test. A missing module fails the test that needs it. */
export async function load (rel: string): Promise<any> {
  const url = new URL(rel, import.meta.url).href
  try {
    return await import(url)
  } catch (err) {
    throw new Error(`${rel} isn't built yet, or fails to load: ${(err as Error).message}`)
  }
}

export function token (label: string): string {
  // 16 chars (spec "Shorter links": 12 random bytes, base64url), unique per
  // label and never a prefix of another.
  return (`T${label}_` + 'k'.repeat(16)).slice(0, 16)
}
export function memberId (label: string): string {
  const hex = [...label].map(c => c.charCodeAt(0).toString(16)).join('').padEnd(12, '0').slice(0, 12)
  return `11111111-1111-4111-8111-${hex}`
}
export function circleId (label: string): string {
  const hex = [...label].map(c => c.charCodeAt(0).toString(16)).join('').padEnd(12, '0').slice(0, 12)
  return `22222222-2222-4222-8222-${hex}`
}

export interface Circle { id: string; elf_id: string; name: string; budget: number | null; swap_date: string | null; swap_place: string | null; status: string }
export interface Member { id: string; circle_id: string; first_name: string; phone: string | null; token: string }
export interface TextRow {
  id: string; member_id: string; kind: string; status: string; provider_id: string | null; error: string | null
  dry_run: boolean; quota_remaining: number | null; body: string | null; created_at: string
}

export class FakeDb {
  circles = new Map<string, Circle>()
  members: Member[] = []
  matches: { circle_id: string; giver_id: string; receiver_id: string }[] = []
  texts: TextRow[] = []
  /** Rows written by the handler during the test (seeded rows excluded). */
  inserted: TextRow[] = []
  cap = 45
  /**
   * spec "Security hardening" S1: private.text_budget.used, the lifetime count
   * of claimed real texts. Never decreases. seedText() bumps it for every real
   * row it seeds, because every real row was claimed first.
   */
  used = 0
  /** private.text_budget.last_quota: the latest Textbelt quotaRemaining. */
  lastQuota: number | null = null
  /** Credits another request claims between our read-only pre-check and our claim (a race). */
  raceUsed = 0
  /** Set true to make every finishText() fail (the log write after a provider call). */
  failFinish = false
  /** Set true to make EVERY db method throw: proves a refusal needed no database. */
  poisoned = false
  /** Set false to simulate another request having already locked the circle. */
  lockTakes = true
  private seq = 0

  private touch () {
    if (this.poisoned) throw new Error('the database was used')
  }

  async getCircle (id: string) {
    this.touch()
    const c = this.circles.get(id)
    return c ? { ...c } : null
  }
  async getMembers (cid: string) {
    this.touch()
    return this.members.filter(m => m.circle_id === cid).map(m => ({ ...m }))
  }
  async getMatches (cid: string) {
    this.touch()
    return this.matches.filter(m => m.circle_id === cid).map(m => ({ giver_id: m.giver_id, receiver_id: m.receiver_id }))
  }
  async getTexts () {
    this.touch()
    return this.texts.map(t => ({ ...t }))
  }
  async getCap () {
    this.touch()
    return this.cap
  }
  async insertText (row: any) {
    this.touch()
    const full: TextRow = {
      id: crypto.randomUUID(),
      provider_id: null,
      error: null,
      quota_remaining: null,
      body: null,
      // Strictly increasing, so "the latest row" is never a tie.
      created_at: new Date(Date.now() + this.seq++).toISOString(),
      ...row
    }
    this.texts.push(full)
    this.inserted.push(full)
  }
  /**
   * Since 2026-10-24 claimTexts (= claim_texts) does the drawn -> sent move.
   * This only confirms the circle is now sent, before the first reveal leaves.
   */
  async lockCircleSent (id: string) {
    this.touch()
    const c = this.circles.get(id)
    return this.lockTakes && c?.status === 'sent'
  }

  /** public.text_budget via service role: read-only, for the ordered pre-check. */
  async getBudget () {
    this.touch()
    return { cap: this.cap, used: this.used, last_quota: this.lastQuota }
  }

  /**
   * public.claim_texts (spec S1 + S3), modelled on the SQL contract in
   * tests/SCENARIOS.md: under the circle lock, re-filter (duplicate real
   * invites unless resend; 3 texts per member per hour), claim credits for the
   * survivors (real sends only), write their `pending` rows. A whole-circle
   * reveal also moves drawn -> sent here, after the credit check, so a losing
   * concurrent reveal claims nothing (lead decision 2026-10-24). lockTakes =
   * false simulates another request having already done that move.
   */
  async claimTexts (a: { circle_id: string; kind: string; member_ids: string[]; dry_run: boolean; resend?: boolean }) {
    this.touch()
    if (this.raceUsed) { this.used += this.raceUsed; this.raceUsed = 0 }
    const circle = this.circles.get(a.circle_id)
    const wholeReveal = a.kind === 'reveal' && !a.resend
    if (a.kind === 'invite' && circle?.status === 'sent') return { ok: false, error: 'names have already been sent' }
    if (wholeReveal && (!this.lockTakes || circle?.status !== 'drawn')) return { ok: false, error: 'names have already been sent' }
    const hourAgo = Date.now() - 60 * 60_000
    const skipped: { member_id: string; reason: string }[] = []
    const go: string[] = []
    for (const id of a.member_ids ?? []) {
      if (!this.members.some(m => m.id === id && m.circle_id === a.circle_id)) continue
      const mine = this.texts.filter(t => t.member_id === id)
      if (a.kind === 'invite' && !a.resend &&
          mine.some(t => t.kind === 'invite' && !t.dry_run && (t.status === 'sent' || t.status === 'pending'))) {
        skipped.push({ member_id: id, reason: 'already invited' })
      } else if (mine.filter(t => Date.parse(t.created_at) > hourAgo).length >= 3) {
        skipped.push({ member_id: id, reason: 'too many texts, try again in an hour' })
      } else go.push(id)
    }
    if (!a.dry_run && go.length > 0) {
      if (this.used + go.length > this.cap || (this.lastQuota !== null && this.lastQuota <= 5)) {
        return { ok: false, error: 'text budget used up' }
      }
      this.used += go.length
    }
    if (wholeReveal && circle) circle.status = 'sent'
    const texts = go.map(member_id => {
      const row: TextRow = {
        id: crypto.randomUUID(), member_id, kind: a.kind, status: 'pending', provider_id: null, error: null,
        dry_run: a.dry_run, quota_remaining: null, body: null,
        created_at: new Date(Date.now() + this.seq++).toISOString()
      }
      this.texts.push(row)
      this.inserted.push(row)
      return { member_id, text_id: row.id }
    })
    return { ok: true, texts, skipped }
  }

  /** pending -> sent / failed, after the provider call (spec S3). */
  async finishText (textId: string, patch: Partial<TextRow>) {
    this.touch()
    if (this.failFinish) throw new Error('could not log a text')
    const row = this.texts.find(t => t.id === textId)
    if (!row) throw new Error(`no pending text ${textId}`)
    Object.assign(row, patch)
  }

  /** public.record_text_quota (spec S1). */
  async recordQuota (q: number) {
    this.touch()
    this.lastQuota = q
  }

  status (id: string) {
    return this.circles.get(id)?.status
  }
  member (label: string) {
    const m = this.members.find(x => x.id === memberId(label))
    if (!m) throw new Error(`no member ${label}`)
    return m
  }
}

export interface Sent {
  phone: string; message: string; circleStatuses: Record<string, string>
  /** db.used and the pending rows at the moment the provider was called. */
  usedAtSend: number; pendingAtSend: string[]
}

export class FakeProvider {
  /** Every message handed to the provider, with every circle's status at that moment. */
  outbox: Sent[] = []
  /** Scripted replies, used in order; then a default success. 'throw' simulates a network error. */
  script: any[] = []
  /** spec S4: false when TEXTBELT_KEY isn't set (makeTextbeltProvider reports this). */
  configured = true
  constructor (private db: FakeDb) {}

  async send (phone: string, message: string) {
    const circleStatuses: Record<string, string> = {}
    for (const [id, c] of this.db.circles) circleStatuses[id] = c.status
    const pendingAtSend = this.db.texts.filter(t => t.status === 'pending' && !t.dry_run).map(t => t.member_id)
    this.outbox.push({ phone, message, circleStatuses, usedAtSend: this.db.used, pendingAtSend })
    const next = this.script.length ? this.script.shift() : { success: true, textId: `tb-${this.outbox.length}`, quotaRemaining: 40 }
    if (next === 'throw') throw new Error('network down')
    return next
  }
}

export async function getUserId (header: string | null): Promise<string | null> {
  if (header === JWT_A) return ELF_A
  if (header === JWT_B) return ELF_B
  if (header === JWT_C) return ELF_C
  return null
}

/**
 * A standard world:
 *   C1 (Elf A): Ava, Ben, Cy with phones +1 555 555-0101..0103
 *   C2 (Elf B): Zed +1 555 555-0199
 */
export function world (opts: { status?: string; budget?: number | null; swap_date?: string | null; extra?: { label: string; phone: string | null }[] } = {}) {
  const db = new FakeDb()
  const C1 = circleId('C1')
  const C2 = circleId('C2')
  db.circles.set(C1, {
    id: C1, elf_id: ELF_A, name: "Ava's Crew",
    budget: opts.budget === undefined ? 20 : opts.budget,
    swap_date: opts.swap_date === undefined ? '2026-12-19' : opts.swap_date,
    swap_place: "Nonna's porch", status: opts.status ?? 'open'
  })
  db.circles.set(C2, { id: C2, elf_id: ELF_B, name: 'Other Crew', budget: 10, swap_date: '2026-12-20', swap_place: 'Elsewhere', status: 'open' })
  const add = (cid: string, label: string, phone: string | null) =>
    db.members.push({ id: memberId(label), circle_id: cid, first_name: label, phone, token: token(label) })
  add(C1, 'Ava', '+15555550101')
  add(C1, 'Ben', '+15555550102')
  add(C1, 'Cy', '+15555550103')
  for (const e of opts.extra ?? []) add(C1, e.label, e.phone)
  add(C2, 'Zed', '+15555550199')
  if (opts.status === 'drawn' || opts.status === 'sent') {
    // Ava -> Ben -> Cy -> Ava
    for (const [g, r] of [['Ava', 'Ben'], ['Ben', 'Cy'], ['Cy', 'Ava']]) {
      db.matches.push({ circle_id: C1, giver_id: memberId(g), receiver_id: memberId(r) })
    }
  }
  const provider = new FakeProvider(db)
  return { db, provider, C1, C2 }
}

/** Seed an existing texts row. Defaults: a real, successful invite two hours ago. */
export function seedText (db: FakeDb, label: string, o: Partial<{ kind: string; status: string; dry_run: boolean; quota_remaining: number | null; minutesAgo: number }> = {}) {
  // Every real row was claimed first (spec S1), so it is in the counter too.
  if (!(o.dry_run ?? false)) {
    db.used++
    if (typeof o.quota_remaining === 'number') db.lastQuota = o.quota_remaining
  }
  db.texts.push({
    id: crypto.randomUUID(),
    member_id: memberId(label),
    kind: o.kind ?? 'invite',
    status: o.status ?? 'sent',
    provider_id: (o.dry_run ?? false) ? null : 'tb-old',
    error: (o.status ?? 'sent') === 'failed' ? 'old failure' : null,
    dry_run: o.dry_run ?? false,
    quota_remaining: o.quota_remaining ?? null,
    body: (o.dry_run ?? false) ? 'old dry-run body' : null,
    created_at: new Date(Date.now() - (o.minutesAgo ?? 120) * 60_000).toISOString()
  })
}

export function request (body: unknown, o: { auth?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = o.auth === undefined ? JWT_A : o.auth
  if (auth !== null) headers.authorization = auth
  const method = o.method ?? 'POST'
  return new Request('http://localhost/functions/v1/send-texts', {
    method,
    headers,
    body: method === 'GET' || method === 'OPTIONS' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  })
}

/** Call the handler and read the JSON body (null if it isn't JSON). */
export async function call (
  w: { db: FakeDb; provider: FakeProvider },
  env: Record<string, string>,
  body: unknown,
  o: { auth?: string | null; method?: string } = {}
) {
  const { handle } = await load('./handler.ts')
  const res: Response = await handle(request(body, o), { db: w.db, provider: w.provider, env: { ...env }, getUserId })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers }
}
