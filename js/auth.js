// The Elf's session. Members never sign in; their link is their login.

import { supabase } from './supabaseClient.js'

export async function getSession () {
  const { data } = await supabase.auth.getSession()
  return data?.session ?? null
}

/**
 * Send the Elf an email magic link that brings them back to the home page.
 * Sign-ups are off: an unknown address never creates an account. That case
 * resolves quietly (same as success) so the page can't reveal who is an Elf.
 */
export async function sendMagicLink (email) {
  const back = new URL('index.html', location.href).href
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: back, shouldCreateUser: false } })
  if (error && !isUnknownUser(error)) throw error
}

function isUnknownUser (error) {
  return error.code === 'otp_disabled' || error.code === 'signup_disabled' ||
    (error.status === 422 && /signup|sign-up|not allowed/i.test(error.message ?? ''))
}

export async function signOut () {
  await supabase.auth.signOut()
}

/** For Elf-only pages: the session, or a redirect to the sign-in page. */
export async function requireElf () {
  const session = await getSession()
  if (!session) {
    location.replace('index.html')
    return null
  }
  return session
}
