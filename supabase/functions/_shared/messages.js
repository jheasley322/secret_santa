// Text-message builder for send-texts. Plain JS with no imports, so the Edge
// Function (Deno) and the unit tests (Node) load the same file.
//
// spec "Texting details (Phase 2 contract) -> Message format":
//   * one text = one credit: <= 160 GSM-7 septets, GSM-7 characters only
//   * curly quotes and dashes become plain ones; anything else outside GSM-7
//     (emoji, symbols) is dropped
//   * names are shortened with "..." to fit; the link is never shortened
//   * Invite: Secret Santa! Hi {name}, add your wish list for {circle}: {link}
//   * Reveal: Secret Santa! {name}, you drew {receiver}! {budget/date if set}. Their list: {link}

const MAX_SEPTETS = 160

// GSM 03.38 basic set (1 septet) and extension table (2 septets: ESC + char).
// Newlines and the form feed are left out on purpose: a text is one line.
const BASIC = new Set([...'@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'])
const EXTENSION = new Set([...'^{}\\[~]|€'])

const REPLACE = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[\s ]+/g, ' ']
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Septets a GSM-7 string uses. */
export function septets (text) {
  let n = 0
  for (const ch of text) n += EXTENSION.has(ch) ? 2 : 1
  return n
}

/** Plain GSM-7 version of user text: quotes and dashes straightened, the rest dropped. */
export function toGsm7 (value) {
  let s = String(value ?? '').normalize('NFC')
  for (const [re, to] of REPLACE) s = s.replace(re, to)
  s = [...s].filter(ch => BASIC.has(ch) || EXTENSION.has(ch)).join('')
  return s.replace(/ {2,}/g, ' ').trim()
}

/** Keep a prefix of `text` and add "..." so the result uses at most `max` septets. */
function shorten (text, max) {
  if (septets(text) <= max) return text
  const chars = [...text]
  while (chars.length > 1 && septets(chars.join('').trimEnd() + '...') > max) chars.pop()
  return chars.join('').trimEnd() + '...'
}

/**
 * Fill a template so the whole text fits. `fixed` is everything but the
 * shortenable fields; each pass shortens the longest field by one character.
 */
function fit (fields, fixedSeptets) {
  const out = fields.slice()
  const room = () => MAX_SEPTETS - fixedSeptets - out.reduce((n, f) => n + septets(f), 0)
  while (room() < 0) {
    let i = 0
    for (let j = 1; j < out.length; j++) if (septets(out[j]) > septets(out[i])) i = j
    const before = out[i]
    // Already as short as it gets ("X..."): nothing more to take.
    if ([...before.replace(/\.\.\.$/, '')].length <= 1 && before.endsWith('...')) break
    out[i] = shorten(fields[i], septets(before) - 1)
    if (out[i] === before) break
  }
  return out
}

/** The member's personal link: {APP_BASE_URL}/m/#<token>. Always the full URL. */
export function memberLink (baseUrl, token) {
  return `${String(baseUrl).replace(/\/+$/, '')}/m/#${token}`
}

/** "Dec 19" from 'YYYY-MM-DD', read as a calendar day (no time zone involved). */
export function shortDate (swapDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(swapDate ?? ''))
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${month} ${Number(m[3])}` : null
}

export function inviteText ({ name, circle, link }) {
  const n = toGsm7(name) || 'friend'
  const c = toGsm7(circle) || 'Secret Santa'
  const head = 'Secret Santa! Hi '
  const mid = ', add your wish list for '
  const tail = `: ${link}`
  const [fn, fc] = fit([n, c], septets(head + mid + tail))
  return `${head}${fn}${mid}${fc}${tail}`
}

export function revealText ({ name, receiver, budget, swapDate, link }) {
  const n = toGsm7(name) || 'friend'
  const r = toGsm7(receiver) || 'your match'
  const parts = []
  // Terse on purpose: the details must leave room for two names in 160 septets.
  if (typeof budget === 'number' && Number.isFinite(budget)) parts.push(`$${Math.trunc(budget)}`)
  const d = shortDate(swapDate)
  if (d) parts.push(d)
  const details = parts.length ? ` ${parts.join(', ')}.` : ''
  const head = 'Secret Santa! '
  const mid = ', you drew '
  const tail = `!${details} Their list: ${link}`
  const [fn, fr] = fit([n, r], septets(head + mid + tail))
  return `${head}${fn}${mid}${fr}${tail}`
}
