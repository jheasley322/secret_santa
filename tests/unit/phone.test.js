// PH-01..07: phone normalisation to E.164, US (+1) only.
// Spec: "Data model" (phone E.164, e.g. +15551234567), "Interface contract ->
// Constraints" (phone: null or ^\+[1-9][0-9]{7,14}$), "The flow" 2.
//
// Module under test: js/phone.js -> normalizePhone(input) returns an E.164
// string, or null for anything that isn't a phone number.
// Fictional numbers only: +1 555 555-01xx.

import { describe, it, expect, beforeAll } from 'vitest'

let normalizePhone
beforeAll(async () => {
  ({ normalizePhone } = await import('../../js/phone.js'))
})

const E164 = /^\+[1-9][0-9]{7,14}$/
// spec S2: the DB accepts +1 and ten digits only.
const US = /^\+1[0-9]{10}$/

describe('PH-01 US 10-digit formats', () => {
  for (const input of ['5555550123', '555-555-0123', '(555) 555-0123', '(555)555-0123', '555.555.0123', '555 555 0123', '  555-555-0123  ']) {
    it(`PH-01 ${JSON.stringify(input)} -> +15555550123`, () => {
      expect(normalizePhone(input)).toBe('+15555550123')
    })
  }
})

describe('PH-02 leading 1 and +1', () => {
  for (const input of ['15555550123', '1 555 555 0123', '1-555-555-0123', '1 (555) 555-0123', '+15555550123', '+1 555 555 0123', '+1 (555) 555-0123', '+1-555-555-0123']) {
    it(`PH-02 ${JSON.stringify(input)} -> +15555550123`, () => {
      expect(normalizePhone(input)).toBe('+15555550123')
    })
  }
})

// Revised 2026-10-24, spec "Security hardening" S2: phone numbers are US only
// (+1) at the DB check, so the page must not accept what the database rejects.
describe('PH-03 non-US numbers are rejected (US only, spec S2)', () => {
  for (const input of ['+44 20 7946 0958', '+61 491 570 006', '+33 6 12 34 56 78', '+52 1 555 555 0142', '+7 912 345 67 89']) {
    it(`PH-03 ${JSON.stringify(input)} -> null`, () => {
      expect(normalizePhone(input)).toBeNull()
    })
  }
})

describe('PH-04 junk is rejected', () => {
  const junk = [
    '', '   ', null, undefined,
    'abc', 'call me', '1-800-FLOWERS', '555-CALL-NOW',
    '555-0123', // 7 digits, no area code
    '555-555-012', // 9 digits
    '25555550123', // 11 digits not starting with 1
    '+12345678901234567', // too long
    '555-555-0123 ext 4', '555-555-0123 x4',
    '++15555550123', '+0 555 555 0123', '+', '()-. ', '📞', '555-555-0123📞',
    '+1 555 555 0123; drop table members'
  ]
  for (const input of junk) {
    it(`PH-04 ${JSON.stringify(input)} -> null`, () => {
      expect(normalizePhone(input)).toBeNull()
    })
  }
  it('PH-04 a non-string object -> null (no throw)', () => {
    expect(normalizePhone({ phone: '5555550123' })).toBeNull()
  })
})

describe('PH-05 / 06 output shape', () => {
  const inputs = ['5555550123', '(555) 555-0101', '1 555 555 0199', '+15555550150', '+44 20 7946 0958', 'junk', '', '555-0123']

  it('PH-05 every non-null output matches the spec E.164 pattern', () => {
    for (const input of inputs) {
      const out = normalizePhone(input)
      if (out !== null) expect(out, input).toMatch(E164)
      if (out !== null) expect(out, input).toMatch(US)
    }
  })

  it('PH-06 normalising twice gives the same answer', () => {
    for (const input of inputs) {
      const once = normalizePhone(input)
      if (once !== null) expect(normalizePhone(once), input).toBe(once)
    }
  })
})

describe('PH-07 a phone is required (Decision 5)', () => {
  it('PH-07 nothing typed gives null, so the page can say a number is needed', () => {
    for (const input of ['', '   ', null, undefined]) expect(normalizePhone(input)).toBeNull()
  })
})

// PH-08 (re-audit finding 3, 2026-10-24): +1 is the whole NANP. Canada and the
// Caribbean share it, and "US only" (S2) refuses them, matching the database
// (AL-24..26). US territories are the US. Every number uses the fictional
// 555-01xx line.
describe('PH-08 +1 numbers outside the US are rejected', () => {
  for (const input of ['+1 416 555 0101', '(604) 555-0101', '514-555-0101', '1 867 555 0101', '+19055550101']) {
    it(`PH-08 Canada: ${input}`, () => { expect(normalizePhone(input)).toBe(null) })
  }
  for (const input of ['+1 876 555 0101', '(809) 555-0101', '242-555-0101', '+14415550101']) {
    it(`PH-08 Caribbean / Atlantic: ${input}`, () => { expect(normalizePhone(input)).toBe(null) })
  }
  for (const [input, out] of [['(787) 555-0101', '+17875550101'], ['803-555-0101', '+18035550101'], ['555-555-0101', '+15555550101']]) {
    it(`PH-08 US and US territories still pass: ${input}`, () => { expect(normalizePhone(input)).toBe(out) })
  }
})
