// Minimal assertions for the send-texts tests. Kept local (no jsr:/npm: import)
// so the suite needs no download and runs with --deny-net.

// deno-lint-ignore-file no-explicit-any

function show (v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function deepEqual (a: any, b: any): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => deepEqual(a[k], b[k]))
}

export function assert (cond: unknown, msg = 'assertion failed'): asserts cond {
  if (!cond) throw new Error(msg)
}

export function assertEquals (actual: unknown, expected: unknown, msg = '') {
  if (!deepEqual(actual, expected)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`)
  }
}

export function assertMatch (actual: string, re: RegExp, msg = '') {
  if (typeof actual !== 'string' || !re.test(actual)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${show(actual)} to match ${re}`)
  }
}

export function assert4xx (status: number, msg = '') {
  if (!(status >= 400 && status < 500)) throw new Error(`${msg ? msg + ': ' : ''}expected a 4xx refusal, got HTTP ${status}`)
}
