// send-texts request handler. Everything it touches is injected (db, provider,
// env, getUserId), so handler_test.ts runs it against fakes with no network.
// index.ts is the only file that reads the process environment, creates clients or
// calls fetch.
//
// spec "Texting details (Phase 2 contract) -> Order of checks":
//   auth and ownership -> status -> cap (whole batch must fit) -> links gate
//   -> per-member rate limit -> send.
// A whole-circle reveal locks drawn -> sent AFTER those checks and BEFORE the
// first text, and the lock is never rolled back (spec "Texting", agent brief).

import {
  ERR, RESERVE, type Kind, type Member, type TextRow,
  budgetAllows, isRateLimited, pickRecipients, readSettings
} from './core.ts'
import { inviteText, memberLink, revealText } from '../_shared/messages.js'

export interface Circle {
  id: string; elf_id: string; name: string; budget: number | null
  swap_date: string | null; swap_place: string | null; status: string
}

export interface NewText {
  member_id: string; kind: Kind; status: 'sent' | 'failed'; provider_id: string | null
  error: string | null; dry_run: boolean; quota_remaining: number | null; body: string | null
}

export interface Deps {
  db: {
    getCircle (id: string): Promise<Circle | null>
    getMembers (circleId: string): Promise<Member[]>
    getMatches (circleId: string): Promise<{ giver_id: string; receiver_id: string }[]>
    getTexts (): Promise<TextRow[]>
    getCap (): Promise<number>
    insertText (row: NewText): Promise<unknown>
    lockCircleSent (id: string): Promise<boolean>
  }
  provider: { send (phone: string, message: string): Promise<{ success: boolean; textId?: string; quotaRemaining?: number; error?: string }> }
  env: Record<string, string | undefined>
  getUserId (authorization: string | null): Promise<string | null>
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json (status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } })
}
const refuse = (status: number, error: string) => json(status, { error })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Body { circle_id: string; kind: Kind; member_id?: string }

function parseBody (raw: unknown): Body | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const b = raw as Record<string, unknown>
  if (typeof b.circle_id !== 'string' || !UUID.test(b.circle_id)) return null
  if (b.kind !== 'invite' && b.kind !== 'reveal') return null
  if (b.member_id !== undefined && b.member_id !== null && (typeof b.member_id !== 'string' || !UUID.test(b.member_id))) return null
  return { circle_id: b.circle_id, kind: b.kind, member_id: (b.member_id as string | null) ?? undefined }
}

interface Result { member_id: string; status: 'sent' | 'failed' | 'skipped'; error?: string }

