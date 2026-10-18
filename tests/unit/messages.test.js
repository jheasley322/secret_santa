// MSG-01..11: the text-message builder.
// Spec: "Texting details (Phase 2 contract) -> Message format", "Texting"
// ("Shortened links ... are always blocked, so we send the full link").
//
// Module under test: supabase/functions/_shared/messages.js (plain JS, shared by
// the Edge Function and these tests). Loaded dynamically so a missing module
// makes each test red instead of crashing the file.

import { describe, it, expect, beforeAll } from 'vitest'
import { isGsm7, nonGsm7, septets, fitsOneSegment } from './gsm7.js'

let m
beforeAll(async () => {
  m = await import('../../supabase/functions/_shared/messages.js')
})

const BASE = 'https://jheasley322.github.io/secret_santa'
const TOKEN = 'Qx7_k2-LmN0pRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuV' // 43 chars, base64url
const LINK = `${BASE}/m/#${TOKEN}`

const LONG_KID = 'Bartholomew-Maximilian Featherstonehaugh' // 40 chars, the DB maximum
const LONG_CIRCLE = 'The Extended Family and Friends of the Featherstonehaugh Household Holiday Crew!' // 80 chars, the DB maximum

const SHORTENERS = /bit\.ly|tinyurl|t\.co\/|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly/i

function invite (name, circle, link = LINK) {
  return m.inviteText({ name, circle, link })
}
function reveal (name, receiver, { budget = null, swapDate = null, link = LINK } = {}) {
  return m.revealText({ name, receiver, budget, swapDate, link })
}

describe('sanity of the fixtures', () => {
  it('fixture lengths are what the tests claim', () => {
    expect(TOKEN).toHaveLength(43)
    expect(LONG_KID).toHaveLength(40)
    expect(LONG_CIRCLE).toHaveLength(80)
  })
})

describe('MSG-01 invite template', () => {
  it('MSG-01 short names give exactly the spec template', () => {
    expect(invite('Maya', "Ava's Crew"))
      .toBe(`Secret Santa! Hi Maya, add your wish list for Ava's Crew: ${LINK}`)
  })
})

describe('MSG-02 member link', () => {
  it('MSG-02 is {APP_BASE_URL}/m/#<token>', () => {
    expect(m.memberLink(BASE, TOKEN)).toBe(LINK)
  })
  it('MSG-02 a trailing slash on the base makes no double slash', () => {
    expect(m.memberLink(BASE + '/', TOKEN)).toBe(LINK)
  })
  it('MSG-02 is the full URL on the configured base, never a shortener', () => {
    const link = m.memberLink(BASE, TOKEN)
    expect(link.startsWith(BASE + '/')).toBe(true)
    expect(link).not.toMatch(SHORTENERS)
    expect(link.endsWith('#' + TOKEN)).toBe(true)
  })
  it('MSG-02 the link inside a text is the link exactly as given', () => {
    expect(invite('Maya', "Ava's Crew").endsWith(' ' + LINK)).toBe(true)
    expect(reveal('Maya', 'Ava', { budget: 20, swapDate: '2026-12-19' }).endsWith(' ' + LINK)).toBe(true)
  })
})

