// WL-01..12: the member page's list check, the page twin of save_my_list.
// Spec: "Wish list" (up to 10 wishes, text + optional link, four optional About
// me fields), "Interface contract -> save_my_list" (about fields nullable,
// trimmed, <= 200; items <= 10; text trimmed 1-200; url null or http(s), <= 500),
// "Data model" (url must be http/https). Mirrors Phase 1 LIST-02..09, so the
// page never sends a list the database will refuse.
//
// Module under test: js/wishlist.js
//   MAX_WISHES, MAX_TEXT, MAX_URL
//   checkList({ about, items }) -> { ok, about, items, errors: [{ field, index?, message }] }
// Contract details: tests/SCENARIOS.md, Phase 3.

import { describe, it, expect, beforeAll } from 'vitest'

let mod
beforeAll(async () => {
  mod = await import('../../js/wishlist.js')
})
const check = input => mod.checkList(input)

const ABOUT_KEYS = ['fav_color', 'fav_snack', 'sizes', 'please_no']
const noAbout = { fav_color: null, fav_snack: null, sizes: null, please_no: null }
const wish = (text, url = '') => ({ text, url })
const errorsFor = (out, field) => out.errors.filter(e => e.field === field)

describe('WL-01 limits', () => {
  it('WL-01 exports 10 wishes, 200 characters of text, 500 of link', () => {
    expect(mod.MAX_WISHES).toBe(10)
    expect(mod.MAX_TEXT).toBe(200)
    expect(mod.MAX_URL).toBe(500)
  })
})

describe('WL-02 a good list', () => {
  it('WL-02 is ok, trimmed, blanks are null, items carry only text and url in order', () => {
    const out = check({
      about: { fav_color: '  Teal ', fav_snack: 'Sour gummy worms', sizes: '   ', please_no: '' },
      items: [
        wish('  Friendship bracelet kit  ', ' https://example.com/bracelets '),
        wish('Fuzzy socks'),
        { text: 'A big sketchbook', url: null, position: 7, extra: 'x' }
      ]
    })
    expect(out.ok).toBe(true)
    expect(out.errors).toEqual([])
    expect(out.about).toEqual({ fav_color: 'Teal', fav_snack: 'Sour gummy worms', sizes: null, please_no: null })
    expect(out.items).toEqual([
      { text: 'Friendship bracelet kit', url: 'https://example.com/bracelets' },
      { text: 'Fuzzy socks', url: null },
      { text: 'A big sketchbook', url: null }
    ])
    for (const item of out.items) expect(Object.keys(item).sort()).toEqual(['text', 'url'])
  })

  it('WL-02 about has exactly the four spec keys', () => {
    const out = check({ about: { fav_color: 'Red', phone: '+15555550123', token: 'x' }, items: [] })
    expect(Object.keys(out.about).sort()).toEqual([...ABOUT_KEYS].sort())
  })

  it('WL-02 an empty list is fine', () => {
    const out = check({ about: {}, items: [] })
    expect(out.ok).toBe(true)
    expect(out.items).toEqual([])
  })
})

describe('WL-03 missing About me', () => {
  it('WL-03 null and missing fields become null', () => {
    expect(check({ about: { fav_color: null }, items: [] }).about).toEqual(noAbout)
  })
  it('WL-03 a missing about object gives four nulls', () => {
    const out = check({ items: [] })
    expect(out.ok).toBe(true)
    expect(out.about).toEqual(noAbout)
  })
  it('WL-03 missing items is an empty list', () => {
    const out = check({ about: {} })
    expect(out.ok).toBe(true)
    expect(out.items).toEqual([])
  })
})

describe('WL-04 About me length', () => {
  for (const field of ABOUT_KEYS) {
    it(`WL-04 ${field}: 200 accepted, 201 rejected`, () => {
      const ok = check({ about: { [field]: 'a'.repeat(200) }, items: [] })
      expect(ok.ok).toBe(true)
      expect(ok.about[field]).toHaveLength(200)
      const bad = check({ about: { [field]: 'a'.repeat(201) }, items: [] })
      expect(bad.ok).toBe(false)
      const errs = errorsFor(bad, field)
      expect(errs).toHaveLength(1)
      expect(errs[0].message).toMatch(/\S/)
    })
  }
  it('WL-04 length is counted after trimming', () => {
    expect(check({ about: { sizes: `  ${'a'.repeat(200)}  ` }, items: [] }).ok).toBe(true)
  })
})

describe('WL-05 a wish needs text', () => {
  for (const [label, text] of [['empty', ''], ['spaces only', '   '], ['a tab and newline', '\t\n'], ['missing', undefined], ['null', null]]) {
    it(`WL-05 ${label} text with a link is an error at that row`, () => {
      const out = check({ about: {}, items: [wish('Socks'), { text, url: 'https://example.com/x' }] })
      expect(out.ok).toBe(false)
      const errs = errorsFor(out, 'text')
      expect(errs).toHaveLength(1)
      expect(errs[0].index).toBe(1)
      expect(errs[0].message).toMatch(/\S/)
    })
  }
})

