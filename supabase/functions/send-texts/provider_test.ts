// PROV-01..05: the Textbelt provider (provider.ts), the one small function that
// talks to the texting service. Spec: "Texting" ("Swappable. The provider call is
// about 10 lines"), "The API key ... never appears in the browser or the repo".
//
// SAFETY: fetch is ALWAYS injected. These tests hand the provider a fake fetch
// that records the request and returns a canned reply; the suite also runs with
// --deny-net. The key below is a fake string, not a Textbelt key.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from './test_assert.ts'
import { load } from './test_fakes.ts'

const FAKE_KEY = 'fake-key-for-tests-only'

function fakeFetch (reply: { status?: number; body: string } | 'throw') {
  const calls: { url: string; init: any }[] = []
  const fn = async (url: string | URL, init?: any) => {
    calls.push({ url: String(url), init })
    if (reply === 'throw') throw new Error('network down')
    return new Response(reply.body, { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

async function formOf (init: any): Promise<URLSearchParams> {
  const body = init?.body
  if (body instanceof URLSearchParams) return body
  if (typeof body === 'string') {
    try { return new URLSearchParams(Object.entries(JSON.parse(body)) as any) } catch { return new URLSearchParams(body) }
  }
  if (body instanceof FormData) return new URLSearchParams(body as any)
  return new URLSearchParams()
}

Deno.test('PROV-01 one POST to textbelt.com/text with phone, message and key', async () => {
  const { makeTextbeltProvider } = await load('./provider.ts')
  const f = fakeFetch({ body: JSON.stringify({ success: true, textId: '123', quotaRemaining: 44 }) })
  const p = makeTextbeltProvider({ key: FAKE_KEY, fetch: f.fn })
  const r = await p.send('+15555550101', 'hello there')
  assertEquals(f.calls.length, 1, 'exactly one request')
  assertEquals(f.calls[0].url, 'https://textbelt.com/text')
  assertEquals((f.calls[0].init?.method ?? '').toUpperCase(), 'POST')
  const form = await formOf(f.calls[0].init)
  assertEquals(form.get('phone'), '+15555550101')
  assertEquals(form.get('message'), 'hello there')
  assertEquals(form.get('key'), FAKE_KEY)
  assertEquals(r.success, true)
  assertEquals(String(r.textId), '123')
  assertEquals(r.quotaRemaining, 44)
})

Deno.test('PROV-02 a missing or empty key never calls fetch', async () => {
  const { makeTextbeltProvider } = await load('./provider.ts')
  for (const key of [undefined, '', '   ']) {
    const f = fakeFetch({ body: '{"success":true}' })
    let threw = false
    let r: any = null
    try {
      const p = makeTextbeltProvider({ key, fetch: f.fn })
      r = await p.send('+15555550101', 'hi')
    } catch { threw = true }
    assertEquals(f.calls.length, 0, `key ${JSON.stringify(key)}: fetch must not be called`)
    assert(threw || r?.success === false, `key ${JSON.stringify(key)}: must not report success`)
  }
})

Deno.test('PROV-03 a Textbelt refusal comes back as success false with its error', async () => {
  const { makeTextbeltProvider } = await load('./provider.ts')
  const f = fakeFetch({ body: JSON.stringify({ success: false, error: 'Out of quota', quotaRemaining: 0 }) })
  const r = await makeTextbeltProvider({ key: FAKE_KEY, fetch: f.fn }).send('+15555550101', 'hi')
  assertEquals(r.success, false)
  assertEquals(r.error, 'Out of quota')
  assertEquals(r.quotaRemaining, 0)
})

Deno.test('PROV-04 an HTTP error or a non-JSON reply is never reported as success', async () => {
  const { makeTextbeltProvider } = await load('./provider.ts')
  for (const reply of [{ status: 500, body: 'oops' }, { status: 200, body: '<html>' }, 'throw'] as const) {
    const f = fakeFetch(reply as any)
    let r: any = null
    try { r = await makeTextbeltProvider({ key: FAKE_KEY, fetch: f.fn }).send('+15555550101', 'hi') } catch { r = { success: false } }
    assertEquals(r.success, false, JSON.stringify(reply))
  }
})

Deno.test('PROV-05 the key never appears in what the provider returns', async () => {
  const { makeTextbeltProvider } = await load('./provider.ts')
  for (const reply of [
    { body: JSON.stringify({ success: false, error: `bad key ${FAKE_KEY}` }) },
    { status: 500, body: `server echoed ${FAKE_KEY}` }
  ]) {
    const f = fakeFetch(reply)
    let out = ''
    try { out = JSON.stringify(await makeTextbeltProvider({ key: FAKE_KEY, fetch: f.fn }).send('+15555550101', 'hi')) } catch (e) { out = String((e as Error).message) }
    assert(!out.includes(FAKE_KEY), `the key leaked: ${out}`)
  }
})
