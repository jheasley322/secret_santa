// LINK-01..04: wish-link validation on the page.
// Spec: "Data model" (wish_items.url: nullable, must be http/https),
// "Interface contract -> save_my_list" (url null or http(s) only, <= 500 chars),
// "Stack" (wish links). Mirrors the database rule (Phase 1 LIST-07/08), so the
// page never accepts a link the database will reject.
//
// Module under test: js/links.js -> isValidWishLink(url) returns a boolean.

import { describe, it, expect, beforeAll } from 'vitest'

let isValidWishLink
beforeAll(async () => {
  ({ isValidWishLink } = await import('../../js/links.js'))
})

describe('LINK-01 http and https are accepted', () => {
  for (const url of [
    'https://www.example.com/lego-castle',
    'http://example.com',
    'HTTPS://EXAMPLE.COM/Item?id=5#reviews',
    'Https://shop.example.org/a/b/c?x=1&y=2'
  ]) {
    it(`LINK-01 accepts ${url}`, () => {
      expect(isValidWishLink(url)).toBe(true)
    })
  }
})

describe('LINK-02 every other scheme is rejected', () => {
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'javascript://example.com/%0Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:someone@example.com',
    '//evil.example.com/x',
    'www.example.com',
    'example.com/item',
    'https:example.com'
  ]) {
    it(`LINK-02 rejects ${JSON.stringify(url)}`, () => {
      expect(isValidWishLink(url)).toBe(false)
    })
  }
})

describe('LINK-03 length', () => {
  const base = 'https://example.com/'
  it('LINK-03 500 characters are accepted', () => {
    const url = base + 'a'.repeat(500 - base.length)
    expect(url).toHaveLength(500)
    expect(isValidWishLink(url)).toBe(true)
  })
  it('LINK-03 501 characters are rejected', () => {
    const url = base + 'a'.repeat(501 - base.length)
    expect(url).toHaveLength(501)
    expect(isValidWishLink(url)).toBe(false)
  })
})

describe('LINK-04 shape', () => {
  for (const url of ['https://', 'http://', 'https:// example.com', 'https://exa mple.com/x', 'https://example.com/a b']) {
    it(`LINK-04 rejects ${JSON.stringify(url)}`, () => {
      expect(isValidWishLink(url)).toBe(false)
    })
  }
})
