// The kids' page: /m/#<token>.
//
// The token lives only in the URL fragment and in RPC bodies. It is never put
// in a URL query, a log, an error message or the page. The page calls only the
// three member RPCs. Everything rendered goes in with textContent or h().
// Hiding things here is cosmetic: member_view decides what a member may see.

import { supabase } from './supabaseClient.js'
import { tokenFromHash } from './token.js'
import { checkList, MAX_TEXT, MAX_URL, MAX_WISHES } from './wishlist.js'
import { isValidWishLink } from './links.js'
import { circleFacts } from './format.js'
import { busy, clearNotices, fieldError, h, notify } from './ui.js'

const $ = id => document.getElementById(id)
const ABOUT_FIELDS = [
  ['fav_color', 'Favorite color'],
  ['fav_snack', 'Favorite snack or treat'],
  ['sizes', 'Sizes'],
  ['please_no', 'Please no…']
]
const ABOUT_SHOW = [
  ['fav_color', 'Favorite color'],
  ['fav_snack', 'Favorite snack'],
  ['sizes', 'Sizes'],
  ['please_no', 'Please no…']
]

let token = null
let generation = 0 // bumps on every load, so a slow old answer can't paint over a new page
let rowCounter = 0

// ------------------------------------------------------------------ page states
function resetPage () {
  clearNotices()
  $('view').replaceChildren()
  $('greeting').textContent = 'Secret Santa'
  $('circle-sub').textContent = 'Loading…'
  $('facts').replaceChildren()
  document.title = 'Your Secret Santa'
}

function showNotFound () {
  $('circle-sub').textContent = ''
  $('view').replaceChildren(h('section', { class: 'card', 'aria-labelledby': 'nf-title' },
    h('h2', { id: 'nf-title' }, 'Link not found'),
    h('p', {}, 'This link doesn’t work. Check that you copied the whole link from your text, or ask the grown-up who runs your Secret Santa to send it again.')))
}

async function load () {
  const gen = ++generation
  token = tokenFromHash(location.hash)
  resetPage()
  if (!token) return showNotFound()
  const { data, error } = await supabase.rpc('member_view', { p_token: token })
  if (gen !== generation) return
  if (error || !data) {
    if (error && !/link not found/i.test(error.message ?? '')) {
      $('circle-sub').textContent = ''
      notify('bad', 'We couldn’t load your page. Check your connection and reload.')
      return
    }
    return showNotFound()
  }
  render(data)
}

// ------------------------------------------------------------------ rendering
function render (view) {
  const { circle, me } = view
  $('greeting').textContent = `Hi ${me.first_name}!`
  $('circle-sub').textContent = circle.name
  document.title = `${circle.name} - Secret Santa`
  $('facts').replaceChildren(...circleFacts(circle).map(f => h('span', { class: 'fact' }, f)))

  const parts = []
  if (view.match) parts.push(revealCard(view.match, circle), matchListCard(view.match))
  parts.push(aboutCard(me), wishesCard(me), doneCards(me), peopleBand(), peopleCard(view))
  $('view').replaceChildren(...parts)
}

function wishList (member) {
  const items = [...(member.items ?? [])].sort((a, b) => a.position - b.position)
  if (!items.length) return null
  return h('ol', { class: 'wishes' }, items.map(it => h('li', {},
    h('span', { class: 'wishes__body' }, it.text,
      isValidWishLink(it.url)
        ? [' ', h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'See link (opens a new tab)')]
        : null))))
}

function aboutList (member) {
  const rows = ABOUT_SHOW.filter(([k]) => member[k])
  if (!rows.length) return null
  return h('dl', { class: 'about' }, rows.flatMap(([k, label]) => [h('dt', {}, label), h('dd', {}, member[k])]))
}

function revealCard (match, circle) {
  return h('section', { class: 'reveal', 'aria-labelledby': 'drawn-name' },
    h('div', { class: 'snow', 'aria-hidden': 'true' }),
    h('img', { class: 'reveal__gift', src: '../img/gift.svg', alt: '' }),
    h('p', { class: 'reveal__kicker' }, 'You drew…'),
    h('h2', { class: 'reveal__name', id: 'drawn-name', 'data-test': 'drawn-name' }, `${match.first_name}!`),
    h('div', { class: 'divider-cane', role: 'presentation' }),
    h('p', { class: 'reveal__facts' }, circleFacts(circle).join(' · ')),
    h('p', {}, 'Shh! Keep it secret until the swap.'))
}

