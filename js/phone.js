// Phone numbers to E.164 (spec "Data model": e.g. +15551234567).
// US numbers only (spec "Security hardening" S2), typed any common way.
// Anything that isn't clearly a US phone number gives null (the page then shows
// an error), and the database checks the same pattern again (^\+1[0-9]{10}$).

const US_E164 = /^\+1[0-9]{10}$/

export function normalizePhone (input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  // Only digits, spaces and ( ) - . are allowed, plus one leading +.
  if (!/^\+?[0-9\s().-]+$/.test(s)) return null
  const digits = s.replace(/\D/g, '')
  let out
  if (s.startsWith('+')) {
    // +1 and 10 more digits only: other country codes are refused.
    if (!digits.startsWith('1') || digits.length !== 11) return null
    out = '+' + digits
  } else if (digits.length === 10) {
    out = '+1' + digits
  } else if (digits.length === 11 && digits.startsWith('1')) {
    out = '+' + digits
  } else {
    return null
  }
  return US_E164.test(out) ? out : null
}

/** +15555550101 -> (555) 555-0101 for display; other numbers as stored. */
export function formatPhone (e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '')
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? '')
}
