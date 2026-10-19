// The one Supabase client for the site. supabase-js comes from a pinned CDN
// version (no build step).
//
// The publishable key is meant to be public: the database (RLS + SECURITY
// DEFINER functions) is the only security boundary. Never put the service-role
// key or the Textbelt key here.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm'

export const SUPABASE_URL = 'https://hnnzoiuibnikrucncphu.supabase.co'

// >>> Joe: paste the project's publishable key here (Dashboard -> Project
// Settings -> API Keys -> Publishable key). It starts with "sb_publishable_".
export const SUPABASE_PUBLISHABLE_KEY = 'PASTE_PUBLISHABLE_KEY_HERE'

/** Base of every member link: {APP_BASE_URL}/m/#<token>. Same value as the Edge Function's APP_BASE_URL. */
export const APP_BASE_URL = 'https://jheasley322.github.io/secret_santa'

export const SEND_TEXTS_URL = `${SUPABASE_URL}/functions/v1/send-texts`

export const isConfigured = !SUPABASE_PUBLISHABLE_KEY.startsWith('PASTE_')

// Default storage (localStorage key sb-hnnzoiuibnikrucncphu-auth-token) and
// detectSessionInUrl, so the magic link signs the Elf in when it opens the page.
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
