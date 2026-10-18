// PH-01..06: phone normalisation to E.164, US by default.
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

describe('PH-03 international numbers in + form', () => {
  it('PH-03 +44 20 7946 0958 -> +442079460958', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
  })
  it('PH-03 +61 491 570 006 -> +61491570006', () => {
    expect(normalizePhone('+61 491 570 006')).toBe('+61491570006')
  })
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
    }
  })

  it('PH-06 normalising twice gives the same answer', () => {
    for (const input of inputs) {
      const once = normalizePhone(input)
      if (once !== null) expect(normalizePhone(once), input).toBe(once)
    }
  })
})
