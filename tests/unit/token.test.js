// TOK-01..04: reading the member's token from the URL fragment.
// Spec: "Pages" (/m/#<token>, the token lives in the fragment), "Shorter links"
// (12 random bytes, base64url, exactly 16 characters), "Access rules -> Member"
// (an unknown token reveals nothing).
//
// Module under test: js/token.js -> tokenFromHash(hash) returns string | null.
// Every token here is fictional.

import { describe, it, expect, beforeAll } from 'vitest'

let tokenFromHash
beforeAll(async () => {
  ({ tokenFromHash } = await import('../../js/token.js'))
})

const T = 'Ab3_dE-fGh1JkLmN' // 16 base64url characters

describe('TOK-01 a 16-character base64url token is returned as-is', () => {
  it('TOK-01 with the leading #', () => {
    expect(T).toHaveLength(16)
    expect(tokenFromHash(`#${T}`)).toBe(T)
  })
  it('TOK-01 without the leading #', () => {
    expect(tokenFromHash(T)).toBe(T)
  })
  it('TOK-01 case is preserved', () => {
    expect(tokenFromHash('#ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJKLMNOP')
    expect(tokenFromHash('#abcdefghijklmnop')).toBe('abcdefghijklmnop')
  })
  it('TOK-01 - and _ and digits are allowed anywhere', () => {
    for (const t of ['-_0123456789-_ab', '______________-_', '0000000000000000', '-AAAAAAAAAAAAAA_']) {
      expect(t).toHaveLength(16)
      expect(tokenFromHash(`#${t}`)).toBe(t)
    }
  })
})

describe('TOK-02 nothing usable gives null and never throws', () => {
  for (const [label, value] of [
    ['empty string', ''],
    ['just #', '#'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1234567890123456],
    ['an object', { hash: `#${T}` }],
    ['an array', [T]]
  ]) {
    it(`TOK-02 ${label}`, () => {
      expect(() => tokenFromHash(value)).not.toThrow()
      expect(tokenFromHash(value)).toBe(null)
    })
  }
})

describe('TOK-03 the length must be exactly 16', () => {
  it('TOK-03 15 characters', () => {
    expect(tokenFromHash(`#${T.slice(0, 15)}`)).toBe(null)
  })
  it('TOK-03 17 characters', () => {
    expect(tokenFromHash(`#${T}x`)).toBe(null)
  })
  it('TOK-03 an old 32-character token', () => {
    expect(tokenFromHash(`#${T}${T}`)).toBe(null)
  })
  it('TOK-03 an 8-character prefix', () => {
    expect(tokenFromHash(`#${T.slice(0, 8)}`)).toBe(null)
  })
})

describe('TOK-04 anything outside base64url gives null', () => {
  const swap = ch => `#${T.slice(0, 7)}${ch}${T.slice(8)}` // still 16 long
  for (const [label, hash] of [
    ['a +', swap('+')],
    ['a /', swap('/')],
    ['= padding', `#${T.slice(0, 15)}=`],
    ['a space inside', swap(' ')],
    ['a leading space', ` #${T}`],
    ['a trailing space', `#${T} `],
    ['a % escape', `#${T.slice(0, 13)}%41`],
    ['a second #', `#${T.slice(0, 15)}#`],
    ['a ?query', `#${T}?x=1`],
    ['a script tag', '#<script>alert(1)</script>'],
    ['a dot', swap('.')],
    ['a non-ASCII letter', swap('é')],
    ['an emoji', `#${T.slice(0, 14)}\u{1F385}`]
  ]) {
    it(`TOK-04 ${label}`, () => {
      expect(tokenFromHash(hash)).toBe(null)
    })
  }
})
