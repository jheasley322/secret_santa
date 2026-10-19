// Circle dashboard for the Elf: details, kids (name + mobile), text status,
// Send invites / Re-send / Copy link, and the wish-list progress checklist.
// Draw, Shuffle again and Send the names come in Phase 4.
//
// Text status comes from the `texts` table, never from a button having been
// tapped (frontend rule 6). Hiding a button is cosmetic: RLS and the
// send-texts function are what actually enforce the rules.

import { APP_BASE_URL, SEND_TEXTS_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured, supabase } from './supabaseClient.js'
import { requireElf } from './auth.js'
import { circleFacts, memberLink } from './format.js'
import { formatPhone, normalizePhone } from './phone.js'
import { busy, fieldError, h, notify } from './ui.js'

const $ = id => document.getElementById(id)
const circleId = new URLSearchParams(location.search).get('id') ?? ''
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let circle = null
let members = []
let texts = []

// ------------------------------------------------------------------ loading
function showNotFound () {
  $('circle-view').hidden = true
  $('not-found').hidden = false
  $('circle-name').textContent = 'Secret Santa'
  $('circle-sub').textContent = 'You are the Elf'
  $('facts').replaceChildren()
}

async function load () {
  if (!UUID.test(circleId)) return showNotFound()
  // RLS: another Elf's circle simply isn't there, so it reads as "not found".
  const { data, error } = await supabase.from('circles')
    .select('id, name, budget, swap_date, swap_place, status').eq('id', circleId).maybeSingle()
  if (error && !data) {
    notify('bad', "Couldn't load this circle. Check your connection and reload the page.")
    return
  }
  if (!data) return showNotFound()
  circle = data
  await loadMembers()
  await loadTexts()
  render()
}

async function loadMembers () {
  const { data, error } = await supabase.from('members')
    .select('id, first_name, phone, token, list_done').eq('circle_id', circleId).order('first_name')
  if (error) { notify('bad', "Couldn't load the kids in this circle. Reload the page to try again."); return }
  members = data
}

async function loadTexts () {
  const ids = members.map(m => m.id)
  if (ids.length === 0) { texts = []; return }
  const { data, error } = await supabase.from('texts')
    .select('member_id, kind, status, dry_run, error, created_at').in('member_id', ids).order('created_at')
  if (error) { notify('bad', "Couldn't load text status. Reload the page to try again."); return }
  texts = data
}

// ------------------------------------------------------------------ render
function render () {
  $('not-found').hidden = true
  $('circle-view').hidden = false
  document.title = `${circle.name} - Secret Santa`
  $('circle-name').textContent = circle.name
  $('circle-sub').textContent = circle.status === 'sent'
    ? 'You are the Elf. The names have been sent.'
    : circle.status === 'drawn' ? 'You are the Elf. Names drawn; nobody has been told yet.' : 'You are the Elf'
  $('facts').replaceChildren(...circleFacts(circle).map(f => h('span', { class: 'fact' }, f)))

  const open = circle.status === 'open'
  $('add-card').hidden = !open
  $('locked-note').hidden = open
  $('invite-box').hidden = circle.status === 'sent' || members.length === 0

  renderProgress()
  renderMembers()
  fillDetails()
}

