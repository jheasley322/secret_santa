// Circle dashboard for the Elf: details, kids (name + mobile), text status,
// Send invites / Re-send / Copy link, and the wish-list progress checklist.
// Phase 4: Draw names, Shuffle again, Undo draw, Show matches, Send the names.
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
let matches = []
let noPairs = []
let practice = false
let sendResults = []

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
  await loadMatches()
  await loadNoPairs()
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
  // Practice mode: the circle's newest text was a dry run (S6).
  practice = data.length > 0 && data[data.length - 1].dry_run === true
}

/** The Elf may read matches. Only fetched once names are drawn (Show matches is still off by default). */
async function loadMatches () {
  if (circle.status === 'open') { matches = []; return }
  const { data, error } = await supabase.from('matches').select('giver_id, receiver_id, opened_at').eq('circle_id', circleId)
  if (error) { notify('bad', "Couldn't load the draw. Reload the page to try again."); return }
  matches = data
}

async function loadNoPairs () {
  const { data, error } = await supabase.from('no_pairs').select('member_a, member_b').eq('circle_id', circleId)
  if (error) { notify('bad', "Couldn't load the never-pair list. Reload the page to try again."); return }
  noPairs = data
}

async function refresh () {
  const { data } = await supabase.from('circles')
    .select('id, name, budget, swap_date, swap_place, status').eq('id', circleId).maybeSingle()
  if (data) circle = data
  await loadMembers()
  await loadTexts()
  await loadMatches()
  await loadNoPairs()
  render()
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

  $('practice-banner').hidden = !practice
  renderDraw()
  renderNoPairs()
  renderProgress()
  renderMembers()
  fillDetails()
}

// ------------------------------------------------------------------ do-not-pair
let npOpen = false
let npErrorText = ''

function npSelect (id, label, keep) {
  const sel = h('select', { class: 'select', id, 'data-test': id === 'np-a' ? 'nopair-a' : 'nopair-b',
    onchange: () => { npErrorText = ''; const e = $('np-error'); if (e) { e.replaceChildren(); e.hidden = true } } },
    h('option', { value: '' }, 'Choose a kid'),
    ...members.map(m => h('option', { value: m.id }, m.first_name)))
  if (members.some(m => m.id === keep)) sel.value = keep
  return h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), sel)
}

function npError (msg) {
  npErrorText = msg ?? ''
  const el = $('np-error')
  if (!el) return
  el.replaceChildren(...(msg ? [h('span', { 'aria-hidden': 'true' }, '⚠'), ' ', msg] : []))
  el.hidden = !msg
}

/** Built fresh each time; absent (not just hidden) when the Elf has nothing to see. */
function renderNoPairs () {
  const mount = $('nopairs-mount')
  const open = circle.status === 'open'
  const keepA = $('np-a')?.value
  const keepB = $('np-b')?.value
  const rows = noPairs.filter(p => members.some(m => m.id === p.member_a) && members.some(m => m.id === p.member_b))
  if (!open && rows.length === 0) { mount.replaceChildren(); return }

  const list = h('ul', { class: 'pair-list', 'aria-label': 'Pairs that will not be drawn' },
    rows.map(p => h('li', { class: 'pair-row', 'data-test': 'nopair-row' },
      h('span', { class: 'pair-row__names' }, nameOf(p.member_a), h('span', { class: 'pair-row__x' }, '✕'), nameOf(p.member_b)),
      open ? h('button', { class: 'btn btn--small btn--quiet', type: 'button',
        'aria-label': `Remove the ${nameOf(p.member_a)} and ${nameOf(p.member_b)} pair`,
        onclick: e => removePair(e.currentTarget, p) }, 'Remove') : null)))
  list.hidden = rows.length === 0

  const form = open
    ? h('form', { id: 'np-form', novalidate: true, onsubmit: onPairSubmit },
      h('div', { class: 'field-grid' }, npSelect('np-a', 'First kid', keepA), npSelect('np-b', 'Second kid', keepB)),
      h('p', { class: 'field__error', id: 'np-error', 'data-test': 'nopair-error', role: 'alert', hidden: true }),
      h('button', { class: 'btn btn--secondary btn--block', type: 'submit' }, 'Add pair'))
    : null

  const details = h('details', { class: 'person-fold', id: 'nopairs', 'data-test': 'nopairs', open: npOpen },
    h('summary', {}, 'Never pair these two (optional)'),
    h('div', { class: 'stack-sm' },
      open ? h('p', { class: 'muted' }, 'Kids who must not draw each other, in either direction. Brothers and sisters, for example.') : null,
      list, form))
  details.addEventListener('toggle', () => { npOpen = details.open })
  mount.replaceChildren(h('section', { class: 'card' }, details))
  if (npErrorText) npError(npErrorText)
}

