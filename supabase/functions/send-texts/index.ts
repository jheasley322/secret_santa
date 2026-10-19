// send-texts Edge Function entry point. The only file that reads the
// environment, creates supabase clients or calls fetch. All the rules live in
// handler.ts and core.ts, which are tested with fakes.
//
// Settings (Supabase Edge Function secrets, set by Joe only):
//   TEXTS_DRY_RUN        only "false" sends for real. Missing = dry run.
//   TEXT_LINKS_APPROVED  only "true" allows real texts with links. Missing = refused.
//   APP_BASE_URL         base for member links (default https://jheasley322.github.io/secret_santa)
//   TEXTBELT_KEY         needed only for real sends. Never logged or returned.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { CORS, handle, type Deps } from './handler.ts'
import { readSettings } from './core.ts'
import { makeTextbeltProvider } from './provider.ts'

const env = (name: string) => Deno.env.get(name) ?? undefined

Deno.serve(async (req: Request) => {
  const settings = { TEXTS_DRY_RUN: env('TEXTS_DRY_RUN'), TEXT_LINKS_APPROVED: env('TEXT_LINKS_APPROVED'), APP_BASE_URL: env('APP_BASE_URL') }
  const url = env('SUPABASE_URL') as string
  const anonKey = env('SUPABASE_ANON_KEY') as string
  const textbeltKey = env('TEXTBELT_KEY')

  // Real mode without a key would log failed "real" rows that count against
  // the cap without spending anything. Refuse up front instead.
  if (req.method === 'POST' && !readSettings(settings).dryRun && !textbeltKey) {
    return new Response(JSON.stringify({ error: 'texting is not set up yet' }), {
      status: 503, headers: { ...CORS, 'content-type': 'application/json' }
    })
  }

  const authorization = req.headers.get('authorization')
  // The Elf's own client: RLS decides which circles they can see.
  const asElf = () => createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization ?? '' } }
  })
  // The service-role client is created only after the JWT and ownership checks
  // pass (the handler calls getUserId and getCircle first).
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
      async getTexts () {
        // Every row, all circles: the cap is lifetime. Paged past PostgREST's row limit.
        const out = []
        for (let from = 0; ; from += 1000) {
          const { data, error } = await svc().from('texts')
            .select('member_id, kind, status, dry_run, quota_remaining, created_at')
            .order('created_at').range(from, from + 999)
          if (error) throw new Error('could not read texts')
          out.push(...(data ?? []))
          if (!data || data.length < 1000) return out
        }
      },
      async getCap () {
        const { data, error } = await svc().rpc('text_budget_cap')
        // No readable cap means no real sends.
        if (error || typeof data !== 'number') throw new Error('could not read the text budget')
        return data
      },
      async insertText (row) {
        const { error } = await svc().from('texts').insert(row)
        // Stop the batch: an unlogged real send would escape the cap.
        if (error) throw new Error('could not log a text')
      },
      async lockCircleSent (id) {
        const { data, error } = await svc().from('circles')
          .update({ status: 'sent' }).eq('id', id).eq('status', 'drawn').select('id')
        if (error) throw new Error('could not lock the circle')
        return (data ?? []).length === 1
      }
    }
  }
  return handle(req, deps)
})