export async function handle (req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return refuse(405, 'method not allowed')

  try {
    // 1. Auth and ownership.
    const userId = await deps.getUserId(req.headers.get('authorization'))
    if (!userId) return refuse(401, 'please sign in again')

    let raw: unknown
    try { raw = await req.json() } catch { return refuse(400, 'bad request') }
    const body = parseBody(raw)
    if (!body) return refuse(400, 'bad request')

    const circle = await deps.db.getCircle(body.circle_id)
    if (!circle || circle.elf_id !== userId) return refuse(404, ERR.notFound)

    const members = await deps.db.getMembers(circle.id)
    if (body.member_id && !members.some(m => m.id === body.member_id)) return refuse(404, 'member not found')

    // 2. Status. spec "Circle status", "Re-send", "kind: 'reveal' for the whole
    // circle is allowed only from drawn".
    const one = Boolean(body.member_id)
    if (body.kind === 'reveal') {
      if (circle.status === 'open') return refuse(409, ERR.notDrawn)
      if (!one && circle.status === 'sent') return refuse(409, ERR.alreadySent)
      if (one && circle.status !== 'sent') return refuse(409, ERR.notSentYet)
    } else if (circle.status === 'sent') {
      return refuse(409, ERR.alreadySent)
    }

    const settings = readSettings(deps.env)
    const texts = await deps.db.getTexts()
    const now = new Date()
    const { send: picked, skipped } = pickRecipients({ kind: body.kind, members, texts, memberId: body.member_id })
    const results: Result[] = skipped.map(s => ({ member_id: s.member_id, status: 'skipped', error: s.reason }))

    // In a batch, a member who hit the hourly limit is skipped and reported; the
    // rest still go. A one-member Re-send gets the request-level refusal (step 5).
    let send = picked
    if (!one) {
      send = picked.filter(m => {
        if (!isRateLimited({ texts, memberId: m.id, now })) return true
        results.push({ member_id: m.id, status: 'skipped', error: ERR.rate })
        return false
      })
    }

    if (send.length > 0 && !settings.dryRun) {
      // 3. Cap: the whole batch must fit, checked before the provider is called.
      if (!budgetAllows({ texts, cap: await deps.db.getCap(), batchSize: send.length })) return refuse(403, ERR.budget)
      // 4. Links gate: every invite and reveal carries the member's link.
      if (!settings.linksApproved) return refuse(403, ERR.links)
    }

    // 5. Rate limit for an explicit Re-send (applies in dry run too).
    if (one && send.length > 0 && isRateLimited({ texts, memberId: send[0].id, now })) return refuse(429, ERR.rate)

    // Lock the draw before the first reveal leaves. If it doesn't take, someone
    // else already sent the names: send nothing.
    let receiverOf = new Map<string, string>()
    if (body.kind === 'reveal') {
      if (!one && !(await deps.db.lockCircleSent(circle.id))) return refuse(409, ERR.alreadySent)
      const byId = new Map(members.map(m => [m.id, m]))
      receiverOf = new Map((await deps.db.getMatches(circle.id))
        .map(x => [x.giver_id, byId.get(x.receiver_id)?.first_name ?? '']))
    }

    // 6. Send.
    let stopped = false
    for (const m of send) {
      const link = memberLink(settings.appBaseUrl, m.token)
      let message: string
      if (body.kind === 'reveal') {
        const receiver = receiverOf.get(m.id)
        if (!receiver) { results.push({ member_id: m.id, status: 'skipped', error: 'no match' }); continue }
        message = revealText({ name: m.first_name, receiver, budget: circle.budget, swapDate: circle.swap_date, link })
      } else {
        message = inviteText({ name: m.first_name, circle: circle.name, link })
      }

      if (settings.dryRun) {
        // spec "Dry-run bodies": the exact message is logged, nothing is sent.
        await deps.db.insertText({
          member_id: m.id, kind: body.kind, status: 'sent', provider_id: null, error: null,
          dry_run: true, quota_remaining: null, body: message
        })
        results.push({ member_id: m.id, status: 'sent' })
        continue
      }

      // spec HARD LIMITS 1: once the reserve is reached, nothing more goes out.
      if (stopped) { results.push({ member_id: m.id, status: 'skipped', error: ERR.budget }); continue }

      let r: { success: boolean; textId?: string; quotaRemaining?: number; error?: string }
      try {
        r = await deps.provider.send(m.phone as string, message)
      } catch (err) {
        r = { success: false, error: (err as Error)?.message || 'send failed' }
      }
      const quota = typeof r?.quotaRemaining === 'number' ? r.quotaRemaining : null
      const ok = r?.success === true
      // Logged whatever happened: a failed send may still have cost a credit.
      await deps.db.insertText({
        member_id: m.id, kind: body.kind, status: ok ? 'sent' : 'failed',
        provider_id: ok && r.textId != null ? String(r.textId) : null,
        error: ok ? null : String(r?.error || 'send failed').slice(0, 200),
        dry_run: false, quota_remaining: quota, body: null
      })
      results.push(ok ? { member_id: m.id, status: 'sent' } : { member_id: m.id, status: 'failed', error: String(r?.error || 'send failed').slice(0, 200) })
      if (quota !== null && quota <= RESERVE) stopped = true
    }

    const count = (s: Result['status']) => results.filter(r => r.status === s).length
    return json(200, { sent: count('sent'), failed: count('failed'), skipped: count('skipped'), dry_run: settings.dryRun, results })
  } catch (err) {
    // Never echo internals (or anything secret) to the browser.
    console.error('send-texts failed:', (err as Error)?.message)
    return refuse(500, 'something went wrong, nothing more was sent')
  }
}
