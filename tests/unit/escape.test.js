// ESC-01..04: HTML escaping of everything a user typed.
// Spec: "Stack" ("Everything a user typed is escaped when shown"), CLAUDE.md rule 7.
//
// Module under test: js/escape.js -> escapeHtml(value) returns a string that is
// safe to place in HTML text or a quoted attribute.

import { describe, it, expect, beforeAll } from 'vitest'

let escapeHtml
beforeAll(async () => {
  ({ escapeHtml } = await import('../../js/escape.js'))
})

// The test's own decoder, covering every spelling of the five entities.
function decode (s) {
  return s
    .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
    .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '<a href="javascript:alert(1)">hi</a>',
  '</textarea><svg onload=alert(1)>',
  'Tom & Jerry',
  '&amp; already escaped &lt;',
  '&#60;script&#62;'
]

describe('ESC-01 the five characters', () => {
  it('ESC-01 & < > " \' are all escaped', () => {
    const out = escapeHtml(`& < > " '`)
    expect(out).not.toMatch(/[<>"']/)
    expect(out).toContain('&amp;')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
  })
  for (const p of PAYLOADS) {
    it(`ESC-01 no raw < > " ' in ${JSON.stringify(p)}`, () => {
      expect(escapeHtml(p)).not.toMatch(/[<>"']/)
    })
  }
})

describe('ESC-02 round trip', () => {
  for (const p of PAYLOADS) {
    it(`ESC-02 decode(escape(x)) === x for ${JSON.stringify(p)}`, () => {
      expect(decode(escapeHtml(p))).toBe(p)
    })
  }
  it('ESC-02 & is escaped first: "&amp;" becomes "&amp;amp;"', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })
})

describe('ESC-03 payloads come out inert', () => {
  it('ESC-03 no tag can open and no attribute can be broken out of', () => {
    for (const p of PAYLOADS) {
      const out = escapeHtml(p)
      expect(out).not.toMatch(/<\s*[a-z/!]/i)
      expect(out).not.toMatch(/["']\s*on[a-z]+\s*=/i)
    }
  })
})

describe('ESC-04 non-string and harmless input', () => {
  it('ESC-04 null and undefined give an empty string', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })
  it('ESC-04 numbers become strings', () => {
    expect(escapeHtml(20)).toBe('20')
    expect(escapeHtml(0)).toBe('0')
  })
  it('ESC-04 plain and non-ASCII text pass through unchanged', () => {
    for (const s of ['Maya', 'Zoë', 'José', 'Size 10 shoes, M shirt', '$20 · Sat Dec 19', '🎅']) {
      expect(escapeHtml(s)).toBe(s)
    }
  })
})
