// Display formatting for circle details.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-12-19' -> 'Sat Dec 19'. A calendar day, so the viewer's time zone never shifts it. */
export function swapDateLabel (ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '')
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** The facts shown under a circle's name: "$20", "Sat Dec 19", "Maya's house" (only those set). */
export function circleFacts (circle) {
  const out = []
  if (typeof circle.budget === 'number') out.push(`$${circle.budget}`)
  if (circle.swap_date) out.push(swapDateLabel(circle.swap_date))
  if (circle.swap_place) out.push(circle.swap_place)
  return out
}

export function memberLink (baseUrl, token) {
  return `${String(baseUrl).replace(/\/+$/, '')}/m/#${token}`
}