function matchListCard (match) {
  const about = aboutList(match)
  const wishes = wishList(match)
  return h('section', { class: 'card', 'aria-labelledby': 'match-title', 'data-test': 'match-list' },
    h('div', { class: 'card__title' }, h('img', { src: '../img/mitten.svg', alt: '' }),
      h('h2', { id: 'match-title' }, `${match.first_name}’s wish list`)),
    about, wishes,
    !about && !wishes ? h('p', { class: 'muted' }, `${match.first_name} hasn’t added anything yet. Check back soon!`) : null)
}

function peopleBand () {
  return h('div', { class: 'band' }, h('div', { class: 'band__inner' },
    h('div', { class: 'row' }, h('img', { class: 'spot', src: '../img/candy-cane.svg', alt: '' }),
      h('h2', { id: 'people-title' }, 'Everyone’s wish lists')),
    h('p', {}, 'Peek at what your friends are hoping for.')))
}

function peopleCard (view) {
  return h('section', { class: 'card', 'aria-labelledby': 'people-title', id: 'people' }, personArticles(view))
}

function personArticles (view) {
  return view.members.map(m => {
    const isMe = m.id === view.me.id
    const about = aboutList(m)
    const wishes = wishList(m)
    return h('article', { class: 'person', 'data-test': 'person' },
      h('h3', { class: 'person__name' }, isMe ? `${m.first_name} (you)` : m.first_name, ' ',
        m.list_done
          ? h('span', { class: 'pill pill--ok' }, h('span', { 'aria-hidden': 'true' }, '✓'), ' Done')
          : h('span', { class: 'pill pill--warn' }, h('span', { 'aria-hidden': 'true' }, '✗'), ' Not done yet')),
      about, wishes,
      !about && !wishes ? h('p', { class: 'muted' }, isMe ? 'Your list is empty so far.' : `${m.first_name} is still thinking.`) : null)
  })
}

/** Re-read the circle after a change, and refresh only the shared lists (never the editor). */
async function refreshPeople () {
  const gen = generation
  const { data, error } = await supabase.rpc('member_view', { p_token: token })
  if (gen !== generation || error || !data) return
  $('people')?.replaceChildren(...personArticles(data))
}

// ------------------------------------------------------------------ the editor
let aboutInputs = {}
let wishHost = null
let addButton = null
let countNote = null
let saveStatus = null

function aboutCard (me) {
  aboutInputs = {}
  const fields = ABOUT_FIELDS.map(([key, label]) => {
    const input = h('input', { class: 'input', id: `about-${key}`, maxlength: MAX_TEXT, autocomplete: 'off' })
    input.value = me[key] ?? ''
    aboutInputs[key] = input
    return h('div', { class: 'field' }, h('label', { class: 'field__label', for: input.id }, label), input)
  })
  return h('section', { class: 'card', 'aria-labelledby': 'about-title' },
    h('div', { class: 'card__title' }, h('img', { src: '../img/holly.svg', alt: '' }), h('h2', { id: 'about-title' }, 'About me')),
    h('p', { class: 'muted' }, 'All of these are optional.'),
    h('div', { class: 'field-grid' }, fields))
}

function wishRow (item) {
  const n = ++rowCounter
  const text = h('input', { class: 'input', id: `wish-${n}-text`, maxlength: MAX_TEXT, autocomplete: 'off' })
  const link = h('input', { class: 'input', id: `wish-${n}-url`, maxlength: MAX_URL, inputmode: 'url', autocomplete: 'off' })
  text.value = item?.text ?? ''
  link.value = item?.url ?? ''
  const title = h('span', {})
  const row = h('div', { class: 'wish-edit', 'data-test': 'wish-edit' },
    h('div', { class: 'wish-edit__head' }, title,
      h('button', { class: 'btn btn--small btn--quiet', type: 'button', onclick: () => { row.remove(); syncRows(); markEdited() } }, 'Remove')),
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: text.id }, 'What do you wish for?'), text),
    h('div', { class: 'field' }, h('label', { class: 'field__label', for: link.id }, 'Link (optional)'), link))
  row._title = title
  row._text = text
  row._url = link
  return row
}

function rows () { return [...wishHost.querySelectorAll('[data-test="wish-edit"]')] }

function syncRows () {
  const list = rows()
  list.forEach((r, i) => {
    r._title.textContent = `Wish ${i + 1}`
    r.querySelector('button').setAttribute('aria-label', `Remove wish ${i + 1}`)
  })
  addButton.disabled = list.length >= MAX_WISHES
  countNote.textContent = `Up to ${MAX_WISHES}. A link is optional. ${list.length} of ${MAX_WISHES} so far.`
}

function markEdited () { if (saveStatus) saveStatus.textContent = '' }

