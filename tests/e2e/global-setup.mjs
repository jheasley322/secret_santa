// e2e global setup: sweep leftover [e2e] circles, sign in two test Elfs with
// the publishable key, and save their sessions as Playwright storage state.
//
// The two Elf accounts are created by Joe once, by hand, in the Supabase
// dashboard (Authentication -> Add user, "auto confirm"), with emails ending in
// @secret-santa-e2e.invalid. Their credentials come from the environment
// (E2E_ELF_A_EMAIL / E2E_ELF_A_PASSWORD / E2E_ELF_B_EMAIL / E2E_ELF_B_PASSWORD),
// read by name only. The suite never creates or deletes auth users itself.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadEnv } from '../tools/env.mjs'
import {
  AUTH_DIR, E2E_EMAIL_DOMAIN, STORAGE_KEY, SUPABASE_URL,
  publishableKey, sweepCircles, withDb
} from './support/project.mjs'

const ELFS = { elf_a: 'E2E_ELF_A', elf_b: 'E2E_ELF_B' }
loadEnv(Object.values(ELFS).flatMap(p => [`${p}_EMAIL`, `${p}_PASSWORD`]))

export default async function globalSetup (config) {
  process.env.TEXTS_DRY_RUN = 'true'
  const baseURL = config.projects[0].use.baseURL
  const key = publishableKey()
  mkdirSync(AUTH_DIR, { recursive: true })

  await withDb(sweepCircles)

  for (const [label, prefix] of Object.entries(ELFS)) {
    const email = process.env[`${prefix}_EMAIL`]
    const password = process.env[`${prefix}_PASSWORD`]
    if (!email || !password) throw new Error(`${prefix}_EMAIL and ${prefix}_PASSWORD must be set (see tests/SCENARIOS.md)`)
    if (!email.endsWith(`@${E2E_EMAIL_DOMAIN}`)) throw new Error(`${prefix}_EMAIL must end in @${E2E_EMAIL_DOMAIN}`)
    const sb = createClient(SUPABASE_URL, key, { auth: { persistSession: false } })
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (error) throw new Error(`could not sign in ${label}: ${error.message}`)
    const state = {
      cookies: [],
      origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: STORAGE_KEY, value: JSON.stringify(data.session) }] }]
    }
    writeFileSync(join(AUTH_DIR, `${label}.json`), JSON.stringify(state))
    writeFileSync(join(AUTH_DIR, `${label}.user.json`), JSON.stringify({ id: data.user.id, email }))
  }
}
