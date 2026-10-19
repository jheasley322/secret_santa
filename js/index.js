// Home page: sign in (email magic link), my circles, start a new circle.

import { supabase, isConfigured } from './supabaseClient.js'
import { getSession, sendMagicLink, signOut } from './auth.js'
import { circleFacts } from './format.js'
import { busy, clearNotices, fieldError, h, notify } from './ui.js'

const $ = id => document.getElementById(id)

async function showSignedOut () {
  $('signed-in').hidden = true
  $('signed-out').hidden = false
}

async function showSignedIn (session) {
  $('signed-out').hidden = true
  $('signed-in').hidden = false
  $('who').textContent = session.user?.email ?? 'you'
  await loadCircles()
}

async function loadCircles () {
  // RLS returns only this Elf's circles.
  const { data, error } = await supabase.from('circles')
    .select('id, name, budget, swap_date, swap_place, status, created_at')
    .order('created_at', { ascending: false })
  if (error) {
    notify('bad', "Couldn't load your circles. Check your connection and reload the page.")
    return
  }
  const list = $('circle-list')
  list.replaceChildren(...data.map(c => h('li', { class: 'check-row is-done' },
    h('span', { class: 'check-row__icon', 'aria-hidden': 'true' }, '★'),
    h('div', {},
      h('div', { class: 'check-row__name' }, h('a', { href: `circle.html?id=${encodeURIComponent(c.id)}` }, c.name)),
      h('div', { class: 'check-row__meta muted' }, [...circleFacts(c), statusWords(c.status)].join(' · '))))))
  list.hidden = data.length === 0
  $('no-circles').hidden = data.length > 0
}

function statusWords (status) {
  return status === 'sent' ? 'Names sent' : status === 'drawn' ? 'Names drawn' : 'Open'
}

$('sign-in').addEventListener('submit', e => {
  e.preventDefault()
  const input = $('email')
  const email = input.value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fieldError(input, 'Enter your email address, like name@example.com.')
    input.focus()
    return
  }
  fieldError(input, null)
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    try {
      await sendMagicLink(email)
      clearNotices()
      notify('ok', `Check your email. We sent a sign-in link to ${email}.`)
    } catch {
      notify('bad', "Couldn't send the sign-in link. Wait a minute and try again.")
    }
  })
})

$('create-circle').addEventListener('submit', e => {
  e.preventDefault()
  const name = $('c-name')
  const budget = $('c-budget')
  let ok = true
  if (!name.value.trim()) { fieldError(name, 'Give the circle a name.'); ok = false } else fieldError(name, null)
  const b = budget.value.trim()
  if (b !== '' && !/^\d+$/.test(b)) { fieldError(budget, 'Use whole dollars, like 20.'); ok = false } else fieldError(budget, null)
  if (!ok) return
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    const row = {
      name: name.value.trim(),
      budget: b === '' ? null : Number(b),
      swap_date: $('c-date').value || null,
      swap_place: $('c-place').value.trim() || null
    }
    const { data, error } = await supabase.from('circles').insert(row).select('id').single()
    if (error) {
      notify('bad', "Couldn't create the circle. Check the details and try again.")
      return
    }
    location.href = `circle.html?id=${encodeURIComponent(data.id)}`
  })
})

$('sign-out').addEventListener('click', async () => {
  await signOut()
  clearNotices()
  showSignedOut()
})

if (!isConfigured) {
  notify('bad', 'Setup needed: the publishable key has not been added to js/supabaseClient.js yet.')
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session && $('signed-in').hidden) showSignedIn(session)
})

const session = await getSession()
if (session) showSignedIn(session)
else showSignedOut()
