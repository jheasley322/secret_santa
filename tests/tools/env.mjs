// Load ONLY the named variables from .env. Dev tooling only.
//
// Why not `import 'dotenv/config'`: that copies every line of .env into
// process.env, and .env also holds the real Textbelt key. No test process may
// ever have that key in its environment (CLAUDE.md rule 9, spec "Texting ->
// HARD LIMITS"). This reader looks at each line's NAME first and skips any line
// whose name wasn't asked for, so other values are never parsed, stored or
// returned.
//
// A value already set in the real environment wins (CI sets them as secrets).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Names that must never be loaded, even if a caller asks by mistake.
const NEVER = /TEXTBELT|SERVICE_ROLE|SECRET/i

export function loadEnv (names, file = resolve(process.cwd(), '.env')) {
  for (const name of names) {
    if (NEVER.test(name)) throw new Error(`refusing to load ${name}: test tooling never loads provider keys or secrets`)
  }
  const wanted = new Set(names.filter(n => process.env[n] === undefined))
  if (wanted.size === 0) return
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return // no .env: the caller reports what's missing
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (!m || !wanted.has(m[1])) continue
    let value = line.slice(m[0].length).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    process.env[m[1]] = value
  }
}
