// The Textbelt provider: the only code that knows the texting service.
// spec "Texting": "Swappable. The provider call is about 10 lines", so a Twilio
// version would replace just this file.
//
// fetch is injected (index.ts passes the real one; tests pass a fake), and the
// key comes from index.ts, which reads TEXTBELT_KEY. The key is never logged or
// returned, even if Textbelt echoes it back.

export interface SendResult { success: boolean; textId?: string; quotaRemaining?: number; error?: string }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export function makeTextbeltProvider ({ key, fetch }: { key?: string; fetch: Fetch }) {
  const scrub = (s: unknown) => String(s ?? '').split(key || '\u0000').join('[hidden]').slice(0, 200)
  return {
    /** spec S4: true only when a non-blank key is set. The key itself is never exposed. */
    configured: Boolean(key && key.trim()),
    async send (phone: string, message: string): Promise<SendResult> {
      if (!key || !key.trim()) return { success: false, error: 'texting is not set up' }
      let res: Response
      try {
        res = await fetch('https://textbelt.com/text', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ phone, message, key })
        })
      } catch {
        return { success: false, error: 'could not reach the texting service' }
      }
      // deno-lint-ignore no-explicit-any
      let json: any
      try { json = await res.json() } catch { json = null }
      if (!res.ok || !json || typeof json !== 'object') return { success: false, error: `texting service error (HTTP ${res.status})` }
      return {
        success: json.success === true,
        textId: json.textId == null ? undefined : String(json.textId),
        quotaRemaining: typeof json.quotaRemaining === 'number' ? json.quotaRemaining : undefined,
        error: json.success === true ? undefined : scrub(json.error || 'send failed')
      }
    }
  }
}
