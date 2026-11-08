// send-texts request handler. Everything it touches is injected (db, provider,
// env, getUserId), so handler_test.ts runs it against fakes with no network.
// index.ts is the only file that reads the process environment, creates clients or
// calls fetch.
//
// Order (spec "Texting details -> Order of checks", "Security hardening" S1-S4):
//   JWT -> ELF_USER_IDS allow-list (before any database use) -> ownership ->
//   status -> "not set up" (real mode, no provider key) -> cap pre-check ->
//   links gate -> per-member rate limit -> claim_texts (the atomic database gate:
//   credits, duplicate filter, rate limit and, for Send the names, drawn -> sent,
//   all under the circle lock) -> per text: provider call, then mark the pending
//   row sent / failed -> record Textbelt's quotaRemaining.
// kind 'reshuffle' takes the same path with claim_reshuffle as the claim: it makes
// the new draw, so its messages are built from the receiver_id each claimed text
// comes back with, and its rate limit refuses the whole batch (spec "All or
// nothing"). Once that claim succeeds, any failure must say the new draw exists
// (spec "Honest failures"). A Re-send names the match read after its claim.
// A claimed row is never deleted. If a log write fails the batch stops and the
// unsent rows end failed (fail closed); the lock is never rolled back.

import {
  ERR, RESERVE, type Kind, type Member, type TextRow,
  budgetAllows, isRateLimited, pickRecipients, readSettings
} from './core.ts'
import { inviteText, memberLink, reshuffleText, revealText } from '../_shared/messages.js'

export interface Circle {
  id: string; elf_id: string; name: string; budget: number | null
  swap_date: string | null; swap_place: string | null; status: string
}

export interface FinishPatch {
  status: 'sent' | 'failed'; provider_id: string | null; error: string | null
  quota_remaining: number | null; body: string | null
}

export type ClaimResult =
  | { ok: true; texts: { member_id: string; text_id: string; receiver_id?: string }[]; skipped: { member_id: string; reason: string }[] }
  | { ok: false; error: string }

export interface Deps {
  db: {
    getCircle (id: string): Promise<Circle | null>
    getMembers (circleId: string): Promise<Member[]>
    getMatches (circleId: string): Promise<{ giver_id: string; receiver_id: string }[]>
    /** Text rows for (at least) this circle's members: the rate limit and duplicate pre-checks. */
    getTexts (circleId: string): Promise<TextRow[]>
    getBudget (): Promise<{ cap: number; used: number; last_quota: number | null }>
    claimTexts (a: { circle_id: string; kind: Exclude<Kind, 'reshuffle'>; member_ids: string[]; dry_run: boolean; resend: boolean }): Promise<ClaimResult>
    /** claim_reshuffle: the new draw, the credits and the pending rows, all or nothing. */
    claimReshuffle (a: { circle_id: string; member_ids: string[]; dry_run: boolean }): Promise<ClaimResult>
    finishText (textId: string, patch: FinishPatch): Promise<unknown>
    recordQuota (quota: number): Promise<unknown>
    /** True once the circle is sent (claim_texts moves it for a whole-circle reveal). */
    lockCircleSent (id: string): Promise<boolean>
  }
  provider: {
    configured: boolean
    send (phone: string, message: string): Promise<{ success: boolean; textId?: string; quotaRemaining?: number; error?: string }>
  }
  env: Record<string, string | undefined>
  getUserId (authorization: string | null): Promise<string | null>
}

/** spec S2: the approved Elves. Missing, empty or blank means nobody (fail closed). */
export function allowedElves (raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))
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
  if (b.kind !== 'invite' && b.kind !== 'reveal' && b.kind !== 'reshuffle') return null
  // spec "Texting": a re-shuffle is whole-circle only.
  if (b.kind === 'reshuffle' && b.member_id !== undefined && b.member_id !== null) return null
  if (b.member_id !== undefined && b.member_id !== null && (typeof b.member_id !== 'string' || !UUID.test(b.member_id))) return null
  return { circle_id: b.circle_id, kind: b.kind, member_id: (b.member_id as string | null) ?? undefined }
}

