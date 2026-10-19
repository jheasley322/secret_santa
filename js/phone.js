// Phone numbers to E.164 (spec "Data model": e.g. +15551234567).
// US numbers can be typed any common way; other countries need a leading +.
// Anything that isn't clearly a phone number gives null (the page then shows
// an error), and the database checks the same pattern again.

const E164 = /^\+[1-9][0-9]{7,14}$/

export function normalizePhone (input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  // Only digits, spaces and ( ) - . are allowed, plus one leading +.
  if (!/^\+?[0-9\s().-]+$/.test(s)) return null
  const digits = s.replace(/\D/g, '')
  let out
  if (s.startsWith('+')) {
    if (digits.startsWith('1') && digits.length !== 11) return null
    out = '+' + digits
  } else if (digits.length === 10) {
    out = '+1' + digits
  } else if (digits.length === 11 && digits.startsWith('1')) {
    out = '+' + digits
  } else {
    return null
  }
  return E164.test(out) ? out : null
}

/** +15555550101 -> (555) 555-0101 for display; other numbers as stored. */
export function formatPhone (e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '')
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? '')
}