describe('MSG-03 / 04 / 05 reveal template', () => {
  it('MSG-03 budget and date: spec start, $20, Dec 19, spec ending', () => {
    const t = reveal('Maya', 'Ava', { budget: 20, swapDate: '2026-12-19' })
    expect(t.startsWith('Secret Santa! Maya, you drew Ava! ')).toBe(true)
    expect(t).toContain('$20')
    expect(t).toContain('Dec 19')
    expect(t.endsWith(`. Their list: ${LINK}`)).toBe(true)
  })

  const junk = /null|undefined|NaN|Invalid/
  it('MSG-04 budget only: shows the budget, no date', () => {
    const t = reveal('Maya', 'Ava', { budget: 20 })
    expect(t.startsWith('Secret Santa! Maya, you drew Ava!')).toBe(true)
    expect(t).toContain('$20')
    expect(t).not.toMatch(/Dec|Jan|Nov/)
    expect(t).not.toMatch(junk)
    expect(t.endsWith(`Their list: ${LINK}`)).toBe(true)
  })
  it('MSG-04 date only: shows the date, no $', () => {
    const t = reveal('Maya', 'Ava', { swapDate: '2026-12-19' })
    expect(t).toContain('Dec 19')
    expect(t).not.toContain('$')
    expect(t).not.toMatch(junk)
    expect(t.endsWith(`Their list: ${LINK}`)).toBe(true)
  })
  it('MSG-04 neither: no $, no date, no "!." and no double space', () => {
    const t = reveal('Maya', 'Ava')
    expect(t.startsWith('Secret Santa! Maya, you drew Ava!')).toBe(true)
    expect(t.endsWith(` Their list: ${LINK}`)).toBe(true)
    expect(t).not.toContain('$')
    expect(t).not.toContain('!.')
    expect(t).not.toContain('  ')
    expect(t).not.toMatch(junk)
  })
  it('MSG-05 a budget of 0 is set, so it shows $0', () => {
    expect(reveal('Maya', 'Ava', { budget: 0 })).toContain('$0')
  })
})

