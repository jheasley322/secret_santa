// Shared e2e settings and database helpers. Dev tooling only.
//
// Reads only SUPABASE_DB_URL and SUPABASE_PUBLISHABLE_KEY (by name) from .env.
// Never the Textbelt key or the service-role key (tests/tools/env.mjs refuses them).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv } from '../../tools/env.mjs'
import { connect } from '../../tools/db.mjs'

loadEnv(['SUPABASE_DB_URL', 'SUPABASE_PUBLISHABLE_KEY'])

export const PROJECT_REF = 'hnnzoiuibnikrucncphu'
export const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`
export const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`
export const AUTH_DIR = resolve(process.cwd(), 'tests/e2e/.auth')
export const E2E_EMAIL_DOMAIN = 'secret-santa-e2e.invalid'
export const E2E_PREFIX = '[e2e]'

export function publishableKey () {
  if (process.env.SUPABASE_PUBLISHABLE_KEY) return process.env.SUPABASE_PUBLISHABLE_KEY
  const src = readFileSync(resolve(process.cwd(), 'js/supabaseClient.js'), 'utf8')
  const m = src.match(/SUPABASE_PUBLISHABLE_KEY\s*=\s*['"]([^'"]+)['"]/)
  if (!m || m[1] === 'PASTE_PUBLISHABLE_KEY_HERE') {
    throw new Error('No publishable key: set SUPABASE_PUBLISHABLE_KEY or paste it into js/supabaseClient.js')
  }
  return m[1]
}

/** Run fn with a pg client, always closing it. Refuses any project but ours. */
export async function withDb (fn) {
  const url = process.env.SUPABASE_DB_URL ?? ''
  if (!url.includes(PROJECT_REF)) {
    throw new Error(`SUPABASE_DB_URL is not project ${PROJECT_REF}; e2e refuses to write anywhere else`)
  }
  const db = await connect()
  try {
    return await fn(db)
  } finally {
    await db.end()
  }
}

/** Delete every [e2e] circle (members, texts etc. cascade). Never by any other key. */
export async function sweepCircles (db) {
  await db.query("delete from public.circles where name like '[e2e]%'")
}
