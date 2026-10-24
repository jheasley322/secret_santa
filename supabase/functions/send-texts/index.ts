// send-texts Edge Function entry point. The only file that reads the
// environment, creates supabase clients or calls fetch. All the rules live in
// handler.ts and core.ts, which are tested with fakes.
//
// Settings (Supabase Edge Function secrets, set by Joe only):
//   TEXTS_DRY_RUN        only "false" sends for real. Missing = dry run.
//   TEXT_LINKS_APPROVED  only "true" allows real texts with links. Missing = refused.
//   APP_BASE_URL         base for member links (default https://jheasley322.github.io/secret_santa)
//   TEXTBELT_KEY         needed only for real sends. Never logged or returned.
//   ELF_USER_IDS         comma-separated auth user ids of approved Elves (spec S2).
//                        Missing or empty = nobody may use this function.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handle, type ClaimResult, type Deps } from './handler.ts'
import { makeTextbeltProvider } from './provider.ts'

const env = (name: string) => Deno.env.get(name) ?? undefined

Deno.serve(async (req: Request) => {
  const settings = {
    TEXTS_DRY_RUN: env('TEXTS_DRY_RUN'), TEXT_LINKS_APPROVED: env('TEXT_LINKS_APPROVED'),
    APP_BASE_URL: env('APP_BASE_URL'), ELF_USER_IDS: env('ELF_USER_IDS')
  }
  const url = env('SUPABASE_URL') as string
  const anonKey = env('SUPABASE_ANON_KEY') as string
  // The handler decides "not set up" from provider.configured, after auth (spec S4).
  const textbeltKey = env('TEXTBELT_KEY')

  const authorization = req.headers.get('authorization')
  // The Elf's own client: RLS decides which circles they can see.
  const asElf = () => createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization ?? '' } }
  })
  // The service-role client is created lazily, only after the JWT, the
  // ELF_USER_IDS allow-list and ownership checks pass (the handler calls
  // getUserId, then getCircle through the Elf's own client, first).
  let service: SupabaseClient | null = null
  const svc = () => service ??= createClient(url, env('SUPABASE_SERVICE_ROLE_KEY') as string, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  const deps: Deps = {
    env: settings,
    provider: makeTextbeltProvider({ key: textbeltKey, fetch: (u, i) => fetch(u, i) }),
    async getUserId (header) {
      if (!header || !/^Bearer\s+\S+$/i.test(header)) return null
      const { data, error } = await asElf().auth.getUser(header.replace(/^Bearer\s+/i, ''))
      return error || !data?.user ? null : data.user.id
    },
    db: {
      async getCircle (id) {
        const { data, error } = await asElf().from('circles')
          .select('id, elf_id, name, budget, swap_date, swap_place, status').eq('id', id).maybeSingle()
        if (error) throw new Error('could not read the circle')
        return data
      },
      async getMembers (circleId) {
        const { data, error } = await svc().from('members')
          .select('id, circle_id, first_name, phone, token').eq('circle_id', circleId).order('first_name')
        if (error) throw new Error('could not read members')
        return data ?? []
      },
      async getMatches (circleId) {
        const { data, error } = await svc().from('matches').select('giver_id, receiver_id').eq('circle_id', circleId)
        if (error) throw new Error('could not read matches')
        return data ?? []
      },
      async getTexts (circleId) {
        // This circle's members' rows only: the rate limit and duplicate-invite
        // pre-checks. (The cap no longer counts rows: spec S1.) claim_texts
        // re-checks both under the circle lock.
        const { data: ms, error: me } = await svc().from('members').select('id').eq('circle_id', circleId)
        if (me) throw new Error('could not read members')
        const ids = (ms ?? []).map((m: { id: string }) => m.id)
        if (ids.length === 0) return []
        const out = []
        for (let from = 0; ; from += 1000) {
          const { data, error } = await svc().from('texts')
            .select('member_id, kind, status, dry_run, quota_remaining, created_at')
            .in('member_id', ids).order('created_at').range(from, from + 999)
          if (error) throw new Error('could not read texts')
          out.push(...(data ?? []))
          if (!data || data.length < 1000) return out
        }
      },
      async getBudget () {
        const { data, error } = await svc().rpc('text_budget_state')
        // No readable budget means no real sends.
        if (error || !data || typeof data.cap !== 'number' || typeof data.used !== 'number') {
          throw new Error('could not read the text budget')
        }
        return { cap: data.cap, used: data.used, last_quota: typeof data.last_quota === 'number' ? data.last_quota : null }
      },
      async claimTexts (a) {
        const { data, error } = await svc().rpc('claim_texts', {
          p_circle_id: a.circle_id, p_kind: a.kind, p_member_ids: a.member_ids, p_dry_run: a.dry_run, p_resend: a.resend
        })
        if (error || !data || typeof data !== 'object') throw new Error('could not claim texts')
        return data as ClaimResult
      },
      async finishText (textId, patch) {
        // pending -> sent / failed, exactly once per row.
        const { data, error } = await svc().from('texts').update(patch)
          .eq('id', textId).eq('status', 'pending').select('id')
        // Stop the batch: the row stays pending, which keeps it counted.
        if (error || (data ?? []).length !== 1) throw new Error('could not log a text')
      },
      async recordQuota (quota) {
        const { error } = await svc().rpc('record_text_quota', { p_quota: quota })
        if (error) throw new Error('could not record the text quota')
      },
      async lockCircleSent (id) {
        // claim_texts already moved drawn -> sent in the claim's transaction;
        // this confirms it before the first reveal leaves.
        const { data, error } = await svc().from('circles').select('status').eq('id', id).maybeSingle()
        if (error) throw new Error('could not read the circle')
        return data?.status === 'sent'
      }
    }
  }
  return handle(req, deps)
})