describe('MSG-06 swap date in every time zone', () => {
  const zones = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/London', 'Asia/Tokyo', 'Pacific/Kiritimati']
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']

  it('MSG-06 2026-12-19 is Dec 19 (and if a weekday shows, Sat) in UTC-10 .. UTC+14', () => {
    const original = process.env.TZ
    const offsets = new Set()
    try {
      for (const tz of zones) {
        process.env.TZ = tz
        offsets.add(new Date(Date.UTC(2026, 11, 19, 12)).getTimezoneOffset())
        const t = reveal('Maya', 'Ava', { budget: 20, swapDate: '2026-12-19' })
        expect(t, tz).toContain('Dec 19')
        expect(t, tz).not.toMatch(/Dec 18|Dec 20/)
        for (const wd of weekdays) expect(t, `${tz} shows ${wd}`).not.toMatch(new RegExp(`\\b${wd}\\b`))
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
    // Guard against a vacuous test: the zone switch really happened.
    expect(offsets.size).toBeGreaterThan(3)
  })
})

describe('MSG-07 / 08 one segment, GSM-7 only', () => {
  const names = ['Al', 'Maya', 'Zoë', 'José', 'O’Brien', 'Ava 🎅', '👨‍👩‍👧 Kai', 'Ana [the] {great}', 'Lu€y^', LONG_KID, 'Mia — “Mimi”']
  const circles = ["Ava's Crew", 'x', 'Cousins ★ 2026 — “Best” crew 🎄🎁', 'Ava’s Crew…', LONG_CIRCLE, 'Crew [2026] {fun} ~ | \\ ^ €']
  const budgets = [null, 0, 20, 99999]
  const dates = [null, '2026-12-19', '2027-01-01']

  const all = []
  beforeAll(() => {
    for (const n of names) {
      for (const c of circles) all.push(['invite', n, c, invite(n, c)])
      for (const r of names) {
        for (const b of budgets) {
          for (const d of dates) all.push(['reveal', n, r, reveal(n, r, { budget: b, swapDate: d })])
        }
      }
    }
  })

  it('MSG-07 every invite and reveal is at most 160 septets', () => {
    expect(all.length).toBeGreaterThan(400)
    for (const [kind, a, b, t] of all) {
      expect(isGsm7(t), `${kind} ${a} / ${b}: non-GSM-7 ${JSON.stringify(nonGsm7(t))}`).toBe(true)
      expect(septets(t), `${kind} ${a} / ${b}: ${t}`).toBeLessThanOrEqual(160)
    }
  })

  it('MSG-07 every output ends with the whole link', () => {
    for (const [kind, a, b, t] of all) expect(t.endsWith(' ' + LINK), `${kind} ${a} / ${b}`).toBe(true)
  })

  it('MSG-08 emoji are dropped (ZWJ families, skin tones, flags, variation selectors)', () => {
    const t = invite('Kai 👨‍👩‍👧👍🏽🇺🇸❤️', 'Crew 🎄')
    expect(isGsm7(t), JSON.stringify(nonGsm7(t))).toBe(true)
    expect(t).toContain('Kai')
    expect(t).toContain('Crew')
    expect(t).not.toMatch(/[\uD800-\uDFFF️‍]/)
  })
  it('MSG-08 curly quotes become straight quotes', () => {
    const t = invite('O’Brien', '“Best” Ava‘s Crew')
    expect(t).toContain("O'Brien")
    expect(t).toContain('"Best"')
    expect(t).toContain("Ava's Crew")
    expect(t).not.toMatch(/[‘’“”]/)
  })
  it('MSG-08 en and em dashes become "-"', () => {
    const t = invite('Mia', 'Ava – Ben — Cy')
    expect(t).toContain('Ava - Ben - Cy')
    expect(t).not.toMatch(/[–—]/)
  })
  it('MSG-08 no ellipsis character anywhere', () => {
    for (const [, , , t] of all) expect(t).not.toContain('…')
  })
})

describe('MSG-09 / 10 / 11 shortening', () => {
  const INVITE = /^Secret Santa! Hi (.+), add your wish list for (.+): (\S+)$/
  const REVEAL = /^Secret Santa! (.+?), you drew (.+?)! (?:(.*)\. )?Their list: (\S+)$/

  function shortenedFrom (part, original) {
    if (part === original) return 'whole'
    expect(part.endsWith('...'), `"${part}" is changed but doesn't end with "..."`).toBe(true)
    const kept = part.slice(0, -3)
    expect(kept.length, `"${part}" keeps nothing of "${original}"`).toBeGreaterThan(0)
    expect(original.startsWith(kept), `"${kept}" is not a prefix of "${original}"`).toBe(true)
    return 'shortened'
  }

  it('MSG-09 long invite: names shortened with "...", link whole and last', () => {
    const t = invite(LONG_KID, LONG_CIRCLE)
    expect(fitsOneSegment(t), t).toBe(true)
    const p = t.match(INVITE)
    expect(p, t).not.toBeNull()
    expect(p[3]).toBe(LINK)
    const verdicts = [shortenedFrom(p[1], LONG_KID), shortenedFrom(p[2], LONG_CIRCLE)]
    expect(verdicts).toContain('shortened')
  })

  it('MSG-09 long reveal: names shortened with "...", link whole and last', () => {
    const t = reveal(LONG_KID, 'Maximiliana-Josephine Featherstonehaugh', { budget: 99999, swapDate: '2026-12-19' })
    expect(fitsOneSegment(t), t).toBe(true)
    const p = t.match(REVEAL)
    expect(p, t).not.toBeNull()
    expect(p[4]).toBe(LINK)
    shortenedFrom(p[1], LONG_KID)
    shortenedFrom(p[2], 'Maximiliana-Josephine Featherstonehaugh')
    expect(t).toContain('...')
  })

  it('MSG-10 names that fit are never shortened', () => {
    expect(invite('Maya', "Ava's Crew")).not.toContain('...')
    expect(invite('Bartholomew', 'Cousins Crew')).not.toContain('...')
    const r = reveal('Maya', 'Ava', { budget: 20, swapDate: '2026-12-19' })
    expect(r).not.toContain('...')
    expect(r.match(REVEAL)?.slice(1, 3)).toEqual(['Maya', 'Ava'])
  })

  it('MSG-11 an emoji-only name still gives one valid segment with the whole link', () => {
    for (const t of [invite('🎅', '🎄🎁'), reveal('🎅', '⭐', { budget: 20, swapDate: '2026-12-19' })]) {
      expect(fitsOneSegment(t), t).toBe(true)
      expect(t.endsWith(' ' + LINK)).toBe(true)
    }
  })
})