function onPairSubmit (e) {
  e.preventDefault()
  const a = $('np-a').value
  const b = $('np-b').value
  if (!a || !b) { npError('Pick two kids.'); return }
  if (a === b) { npError('Pick two different kids.'); return }
  // The table stores each pair once, smaller id first.
  const [member_a, member_b] = a < b ? [a, b] : [b, a]
  if (noPairs.some(p => p.member_a === member_a && p.member_b === member_b)) {
    npError('That pair is already on the list.'); return
  }
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    const { error } = await supabase.from('no_pairs').insert({ circle_id: circleId, member_a, member_b })
    if (error) {
      if (error.code === '23505') npError('That pair is already on the list.')
      else if (/locked/i.test(error.message ?? '')) npError("The names are drawn, so the list can't change now.")
      else npError("Couldn't add that pair. Try again.")
      return
    }
    npError(null)
    await loadNoPairs()
    renderNoPairs()
  })
}

function removePair (button, p) {
  return busy(button, async () => {
    const { error } = await supabase.from('no_pairs').delete()
      .eq('circle_id', circleId).eq('member_a', p.member_a).eq('member_b', p.member_b)
    if (error) { notify('bad', "Couldn't remove that pair. Try again."); return }
    await loadNoPairs()
    renderNoPairs()
  })
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

const nameOf = id => members.find(m => m.id === id)?.first_name ?? 'Someone'

function renderDraw () {
  const status = circle.status
  const card = $('draw-card')
  card.hidden = false
  const open = status === 'open'
  const drawn = status === 'drawn'
  const sent = status === 'sent'
  $('draw-btn').hidden = !open
  $('send-names').hidden = !drawn
  $('shuffle-btn').hidden = !drawn
  $('undo-btn').hidden = !drawn
  $('peek-box').hidden = open
  $('draw-title').textContent = open ? 'Draw the names' : drawn ? 'Send the names' : 'Names sent'

  const intro = $('draw-intro')
  intro.replaceChildren()
  if (open) intro.textContent = 'When every wish list is done, draw the names. Nobody is told until you send them.'
  else if (drawn) intro.textContent = 'You can shuffle as often as you like. Once you send the names, the draw is final.'
  else intro.textContent = 'Names have already been sent.'

  // Draw rules (the database enforces them too; this only explains).
  const reason = $('draw-reason')
  const notDone = members.filter(m => !m.list_done).map(m => m.first_name)
  const why = []
  if (members.length < 3) why.push('You need at least 3 kids to draw names.')
  if (notDone.length) why.push(`Every list must be done first. Waiting for ${notDone.join(', ')}.`)
  reason.hidden = !open || why.length === 0
  reason.textContent = why.join(' ')
  $('draw-btn').disabled = why.length > 0

  const results = $('send-results')
  results.replaceChildren(...sendResults.map(r => h('li', { class: 'check-row', 'data-test': 'send-result', 'data-member-id': r.member_id },
    h('span', { class: 'check-row__icon', 'aria-hidden': 'true' }, r.status === 'sent' ? '✓' : '⚠'),
    h('div', {}, h('div', { class: 'check-row__name' }, `${nameOf(r.member_id)}: ${r.status}`),
      r.error ? h('div', { class: 'muted' }, r.error) : null))))
  results.hidden = sendResults.length === 0
  renderPeek()
}

function renderPeek () {
  const list = $('match-list')
  const on = $('show-matches').checked && circle.status !== 'open'
  list.replaceChildren(...(on ? matches.map(x => h('li', { 'data-test': 'match-row' }, `${nameOf(x.giver_id)} → ${nameOf(x.receiver_id)}`)) : []))
  list.hidden = !on
}
$('show-matches').addEventListener('change', renderPeek)

$('draw-btn').addEventListener('click', e => busy(e.currentTarget, () => drawAction('start_draw')))
$('shuffle-btn').addEventListener('click', e => busy(e.currentTarget, () => drawAction('reshuffle')))
$('undo-btn').addEventListener('click', e => busy(e.currentTarget, async () => {
  if (await drawAction('undo_draw')) $('show-matches').checked = false
}))

async function drawAction (fn) {
  sendResults = []
  const { error } = await supabase.rpc(fn, { p_circle_id: circleId })
  if (error) notify('bad', error.message || "That didn't work. Try again.")
  await refresh()
  return !error
}

const dlg = $('confirm-send')
$('send-names').addEventListener('click', () => {
  $('cs-practice').hidden = !practice
  dlg.showModal()
})
$('cs-cancel').addEventListener('click', () => dlg.close())
$('cs-ok').addEventListener('click', e => busy(e.currentTarget, async () => {
  dlg.close()
  const r = await callSendTexts({ circle_id: circleId, kind: 'reveal' })
  if (r) sendResults = r.results ?? []
  await afterSend(r)
}))

function openedPill (m) {
  if (circle.status !== 'sent') return null
  const x = matches.find(k => k.giver_id === m.id)
  return x?.opened_at
    ? h('span', { class: 'pill pill--ok' }, 'Opened ✓')
    : h('span', { class: 'pill pill--info' }, 'Not opened yet')
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
        h('div', { class: 'check-row__meta' }, textPill(m), openedPill(m),
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
  await refresh()
  if (r.dry_run) { practice = true; render() }
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
    await loadNoPairs()
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
  const date = $('e-date')
  if (!date.value) { fieldError(date, 'Pick the swap date. It can be changed, but not left empty.'); ok = false } else fieldError(date, null)
  if (!ok) return
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    const changes = {
      name: name.value.trim(),
      budget: b === '' ? null : Number(b),
      swap_date: $('e-date').value,
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
