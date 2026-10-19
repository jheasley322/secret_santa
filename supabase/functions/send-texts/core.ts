// Pure core of send-texts: settings, the credit cap and reserve, the rate limit,
// and who gets texted. No I/O, no environment access, no network. Tested by core_test.ts.
//
// spec "Texting", "Texting -> HARD LIMITS", "Texting details (Phase 2 contract)".

export const DEFAULT_APP_BASE_URL = 'https://jheasley322.github.io/secret_santa'
/** spec HARD LIMITS 1: refuse once Textbelt's quotaRemaining is at or below this. */
export const RESERVE = 5
/** spec "Re-send": at most 3 texts per member per hour. */
export const RATE_LIMIT = 3
const HOUR_MS = 60 * 60 * 1000

export const ERR = {
  notFound: 'circle not found',
  budget: 'text budget used up',
  links: 'links not approved yet',
  rate: 'too many texts, try again in an hour',
  notDrawn: 'names have not been drawn yet',
  alreadySent: 'names have already been sent',
  notSentYet: 'names have not been sent yet'
} as const

export type Kind = 'invite' | 'reveal'

export interface TextRow {
  member_id: string
  kind: string
  status: string
  dry_run: boolean
  quota_remaining: number | null
  created_at: string
}

export interface Member {
  id: string
  circle_id: string
  first_name: string
  phone: string | null
  token: string
}

export interface Settings { dryRun: boolean; linksApproved: boolean; appBaseUrl: string }

/**
 * Safe defaults (CLAUDE.md rule 9): only the exact value "false" turns on real
 * sends, and only the exact value "true" approves links. Anything else, including
 * a missing value, is dry run / not approved.
 */
export function readSettings (env: Record<string, string | undefined>): Settings {
  return {
    dryRun: env.TEXTS_DRY_RUN !== 'false',
    linksApproved: env.TEXT_LINKS_APPROVED === 'true',
    appBaseUrl: (env.APP_BASE_URL && env.APP_BASE_URL.trim()) || DEFAULT_APP_BASE_URL
  }
}

const time = (t: TextRow) => Date.parse(t.created_at)

/**
 * spec HARD LIMITS 1. A batch fits only if every real row so far (failed ones
 * included, every circle) plus the batch stays within the cap, and the latest
 * recorded quotaRemaining is above the reserve. Dry-run rows never count.
 */
export function budgetAllows ({ texts, cap, batchSize }: { texts: TextRow[]; cap: number; batchSize: number }): boolean {
  if (batchSize <= 0) return true
  const real = texts.filter(t => t.dry_run === false)
  if (real.length + batchSize > cap) return false
  let latest: TextRow | null = null
  for (const t of real) {
    if (typeof t.quota_remaining !== 'number') continue
    if (!latest || time(t) > time(latest)) latest = t
  }
  return !(latest && (latest.quota_remaining as number) <= RESERVE)
}

/** spec "Re-send": the next text would be the 4th to this member within an hour. Every row counts. */
export function isRateLimited ({ texts, memberId, now }: { texts: TextRow[]; memberId: string; now: Date }): boolean {
  const since = now.getTime() - HOUR_MS
  return texts.filter(t => t.member_id === memberId && time(t) > since).length >= RATE_LIMIT
}

export interface Skip { member_id: string; reason: string }

/**
 * spec "Who gets texted". One member: just them (Re-send is explicit). Invite
 * batch: members without a successful real invite. Reveal batch: everyone.
 * No phone: skipped and reported, never an error.
 */
export function pickRecipients (
  { kind, members, texts, memberId }: { kind: Kind; members: Member[]; texts: TextRow[]; memberId?: string }
): { send: Member[]; skipped: Skip[] } {
  const send: Member[] = []
  const skipped: Skip[] = []
  const invited = new Set(
    texts.filter(t => t.kind === 'invite' && t.status === 'sent' && t.dry_run === false).map(t => t.member_id)
  )
  const pool = memberId ? members.filter(m => m.id === memberId) : members
  for (const m of pool) {
    if (!m.phone) skipped.push({ member_id: m.id, reason: 'no phone number' })
    else if (!memberId && kind === 'invite' && invited.has(m.id)) skipped.push({ member_id: m.id, reason: 'already invited' })
    else send.push(m)
  }
  return { send, skipped }
}
