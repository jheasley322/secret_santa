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

import { test as base, expect } from '@playwright/test'
import { inviteText, memberLink, revealText } from '../../../supabase/functions/_shared/messages.js'
import { withDb } from './project.mjs'

const APP_BASE_URL = 'https://jheasley322.github.io/secret_santa'

async function stubSendTexts (body) {
  return withDb(async db => {
    const { rows: [circle] } = await db.query('select * from public.circles where id = $1', [body.circle_id])
    if (!circle) return { status: 404, json: { error: 'circle not found' } }
    const { rows: members } = await db.query('select * from public.members where circle_id = $1 order by first_name', [circle.id])
    const targets = body.member_id ? members.filter(m => m.id === body.member_id) : members
    const results = []
    for (const m of targets) {
      if (!m.phone) { results.push({ member_id: m.id, status: 'skipped', error: 'no phone number' }); continue }
      const link = memberLink(APP_BASE_URL, m.token)
      const text = body.kind === 'reveal'
        ? revealText({ name: m.first_name, receiver: '?', budget: circle.budget, swapDate: null, link })
        : inviteText({ name: m.first_name, circle: circle.name, link })
      await db.query(
        `insert into public.texts (member_id, kind, status, dry_run, body) values ($1, $2, 'sent', true, $3)`,
        [m.id, body.kind, text]
      )
      results.push({ member_id: m.id, status: 'sent' })
    }
    const count = s => results.filter(r => r.status === s).length
    return { status: 200, json: { sent: count('sent'), failed: 0, skipped: count('skipped'), dry_run: true, results } }
  })
}

export const test = base.extend({
  sendCalls: async ({}, use) => { await use([]) },
  page: async ({ page, sendCalls }, use) => {
    await page.route(/textbelt\.com/i, route => route.abort())
    await page.route('**/functions/v1/send-texts', async route => {
      const req = route.request()
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
      const body = req.postDataJSON()
      sendCalls.push({ body, authorization: req.headers().authorization ?? null })
      const out = await stubSendTexts(body)
      await route.fulfill({ status: out.status, contentType: 'application/json', json: out.json })
    })
    await use(page)
  }
})

export { expect }
