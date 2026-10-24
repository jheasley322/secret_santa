// Small DOM helpers shared by the pages. Everything goes in as textContent or
// attributes, never as HTML (CLAUDE.md rule 7).

export function h (tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

/**
 * Show a notice at the top of the page. Errors stay until dismissed; every
 * notice has a Dismiss button. kind: 'ok' | 'bad' | 'info'.
 */
export function notify (kind, text) {
  const box = document.getElementById('notices')
  const icon = kind === 'bad' ? '⚠' : kind === 'ok' ? '✓' : 'ℹ'
  const n = h('div', { class: `notice notice--${kind}`, role: kind === 'bad' ? 'alert' : 'status' },
    h('span', { class: 'notice__text' }, h('span', { 'aria-hidden': 'true' }, icon), ' ', h('span', { class: 'notice__msg' }, text)),
    h('button', { class: 'btn btn--small', type: 'button', onclick: () => n.remove() }, 'Dismiss'))
  box.append(n)
  return n
}

export function clearNotices () {
  document.getElementById('notices').replaceChildren()
}

/** Mark a field invalid with a message tied to it by aria-describedby. */
export function fieldError (input, message) {
  const id = `${input.id}-error`
  let err = document.getElementById(id)
  if (!message) {
    input.removeAttribute('aria-invalid')
    err?.remove()
    restoreDescribedBy(input, id)
    return
  }
  if (!err) {
    err = h('span', { class: 'field__error', id })
    input.after(err)
  }
  err.replaceChildren(h('span', { 'aria-hidden': 'true' }, '⚠'), ' ', message)
  input.setAttribute('aria-invalid', 'true')
  const ids = new Set((input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
  ids.add(id)
  input.setAttribute('aria-describedby', [...ids].join(' '))
}

function restoreDescribedBy (input, id) {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(x => x && x !== id)
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '))
  else input.removeAttribute('aria-describedby')
}

/** Disable a button while an async action runs, so a double tap can't send twice. */
export async function busy (button, fn) {
  if (button.disabled) return
  button.disabled = true
  try { return await fn() } finally { button.disabled = false }
}