function wishesCard (me) {
  wishHost = h('div', {})
  const items = [...(me.items ?? [])].sort((a, b) => a.position - b.position)
  for (const it of (items.length ? items : [null])) wishHost.append(wishRow(it))
  countNote = h('p', { class: 'muted' })
  addButton = h('button', {
    class: 'btn btn--secondary btn--block', type: 'button',
    onclick: () => { if (rows().length < MAX_WISHES) { const r = wishRow(null); wishHost.append(r); syncRows(); r._text.focus() } }
  }, '+ Add another wish')
  saveStatus = h('p', { class: 'muted', role: 'status', 'data-test': 'save-status' })
  const saveButton = h('button', { class: 'btn btn--primary btn--block', type: 'button',
    onclick: () => busy(saveButton, () => save()) }, 'Save my list')
  const card = h('section', { class: 'card', 'aria-labelledby': 'wishes-title' },
    h('div', { class: 'card__title' }, h('img', { src: '../img/gift.svg', alt: '' }), h('h2', { id: 'wishes-title' }, 'My wishes')),
    countNote, wishHost, addButton,
    h('div', { class: 'divider-cane', role: 'presentation' }),
    saveButton, saveStatus)
  card.addEventListener('input', markEdited)
  syncRows()
  return card
}

/** Check, then send. Returns true only when the database accepted the list. */
async function save () {
  clearNotices()
  saveStatus.textContent = ''
  const list = rows()
  const about = Object.fromEntries(Object.entries(aboutInputs).map(([k, el]) => [k, el.value]))
  const result = checkList({ about, items: list.map(r => ({ text: r._text.value, url: r._url.value })) })

  for (const [k, el] of Object.entries(aboutInputs)) fieldError(el, result.errors.find(e => e.field === k)?.message ?? null)
  list.forEach((r, i) => {
    fieldError(r._text, result.errors.find(e => e.field === 'text' && e.index === i)?.message ?? null)
    fieldError(r._url, result.errors.find(e => e.field === 'url' && e.index === i)?.message ?? null)
  })
  if (!result.ok) {
    const general = result.errors.find(e => e.field === 'items')
    if (general) notify('bad', general.message)
    else notify('bad', 'Some things need fixing. Look for the ⚠ messages.')
    document.querySelector('[aria-invalid="true"]')?.focus()
    return false
  }

  const gen = generation
  const { error } = await supabase.rpc('save_my_list', { p_token: token, p_about: result.about, p_items: result.items })
  if (gen !== generation) return false
  if (error) {
    notify('bad', 'Could not save your list. Check your connection and try again.')
    return false
  }
  saveStatus.textContent = 'Saved ✓'
  refreshPeople()
  return true
}

// ------------------------------------------------------------------ done / not done
let promptCard = null
let doneCard = null

function doneCards (me) {
  const doneBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button',
    onclick: () => busy(doneBtn, markDone) }, 'I’m done!')
  promptCard = h('section', { class: 'card card--tint', 'aria-labelledby': 'finish-title' },
    h('h2', { id: 'finish-title' }, 'All finished?'),
    h('p', {}, 'Tap the button so the Elf knows you’re ready. You can still change your list later.'),
    doneBtn)
  const undoBtn = h('button', { class: 'btn btn--quiet btn--block', type: 'button',
    onclick: () => busy(undoBtn, markNotDone) }, 'I want to change something')
  doneCard = h('section', { class: 'card card--tint', 'aria-labelledby': 'done-title', 'data-test': 'done-state' },
    h('h2', { id: 'done-title' }, '✓ You’re all done!'),
    h('p', {}, 'The Elf knows your list is ready.'),
    undoBtn)
  showDone(me.list_done === true)
  return h('div', { class: 'stack' }, promptCard, doneCard)
}

function showDone (done) {
  promptCard.hidden = done
  doneCard.hidden = !done
}

async function markDone () {
  if (!(await save())) return // a failed save never marks the list done
  const gen = generation
  const { error } = await supabase.rpc('set_list_done', { p_token: token, p_done: true })
  if (gen !== generation) return
  if (error) return notify('bad', 'Could not tell the Elf you’re done. Check your connection and try again.')
  showDone(true)
  refreshPeople()
}

async function markNotDone () {
  const gen = generation
  const { error } = await supabase.rpc('set_list_done', { p_token: token, p_done: false })
  if (gen !== generation) return
  if (error) return notify('bad', 'Could not change that. Check your connection and try again.')
  showDone(false)
  refreshPeople()
}

// ------------------------------------------------------------------ go
window.addEventListener('hashchange', load)
load()