describe('WL-06 an untouched row is dropped', () => {
  it('WL-06 no text and no link is dropped, not an error', () => {
    const out = check({ about: {}, items: [wish('Socks'), wish('', ''), wish('   ', '  '), { text: null, url: null }, wish('Kite')] })
    expect(out.ok).toBe(true)
    expect(out.items).toEqual([{ text: 'Socks', url: null }, { text: 'Kite', url: null }])
  })
  it('WL-06 dropped rows do not count toward 10', () => {
    const items = Array.from({ length: 10 }, (_, i) => wish(`Wish ${i + 1}`))
    items.splice(3, 0, wish('', ''))
    items.push(wish(' ', ''))
    const out = check({ about: {}, items })
    expect(out.ok).toBe(true)
    expect(out.items).toHaveLength(10)
  })
})

describe('WL-07 wish text length', () => {
  it('WL-07 200 accepted', () => {
    expect(check({ about: {}, items: [wish('w'.repeat(200))] }).ok).toBe(true)
  })
  it('WL-07 200 with surrounding spaces accepted and trimmed', () => {
    const out = check({ about: {}, items: [wish(`  ${'w'.repeat(200)} `)] })
    expect(out.ok).toBe(true)
    expect(out.items[0].text).toHaveLength(200)
  })
  it('WL-07 201 rejected at that row', () => {
    const out = check({ about: {}, items: [wish('ok'), wish('w'.repeat(201))] })
    expect(out.ok).toBe(false)
    const errs = errorsFor(out, 'text')
    expect(errs).toHaveLength(1)
    expect(errs[0].index).toBe(1)
  })
})

describe('WL-08 at most 10 wishes', () => {
  const many = n => Array.from({ length: n }, (_, i) => wish(`Wish ${i + 1}`))
  it('WL-08 10 accepted', () => {
    const out = check({ about: {}, items: many(10) })
    expect(out.ok).toBe(true)
    expect(out.items).toHaveLength(10)
  })
  it('WL-08 11 rejected with an items error', () => {
    const out = check({ about: {}, items: many(11) })
    expect(out.ok).toBe(false)
    const errs = errorsFor(out, 'items')
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/\S/)
  })
})

describe('WL-09 links must be http(s)', () => {
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'example.com/socks',
    'www.example.com',
    '//example.com/socks',
    'ftp://example.com/file'
  ]) {
    it(`WL-09 rejects ${JSON.stringify(url)} at that row`, () => {
      const out = check({ about: {}, items: [wish('Kite'), wish('Socks', url)] })
      expect(out.ok).toBe(false)
      const errs = errorsFor(out, 'url')
      expect(errs).toHaveLength(1)
      expect(errs[0].index).toBe(1)
      expect(errs[0].message).toMatch(/http/i)
    })
  }
  it('WL-09 http and https in any case are accepted', () => {
    const out = check({ about: {}, items: [wish('a', 'http://example.com'), wish('b', 'HTTPS://EXAMPLE.COM/x?y=1')] })
    expect(out.ok).toBe(true)
  })
})

describe('WL-10 link length and blanks', () => {
  const base = 'https://example.com/'
  it('WL-10 500 accepted', () => {
    const url = base + 'a'.repeat(500 - base.length)
    expect(url).toHaveLength(500)
    expect(check({ about: {}, items: [wish('Kite', url)] }).ok).toBe(true)
  })
  it('WL-10 501 rejected', () => {
    const url = base + 'a'.repeat(501 - base.length)
    const out = check({ about: {}, items: [wish('Kite', url)] })
    expect(out.ok).toBe(false)
    expect(errorsFor(out, 'url')).toHaveLength(1)
  })
  it('WL-10 empty, spaces-only, null and missing links are null', () => {
    const out = check({ about: {}, items: [wish('a', ''), wish('b', '   '), { text: 'c', url: null }, { text: 'd' }] })
    expect(out.ok).toBe(true)
    expect(out.items.map(i => i.url)).toEqual([null, null, null, null])
  })
})

describe('WL-11 several problems', () => {
  it('WL-11 each error points at its own row', () => {
    const out = check({
      about: { fav_snack: 's'.repeat(201) },
      items: [wish('Fine'), wish('', 'https://example.com'), wish('Socks', 'javascript:alert(1)'), wish('w'.repeat(201))]
    })
    expect(out.ok).toBe(false)
    expect(errorsFor(out, 'fav_snack')).toHaveLength(1)
    expect(errorsFor(out, 'text').map(e => e.index).sort()).toEqual([1, 3])
    expect(errorsFor(out, 'url').map(e => e.index)).toEqual([2])
  })
})

describe('WL-12 no mutation', () => {
  it('WL-12 the input is left exactly as it was', () => {
    const input = { about: { fav_color: '  Teal ' }, items: [wish(' Socks ', ' https://example.com '), wish('', '')] }
    const copy = structuredClone(input)
    check(input)
    expect(input).toEqual(copy)
  })
})
