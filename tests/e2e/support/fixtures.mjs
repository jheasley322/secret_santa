// Playwright fixtures for every e2e spec.
//
// SAFETY: real texts are impossible from e2e.
//   * **/functions/v1/send-texts is intercepted on every page and answered by a
//     local stub. The deployed function is never reached. The stub writes
//     dry-run rows (dry_run = true) straight into `texts`, so the page shows
//     status from the table exactly as it would in production dry-run mode.
//   * Any request to textbelt.com is aborted.
//   * Every call the page made to send-texts is recorded in `sendCalls`, so
//     tests can assert on the request the page sent.
//   * Reveal behaves like the real function (spec "Texting"): a whole-circle
//     reveal is allowed only from `drawn` and locks the circle to `sent` BEFORE
//     any row is written; a one-member reveal needs `sent`.
//   * `sendStub` lets a test make the stub report chosen members as `failed`
//     or `skipped` (Phase 4, per-member results). Defaults: everyone sent.

import { test as base, expect } from '@playwright/test'
import { inviteText, memberLink, revealText } from '../../../supabase/functions/_shared/messages.js'
import { withDb } from './project.mjs'

const APP_BASE_URL = 'https://jheasley322.github.io/secret_santa'

async function stubSendTexts (body, opts = {}) {
  const fail = opts.fail ?? new Set()
  const skip = opts.skip ?? new Map()
  return withDb(async db => {
    const { rows: [circle] } = await db.query('select * from public.circles where id = $1', [body.circle_id])
    if (!circle) return { status: 404, json: { error: 'circle not found' } }
    if (body.kind === 'reveal') {
      if (circle.status === 'open') return { status: 409, json: { error: 'names have not been drawn yet' } }
      if (!body.member_id && circle.status === 'sent') return { status: 409, json: { error: 'names have already been sent' } }
      if (body.member_id && circle.status !== 'sent') return { status: 409, json: { error: 'names have not been sent yet' } }
      // Lock first, like claim_texts does: drawn -> sent before anything is "sent".
      if (!body.member_id) await db.query("update public.circles set status = 'sent' where id = $1", [circle.id])
    }
    const { rows: members } = await db.query('select * from public.members where circle_id = $1 order by first_name', [circle.id])
    const byId = new Map(members.map(m => [m.id, m]))
    const { rows: matches } = await db.query('select giver_id, receiver_id from public.matches where circle_id = $1', [circle.id])
    const receiverOf = new Map(matches.map(x => [x.giver_id, byId.get(x.receiver_id)?.first_name ?? '?']))
    const targets = body.member_id ? members.filter(m => m.id === body.member_id) : members
    const results = []
    for (const m of targets) {
      if (!m.phone) { results.push({ member_id: m.id, status: 'skipped', error: 'no phone number' }); continue }
      if (skip.has(m.id)) { results.push({ member_id: m.id, status: 'skipped', error: skip.get(m.id) }); continue }
      const link = memberLink(APP_BASE_URL, m.token)
      const text = body.kind === 'reveal'
        ? revealText({ name: m.first_name, receiver: receiverOf.get(m.id) ?? '?', budget: circle.budget, swapDate: null, link })
        : inviteText({ name: m.first_name, circle: circle.name, link })
      const failed = fail.has(m.id)
      await db.query(
        `insert into public.texts (member_id, kind, status, dry_run, body, error) values ($1, $2, $3, true, $4, $5)`,
        [m.id, body.kind, failed ? 'failed' : 'sent', text, failed ? 'carrier rejected' : null]
      )
      results.push(failed ? { member_id: m.id, status: 'failed', error: 'carrier rejected' } : { member_id: m.id, status: 'sent' })
    }
    const count = s => results.filter(r => r.status === s).length
    return { status: 200, json: { sent: count('sent'), failed: count('failed'), skipped: count('skipped'), dry_run: true, results } }
  })
}

export const test = base.extend({
  sendCalls: async ({}, use) => { await use([]) },
  // Mutable per test: sendStub.fail.add(memberId), sendStub.skip.set(memberId, reason).
  sendStub: async ({}, use) => { await use({ fail: new Set(), skip: new Map() }) },
  page: async ({ page, sendCalls, sendStub }, use) => {
    await page.route(/textbelt\.com/i, route => route.abort())
    await page.route('**/functions/v1/send-texts', async route => {
      const req = route.request()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
      const body = req.postDataJSON()
      sendCalls.push({ body, authorization: req.headers().authorization ?? null })
      const out = await stubSendTexts(body, sendStub)
      await route.fulfill({ status: out.status, contentType: 'application/json', json: out.json })
    })
    await use(page)
  }
})

export { expect }
