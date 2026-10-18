#!/usr/bin/env node
// pgTAP runner. Dev tooling only, never shipped.
//
// Why not pg_prove: this runs the same way on a Mac with nothing installed and
// on a CI runner, using only the `pg` devDependency.
//
// THE SAFETY PROPERTY, which is why the suite may point at the live project:
// this runner, not the test file, opens the transaction, and it ALWAYS rolls
// it back in a finally block, even when the file throws. A test file that
// forgets to clean up still leaves the database unchanged.
//
// Test files are also written as `begin; ... rollback;` so they can be pasted
// into a SQL console on their own. The runner requires exactly that wrapper:
// the first statement must be `begin;` and the last `rollback;`, each on its
// own line. It strips those two lines, then rejects the file outright if
// anything else in it could end or replace the transaction (COMMIT, END,
// ROLLBACK, BEGIN, START TRANSACTION, PREPARE TRANSACTION).
//
// Usage:
//   node tests/tools/run-pgtap.mjs            every tests/sql/*.sql
//   node tests/tools/run-pgtap.mjs draw       only files whose name contains "draw"

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect } from './db.mjs'

const SQL_DIR = 'tests/sql'
const filter = process.argv[2] ?? ''

// Shared fixtures are pulled in with
//
//     -- \include tests/fixtures/sql/fixtures.sql
//
// Paths are relative to the repo root. Includes may nest; a cycle is an error.
// Expansion happens before the transaction check, so an included file can't
// smuggle a COMMIT past it.
const INCLUDE_RE = /^[ \t]*--[ \t]*\\include[ \t]+(\S+)[ \t]*$/gm

export function expandIncludes (sql, from, seen = []) {
  return sql.replace(INCLUDE_RE, (_match, path) => {
    if (seen.includes(path)) {
      throw new Error(`circular \\include of ${path} (via ${seen.join(' -> ')})`)
    }
    let body
    try {
      body = readFileSync(path, 'utf8')
    } catch {
      throw new Error(`${from}: \\include cannot read ${path}`)
    }
    return expandIncludes(body, path, [...seen, path])
  })
}

// Replace comments, string literals, quoted identifiers and dollar-quoted
// bodies with a space, so the keyword scan sees only real SQL tokens. Without
// this, a plpgsql `begin ... end;` inside $$ ... $$ would trip the guard.
export function stripLiterals (sql) {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)

    const dollar = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
    if (dollar) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length)
      i = close === -1 ? sql.length : close + dollar[0].length
      out += ' '
      continue
    }
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      out += ' '
      continue
    }
    if (rest.startsWith('/*')) {
      let depth = 1 // Postgres block comments nest.
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql.startsWith('/*', j)) { depth++; j += 2 } else if (sql.startsWith('*/', j)) { depth--; j += 2 } else j++
      }
      i = j
      out += ' '
      continue
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue } // doubled = escaped
          j++
          break
        }
        j++
      }
      i = j
      out += ' '
      continue
    }
    out += sql[i]
    i++
  }
  return out
}

// Anything that can end or replace the runner's transaction. ROLLBACK TO
// SAVEPOINT is exempt: it unwinds to a savepoint without ending anything.
const TX_STATEMENT = /(^|[\s;)])(commit|rollback(?!\s+to\b)|abort|begin|start\s+transaction|prepare\s+transaction)\b/i
// END is a synonym for COMMIT but also closes CASE, so it only counts when it
// ends a statement. Fail-closed: alias a bare `case ... end;` ("end as x").
const TX_END = /(^|[\s;)])(end)\s*(;|$)/i

export function transactionEscape (sql) {
  const stripped = stripLiterals(sql)
  const match = stripped.match(TX_STATEMENT) ?? stripped.match(TX_END)
  return match ? match[2].toLowerCase().replace(/\s+/g, ' ') : null
}

// Remove the file's own `begin;` / `rollback;` wrapper, insisting it is really
// the first and last statement. Returns the body, or throws.
const WRAP_BEGIN = /^[ \t]*begin[ \t]*;[ \t]*$/im
const WRAP_ROLLBACK = /^[ \t]*rollback[ \t]*;[ \t]*$/gim

export function unwrap (sql) {
  const b = sql.match(WRAP_BEGIN)
  const rollbacks = [...sql.matchAll(WRAP_ROLLBACK)]
  const r = rollbacks[rollbacks.length - 1]
  if (!b || !r || r.index < b.index) {
    throw new Error('file must start with "begin;" and end with "rollback;", each on its own line')
  }
  const before = sql.slice(0, b.index)
  const after = sql.slice(r.index + r[0].length)
  if (stripLiterals(before).trim() !== '' || stripLiterals(after).trim() !== '') {
    throw new Error('"begin;" must be the first statement and "rollback;" the last')
  }
  return sql.slice(b.index + b[0].length, r.index)
}

