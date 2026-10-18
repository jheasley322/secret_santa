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

/** Environments. Real mode is only ever paired with FakeProvider. */
export const ENV_EMPTY: Record<string, string> = {}
export const ENV_DRY: Record<string, string> = { TEXTS_DRY_RUN: 'true', APP_BASE_URL: BASE }
export const ENV_REAL: Record<string, string> = { TEXTS_DRY_RUN: 'false', TEXT_LINKS_APPROVED: 'true', APP_BASE_URL: BASE }
export const ENV_REAL_NO_LINKS: Record<string, string> = { TEXTS_DRY_RUN: 'false', APP_BASE_URL: BASE }

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
  // 43 chars, base64url alphabet, unique per label and never a prefix of another.
  return (`T${label}_` + 'k'.repeat(43)).slice(0, 43)
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
  /** Set false to simulate another request having already locked the circle. */
  lockTakes = true
  private seq = 0

  async getCircle (id: string) {
    const c = this.circles.get(id)
    return c ? { ...c } : null
  }
  async getMembers (cid: string) {
    return this.members.filter(m => m.circle_id === cid).map(m => ({ ...m }))
  }
  async getMatches (cid: string) {
    return this.matches.filter(m => m.circle_id === cid).map(m => ({ giver_id: m.giver_id, receiver_id: m.receiver_id }))
  }
  async getTexts () {
    return this.texts.map(t => ({ ...t }))
  }
  async getCap () {
    return this.cap
  }
  async insertText (row: any) {
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
  async lockCircleSent (id: string) {
    const c = this.circles.get(id)
    if (!this.lockTakes || !c || c.status !== 'drawn') return false
    c.status = 'sent'
    return true
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

export interface Sent { phone: string; message: string; circleStatuses: Record<string, string> }

export class FakeProvider {
  /** Every message handed to the provider, with every circle's status at that moment. */
  outbox: Sent[] = []
  /** Scripted replies, used in order; then a default success. 'throw' simulates a network error. */
  script: any[] = []
  constructor (private db: FakeDb) {}

  async send (phone: string, message: string) {
    const circleStatuses: Record<string, string> = {}
    for (const [id, c] of this.db.circles) circleStatuses[id] = c.status
    this.outbox.push({ phone, message, circleStatuses })
    const next = this.script.length ? this.script.shift() : { success: true, textId: `tb-${this.outbox.length}`, quotaRemaining: 40 }
    if (next === 'throw') throw new Error('network down')
    return next
  }
}

export async function getUserId (header: string | null): Promise<string | null> {
  if (header === JWT_A) return ELF_A
  if (header === JWT_B) return ELF_B
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