function renderProgress () {
  const done = members.filter(m => m.list_done).length
  const total = members.length
  const label = `${done} of ${total} done`
  $('progress').hidden = total === 0
  $('progress-text').textContent = label
  $('progress-meter').setAttribute('aria-label', label)
  // CSSOM, not a style attribute.
  $('progress-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
}

/** The latest text of the kind that matters right now: invites before the names are sent, reveals after. */
function latestText (memberId) {
  const kind = circle.status === 'sent' ? 'reveal' : 'invite'
  let last = null
  for (const t of texts) if (t.member_id === memberId && t.kind === kind) last = t
  return last
}

function textPill (m) {
  const t = latestText(m.id)
  if (!m.phone) return h('span', { class: 'pill pill--warn' }, h('span', { 'aria-hidden': 'true' }, '⚠'), ' No number')
  if (!t) return h('span', { class: 'pill pill--warn' }, h('span', { 'aria-hidden': 'true' }, '⌛'), ' Not sent yet')
  if (t.status === 'failed') return h('span', { class: 'pill pill--bad' }, h('span', { 'aria-hidden': 'true' }, '⚠'), ' Text failed')
  // A dry run didn't really text anyone, so say so.
  return h('span', { class: 'pill pill--ok' }, h('span', { 'aria-hidden': 'true' }, '✓'),
    t.dry_run ? ' Text sent (practice run)' : ' Text sent')
}

function renderMembers () {
  const list = $('member-list')
  const open = circle.status === 'open'
  list.replaceChildren(...members.map(m => {
    const t = latestText(m.id)
    return h('li', { class: `check-row ${m.list_done ? 'is-done' : 'is-todo'}`, 'data-test': 'member-row', 'data-member-id': m.id },
      h('span', { class: 'check-row__icon', 'aria-hidden': 'true' }, m.list_done ? '✓' : '✗'),
      h('div', {},
        h('div', { class: 'check-row__name' }, m.first_name, ' ',
          h('span', { class: 'visually-hidden' }, m.list_done ? 'list is done' : 'list not done yet')),
        h('div', { class: 'check-row__meta' }, textPill(m),
          m.phone ? h('span', { class: 'muted' }, formatPhone(m.phone)) : null),
        t?.status === 'failed' && t.error ? h('div', { class: 'muted' }, `Reason: ${t.error}`) : null),
      h('div', { class: 'check-row__actions' },
        h('button', { class: 'btn btn--small', type: 'button', disabled: !m.phone, onclick: e => resend(e.currentTarget, m) }, 'Re-send'),
        h('button', { class: 'btn btn--small btn--quiet', type: 'button', onclick: () => copyLink(m) }, 'Copy link'),
        open ? h('button', { class: 'btn btn--small btn--quiet', type: 'button', onclick: e => removeMember(e.currentTarget, m) }, 'Remove') : null))
  }))
  list.hidden = members.length === 0
  $('no-members').hidden = members.length > 0
}

function fillDetails () {
  $('e-name').value = circle.name
  $('e-budget').value = circle.budget ?? ''
  $('e-date').value = circle.swap_date ?? ''
  $('e-place').value = circle.swap_place ?? ''
}

// ------------------------------------------------------------------ texting
async function callSendTexts (body) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) { location.replace('index.html'); return null }
  let res
  try {
    res = await fetch(SEND_TEXTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify(body)
    })
  } catch {
    notify('bad', "Couldn't reach the texting service. Check your connection and try again.")
    return null
  }
  let json = null
  try { json = await res.json() } catch { /* not JSON */ }
  if (!res.ok) {
    notify('bad', `Texts not sent: ${json?.error ?? `something went wrong (HTTP ${res.status})`}.`)
    return null
  }
  return json
}

function summarize (r) {
  const parts = []
  if (r.dry_run) parts.push(`Practice run: ${r.sent} text${r.sent === 1 ? '' : 's'} logged, nothing was really sent.`)
  else parts.push(`${r.sent} text${r.sent === 1 ? '' : 's'} sent.`)
  if (r.failed) parts.push(`${r.failed} failed. Tap Re-send on those kids to try again.`)
  const skipped = (r.results ?? []).filter(x => x.status === 'skipped')
  if (skipped.length) {
    const byId = new Map(members.map(m => [m.id, m.first_name]))
    parts.push(`Skipped: ${skipped.map(x => `${byId.get(x.member_id) ?? 'someone'} (${x.error ?? 'skipped'})`).join(', ')}.`)
  }
  return parts.join(' ')
}

async function afterSend (r) {
  if (!r) return
  notify(r.failed ? 'bad' : 'ok', summarize(r))
  // Status pills come from the table, not from the response.
  await loadTexts()
  render()
}

