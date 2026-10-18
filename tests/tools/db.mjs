// Direct Postgres connection for the dev test tooling. Never shipped: the site
// talks to Supabase through supabase-js and the publishable key, never to
// Postgres directly.

import pg from 'pg'
import { loadEnv } from './env.mjs'

// Only SUPABASE_DB_URL is read from .env; nothing else in that file is loaded.
loadEnv(['SUPABASE_DB_URL'])

export function connectionString () {
  const url = process.env.SUPABASE_DB_URL
  if (!url) {
    throw new Error(
      'SUPABASE_DB_URL is not set. Copy .env.example to .env and fill in the ' +
      'connection string for project hnnzoiuibnikrucncphu (session pooler, port 5432, or direct).'
    )
  }
  // The transaction pooler hands each statement to whichever backend is free,
  // so the runner's BEGIN ... ROLLBACK would not wrap the test file. That is
  // the one property that makes the suite safe against the live project.
  if (url.includes(':6543')) {
    throw new Error(
      'SUPABASE_DB_URL points at the transaction pooler (port 6543), which cannot ' +
      'hold a transaction open across statements. Use the session pooler (port 5432) or a direct connection.'
    )
  }
  return url
}

function isLocal (url) {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

export async function connect () {
  const url = connectionString()
  const client = new pg.Client({
    connectionString: url,
    ssl: isLocal(url) ? false : { rejectUnauthorized: false },
    // A hung test must not hold locks on the live project indefinitely.
    statement_timeout: 120_000
  })
  await client.connect()
  return client
}
