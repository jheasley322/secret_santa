// Phone numbers to E.164 (spec "Data model": e.g. +15551234567).
// US numbers only (spec "Security hardening" S2), typed any common way.
// Anything that isn't clearly a US phone number gives null (the page then shows
// an error), and the database checks the same rule again (members_phone_check).

const US_E164 = /^\+1[0-9]{10}$/

// +1 is the whole North American Numbering Plan, not just the US. These are the
// area codes of Canada and the Caribbean / Atlantic countries that share +1.
// US territories (787/939, 340, 671, 670, 684) are the US and are allowed.
// MIRROR of the list in supabase/migrations/20261024150000_audit_lows.sql
// (the database is the real check). Change both together.
// Source: NANPA area code assignments (nanpa.com; Canadian codes per CNA,
// cnac.ca), compiled 2026-10-24 without web access. See the migration's notes.
export const NON_US_NANP = new Set([
  // Canada
  '204', '226', '236', '249', '250', '257', '263', '289', '306', '343', '354', '365',
  '367', '368', '382', '403', '416', '418', '428', '431', '437', '438', '450', '468',
  '474', '506', '514', '519', '548', '579', '581', '584', '587', '600', '604', '613',
  '622', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782',
  '807', '819', '825', '867', '873', '879', '902', '905', '942',
  // Caribbean / Atlantic
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721',
  '758', '767', '784', '809', '829', '849', '868', '869', '876'
])

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
  if (!US_E164.test(out)) return null
  // Canada and the Caribbean also use +1: refused (spec S2, US only).
  return NON_US_NANP.has(out.slice(2, 5)) ? null : out
}

/** +15555550101 -> (555) 555-0101 for display; other numbers as stored. */
export function formatPhone (e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '')
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? '')
}