$('send-invites').addEventListener('click', e => busy(e.currentTarget, async () => {
  await afterSend(await callSendTexts({ circle_id: circleId, kind: 'invite' }))
}))

function resend (button, m) {
  return busy(button, async () => {
    const kind = circle.status === 'sent' ? 'reveal' : 'invite'
    await afterSend(await callSendTexts({ circle_id: circleId, kind, member_id: m.id }))
  })
}

async function copyLink (m) {
  const link = memberLink(APP_BASE_URL, m.token)
  try {
    await navigator.clipboard.writeText(link)
    notify('ok', `Copied ${m.first_name}'s link. Paste it into a message to them.`)
  } catch {
    // Clipboard blocked: show the link so it can be copied by hand.
    const n = notify('info', `${m.first_name}'s link: `)
    n.querySelector('.notice__text').append(h('input', { class: 'input', readonly: true, value: link, 'aria-label': `${m.first_name}'s link` }))
  }
}

// ------------------------------------------------------------------ members
$('add-member').addEventListener('submit', e => {
  e.preventDefault()
  const nameInput = $('m-name')
  const phoneInput = $('m-phone')
  const name = nameInput.value.trim()
  const phone = normalizePhone(phoneInput.value)
  let ok = true
  if (!name) { fieldError(nameInput, 'Type their first name.'); ok = false } else fieldError(nameInput, null)
  if (!phone) { fieldError(phoneInput, 'That doesn\'t look like a mobile number. Try (555) 555-0101.'); ok = false } else fieldError(phoneInput, null)
  if (!ok) { (name ? phoneInput : nameInput).focus(); return }

  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    const { error } = await supabase.from('members').insert({ circle_id: circleId, first_name: name, phone })
    if (error) {
      if (error.code === '23505') fieldError(nameInput, `There's already a ${name} in this circle. Add a last initial, like ${name} B.`)
      else if (/locked/.test(error.message ?? '')) notify('bad', 'The names are drawn, so kids can\'t be added now.')
      else notify('bad', "Couldn't add that kid. Check the name and number and try again.")
      return
    }
    nameInput.value = ''
    phoneInput.value = ''
    await loadMembers()
    await loadTexts()
    render()
    nameInput.focus()
  })
})

for (const id of ['m-name', 'm-phone']) $(id).addEventListener('input', e => fieldError(e.target, null))

function removeMember (button, m) {
  if (!confirm(`Remove ${m.first_name} from the circle? Their wish list is deleted too.`)) return
  return busy(button, async () => {
    const { error } = await supabase.from('members').delete().eq('id', m.id)
    if (error) { notify('bad', `Couldn't remove ${m.first_name}. ${/locked/.test(error.message ?? '') ? 'The names are already drawn.' : 'Try again.'}`); return }
    await loadMembers()
    await loadTexts()
    render()
  })
}

// ------------------------------------------------------------------ details
$('edit-circle').addEventListener('submit', e => {
  e.preventDefault()
  const name = $('e-name')
  const budget = $('e-budget')
  const b = budget.value.trim()
  let ok = true
  if (!name.value.trim()) { fieldError(name, 'Give the circle a name.'); ok = false } else fieldError(name, null)
  if (b !== '' && !/^\d+$/.test(b)) { fieldError(budget, 'Use whole dollars, like 20.'); ok = false } else fieldError(budget, null)
  if (!ok) return
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    const changes = {
      name: name.value.trim(),
      budget: b === '' ? null : Number(b),
      swap_date: $('e-date').value || null,
      swap_place: $('e-place').value.trim() || null
    }
    const { data, error } = await supabase.from('circles').update(changes).eq('id', circleId)
      .select('id, name, budget, swap_date, swap_place, status').single()
    if (error) { notify('bad', "Couldn't save the details. Try again."); return }
    circle = data
    render()
    notify('ok', 'Details saved.')
  })
})

// ------------------------------------------------------------------ start
if (!isConfigured) notify('bad', 'Setup needed: the publishable key has not been added to js/supabaseClient.js yet.')
if (await requireElf()) await load()