interface Result { member_id: string; status: 'sent' | 'failed' | 'skipped'; error?: string }

export async function handle (req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return refuse(405, 'method not allowed')

  // Set the moment claim_reshuffle succeeds: from then on the new draw exists.
  let drawMade = false

  try {
    // 1. Auth, then the allow-list (S2) before anything touches the database, so
    //    no service-role client is ever created for a stranger.
    const userId = await deps.getUserId(req.headers.get('authorization'))
    if (!userId) return refuse(401, 'please sign in again')
    if (!allowedElves(deps.env.ELF_USER_IDS).has(userId)) return refuse(404, ERR.notFound)

    let raw: unknown
    try { raw = await req.json() } catch { return refuse(400, 'bad request') }
    const body = parseBody(raw)
    if (!body) return refuse(400, 'bad request')

    // Ownership.
    const circle = await deps.db.getCircle(body.circle_id)
    if (!circle || circle.elf_id !== userId) return refuse(404, ERR.notFound)

    const members = await deps.db.getMembers(circle.id)
    if (body.member_id && !members.some(m => m.id === body.member_id)) return refuse(404, 'member not found')

    // 2. Status. spec "Circle status", "Re-send", "kind: 'reveal' for the whole
    // circle is allowed only from drawn". claim_texts re-checks under the lock.
    const one = Boolean(body.member_id)
    const isReshuffle = body.kind === 'reshuffle'
    if (body.kind === 'reshuffle') {
      if (circle.status !== 'sent') return refuse(409, ERR.notSentYet)
    } else if (body.kind === 'reveal') {
      if (circle.status === 'open') return refuse(409, ERR.notDrawn)
      if (!one && circle.status === 'sent') return refuse(409, ERR.alreadySent)
      if (one && circle.status !== 'sent') return refuse(409, ERR.notSentYet)
    } else if (circle.status === 'sent') {
      return refuse(409, ERR.alreadySent)
    }

    // 3. S4: real mode without a provider key, only now that the caller is known.
    const settings = readSettings(deps.env)
    if (!settings.dryRun && !deps.provider.configured) return refuse(503, 'texting is not set up yet')

    const texts = await deps.db.getTexts(circle.id)
    const now = new Date()
    const { send: picked, skipped } = pickRecipients({ kind: body.kind, members, texts, memberId: body.member_id })
    // A re-shuffle's skips come back from its claim, which is told about everyone.
    const results: Result[] = isReshuffle ? [] : skipped.map(s => ({ member_id: s.member_id, status: 'skipped', error: s.reason }))

    // In a batch, a member who hit the hourly limit is skipped and reported; the
    // rest still go (Decision 3). A one-member Re-send gets the request-level
    // refusal, and so does a re-shuffle, which is all or nothing.
    let send = picked
    if (!one && !isReshuffle) {
      send = picked.filter(m => {
        if (!isRateLimited({ texts, memberId: m.id, now })) return true
        results.push({ member_id: m.id, status: 'skipped', error: ERR.rate })
        return false
      })
    }

    // Each member's message. Invites and reveals are built before the claim so
    // nothing is claimed for a member who can't be texted. A re-shuffle's are
    // built from its claim, and a Re-send's are rebuilt after its claim.
    const message = new Map<string, string>()
    const nameOf = new Map(members.map(m => [m.id, m.first_name]))
    const drawDetails = (m: Member, receiver: string | undefined) => ({
      name: m.first_name, receiver, budget: circle.budget,
      swapDate: circle.swap_date, link: memberLink(settings.appBaseUrl, m.token)
    })
    const receivers = async () => new Map((await deps.db.getMatches(circle.id))
      .map(x => [x.giver_id, nameOf.get(x.receiver_id) ?? '']))
    if (body.kind === 'reveal') {
      const receiverOf = await receivers()
      send = send.filter(m => {
        if (receiverOf.get(m.id)) return true
        results.push({ member_id: m.id, status: 'skipped', error: 'no match' })
        return false
      })
      for (const m of send) message.set(m.id, revealText(drawDetails(m, receiverOf.get(m.id))))
    } else if (body.kind === 'invite') {
      for (const m of send) {
        message.set(m.id, inviteText({ name: m.first_name, circle: circle.name, link: memberLink(settings.appBaseUrl, m.token) }))
      }
    }

    if (send.length > 0 && !settings.dryRun) {
      // 4. Cap pre-check (read-only; the claim below is the real gate).
      const b = await deps.db.getBudget()
      if (!budgetAllows({ used: b.used, cap: b.cap, lastQuota: b.last_quota, batchSize: send.length })) return refuse(403, ERR.budget)
      // 5. Links gate: every invite and reveal carries the member's link.
      if (!settings.linksApproved) return refuse(403, ERR.links)
    }

    // 6. Rate limit for an explicit Re-send or a re-shuffle (applies in dry run too).
    if ((one || isReshuffle) && send.some(m => isRateLimited({ texts, memberId: m.id, now }))) return refuse(429, ERR.rate)

    const wholeReveal = body.kind === 'reveal' && !one
    // A re-shuffle always reaches its claim, which refuses if nobody has a phone.
    if (send.length === 0 && !wholeReveal && !isReshuffle) return respond(results, settings.dryRun)

    // 7. The claim (S1, S3): credits, pending rows and, for Send the names, the
    // drawn -> sent lock, in one database transaction under the circle lock.
    const claim = body.kind === 'reshuffle'
      ? await deps.db.claimReshuffle({ circle_id: circle.id, member_ids: members.map(m => m.id), dry_run: settings.dryRun })
      : await deps.db.claimTexts({
        circle_id: circle.id, kind: body.kind, member_ids: send.map(m => m.id), dry_run: settings.dryRun, resend: one
      })
    if (!claim || claim.ok !== true) {
      const error = (claim as { error?: string } | null)?.error || 'something went wrong, nothing was sent'
      return refuse(error === ERR.budget ? 403 : error === ERR.rate ? 429 : 409, error)
    }
    drawMade = isReshuffle
    for (const s of claim.skipped ?? []) results.push({ member_id: s.member_id, status: 'skipped', error: s.reason })
    if (one && (claim.texts ?? []).length === 0 && (claim.skipped ?? []).some(s => s.reason === ERR.rate)) {
      return refuse(429, ERR.rate)
    }

    const claimed = claim.texts ?? []
    const byMember = new Map(send.map(m => [m.id, m]))
    const failRest = async (from: number, error: string) => {
      // Claimed but unsent rows end failed, which keeps them counted (fail closed).
      for (const t of claimed.slice(from)) {
        results.push({ member_id: t.member_id, status: 'failed', error })
        try { await deps.db.finishText(t.text_id, { status: 'failed', provider_id: null, error, quota_remaining: null, body: null }) } catch { /* best effort */ }
      }
    }

    // The draw must be locked before the first reveal leaves. If it isn't,
    // someone else already sent the names: send nothing.
    if (wholeReveal && !(await deps.db.lockCircleSent(circle.id))) {
      await failRest(0, ERR.alreadySent)
      return refuse(409, ERR.alreadySent)
    }

    // A kid left without a message below stops the batch in the send loop: a
    // wrong or made-up name is worse than no text.
    if (isReshuffle) {
      // The claim says who each kid drew, in the transaction that made the draw.
      for (const t of claimed) {
        const m = byMember.get(t.member_id)
        const receiver = t.receiver_id ? nameOf.get(t.receiver_id) : undefined
        if (m && receiver) message.set(m.id, reshuffleText(drawDetails(m, receiver)))
      }
    } else if (one && body.kind === 'reveal') {
      // spec "One at a time": read after the claim, while the pending row holds
      // off any re-shuffle, so a Re-send can't name a match that was just replaced.
      message.clear()
      let receiverOf: Map<string, string>
      try {
        receiverOf = await receivers()
      } catch {
        await failRest(0, 'not sent')
        return refuse(500, 'something went wrong, nothing was sent')
      }
      for (const m of send) {
        if (receiverOf.get(m.id)) message.set(m.id, revealText(drawDetails(m, receiverOf.get(m.id))))
      }
    }

    const cutShort = () => json(500, { error: ERR.reshuffleCutShort, results })
    // Decision: don't let this row block Re-send until the sweep. Still counted.
    const markLogFailed = async (textId: string, provider_id: string | null, quota_remaining: number | null) => {
      try {
        await deps.db.finishText(textId, { status: 'failed', provider_id, error: 'could not log this text', quota_remaining, body: null })
      } catch { /* stays pending; the sweep clears it */ }
    }

    // 8. Send.
    let stopped = false
    for (let i = 0; i < claimed.length; i++) {
      const t = claimed[i]
      const m = byMember.get(t.member_id)
      const text = message.get(t.member_id)
      if (!m || !text || !m.phone) {
        await failRest(i, 'not sent')
        return isReshuffle ? cutShort() : refuse(500, 'something went wrong, nothing more was sent')
      }

      if (settings.dryRun) {
        // spec "Dry-run bodies": the exact message is logged, nothing is sent.
        try {
          await deps.db.finishText(t.text_id, { status: 'sent', provider_id: null, error: null, quota_remaining: null, body: text })
        } catch {
          if (isReshuffle) await markLogFailed(t.text_id, null, null)
          await failRest(i + 1, 'not sent')
          return isReshuffle ? cutShort() : refuse(500, 'could not log a text, nothing more was sent')
        }
        results.push({ member_id: m.id, status: 'sent' })
        continue
      }

      // spec HARD LIMITS 1: once the reserve is reached, nothing more goes out.
      if (stopped) {
        await failRest(i, ERR.budget)
        if (isReshuffle) return cutShort()
        break
      }

      let r: { success: boolean; textId?: string; quotaRemaining?: number; error?: string }
      try {
        r = await deps.provider.send(m.phone, text)
      } catch (err) {
        r = { success: false, error: (err as Error)?.message || 'send failed' }
      }
      const quota = typeof r?.quotaRemaining === 'number' ? r.quotaRemaining : null
      const ok = r?.success === true
      const error = ok ? null : String(r?.error || 'send failed').slice(0, 200)
      results.push(ok ? { member_id: m.id, status: 'sent' } : { member_id: m.id, status: 'failed', error: error as string })
      try {
        // Logged whatever happened: a failed send may still have cost a credit.
        await deps.db.finishText(t.text_id, {
          status: ok ? 'sent' : 'failed', provider_id: ok && r.textId != null ? String(r.textId) : null,
          error, quota_remaining: quota, body: null
        })
        if (quota !== null) await deps.db.recordQuota(quota)
      } catch {
        // Fail closed: this row stays pending (still counted, still "invited"),
        // and nothing more is sent. A re-shuffle tries to mark it failed instead.
        if (isReshuffle) await markLogFailed(t.text_id, ok && r.textId != null ? String(r.textId) : null, quota)
        await failRest(i + 1, 'not sent')
        return isReshuffle ? cutShort() : refuse(500, 'could not log a text, nothing more was sent')
      }
      if (quota !== null && quota <= RESERVE) stopped = true
    }

    return respond(results, settings.dryRun)
  } catch (err) {
    // Never echo internals (or anything secret) to the browser.
    console.error('send-texts failed:', (err as Error)?.message)
    if (drawMade) return refuse(500, ERR.reshuffleCutShort)
    return refuse(500, 'something went wrong, nothing more was sent')
  }
}

function respond (results: Result[], dryRun: boolean): Response {
  const count = (s: Result['status']) => results.filter(r => r.status === s).length
  return json(200, { sent: count('sent'), failed: count('failed'), skipped: count('skipped'), dry_run: dryRun, results })
}