function testFiles () {
  return readdirSync(SQL_DIR)
    .filter(f => f.endsWith('.sql'))
    .filter(f => f.includes(filter))
    .sort()
}

// pgTAP emits TAP lines as single text columns, across many result sets.
function tapLines (results) {
  const sets = Array.isArray(results) ? results : [results]
  const lines = []
  for (const set of sets) {
    for (const row of set.rows ?? []) {
      const value = Object.values(row)[0]
      if (typeof value === 'string') lines.push(...value.split('\n'))
    }
  }
  return lines
}

function summarise (lines) {
  const failures = []
  let assertions = 0
  let plan = null
  let pendingFailure = null
  for (const line of lines) {
    const planMatch = line.match(/^1\.\.(\d+)/)
    if (planMatch) { plan = Number(planMatch[1]); continue }
    if (/^ok\b/.test(line)) { assertions++; pendingFailure = null; continue }
    if (/^not ok\b/.test(line)) {
      assertions++
      pendingFailure = { line, diag: [] }
      failures.push(pendingFailure)
      continue
    }
    // pgTAP diagnostics ("#   have: ...") follow the failing line.
    if (pendingFailure && /^#/.test(line)) pendingFailure.diag.push(line)
  }
  return { assertions, plan, failures }
}

async function runFile (client, file) {
  let body
  try {
    const raw = expandIncludes(readFileSync(join(SQL_DIR, file), 'utf8'), file)
    body = unwrap(raw)
  } catch (err) {
    return { file, ok: false, assertions: 0, plan: null, failures: [], error: err.message }
  }

  // Static guard. A transaction-ending statement would defeat the rollback
  // below and write to the live project, so refuse to run the file at all.
  const escape = transactionEscape(body)
  if (escape) {
    return {
      file,
      ok: false,
      assertions: 0,
      plan: null,
      failures: [],
      error: `file contains a bare "${escape}" statement besides its begin;/rollback; wrapper. The runner owns the transaction and every test must roll back. (If this is a CASE expression, alias it, "end as x", so the guard can tell them apart.)`
    }
  }

  await client.query('begin')
  try {
    // Dynamic tripwire behind the text scan: if the file ended the transaction
    // by any means, the second read is in a new transaction with a new id.
    const { rows: [{ xid: before }] } = await client.query('select pg_current_xact_id()::text as xid')

    const results = await client.query(body)

    const { rows: [{ xid: after }] } = await client.query('select pg_current_xact_id()::text as xid')
    if (after !== before) {
      return {
        file,
        ok: false,
        assertions: 0,
        plan: null,
        failures: [],
        error: 'TRANSACTION ESCAPED: this file ended the runner\'s transaction, so its writes were committed. Find what it wrote and undo it before doing anything else.'
      }
    }

    const { assertions, plan, failures } = summarise(tapLines(results))
    let error = null
    if (plan === null) error = 'no TAP plan found; did the file call plan(n)?'
    else if (plan !== assertions) error = `plan said ${plan} assertions, ${assertions} ran`

    return { file, ok: failures.length === 0 && !error, assertions, plan, failures, error }
  } catch (err) {
    return { file, ok: false, assertions: 0, plan: null, failures: [], error: err.message }
  } finally {
    // Unconditional. This is the safety property.
    await client.query('rollback')
  }
}

async function main () {
  const files = testFiles()
  if (files.length === 0) {
    console.error(`No test files matched in ${SQL_DIR}/`)
    process.exit(1)
  }

  const client = await connect()
  const results = []
  try {
    // pgTAP lives in the extensions schema; put it on the path so tests can
    // call ok() / is() / throws_ok() unqualified.
    await client.query('set search_path = public, extensions')

    for (const file of files) {
      const result = await runFile(client, file)
      results.push(result)
      console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${file}  (${result.assertions} assertions)`)
      if (result.error) console.log(`      ${result.error}`)
      for (const failure of result.failures) {
        console.log(`      ${failure.line}`)
        for (const d of failure.diag) console.log(`        ${d}`)
      }
    }
  } finally {
    await client.end()
  }

  const failed = results.filter(r => !r.ok)
  const total = results.reduce((n, r) => n + r.assertions, 0)
  console.log(`\n${results.length - failed.length}/${results.length} files passed, ${total} assertions`)
  process.exit(failed.length === 0 ? 0 : 1)
}

// Run only when executed directly, so the helpers above can be imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
