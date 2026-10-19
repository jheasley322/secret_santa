// HTML escaping for the rare place a string must go into markup.
// Prefer textContent (CLAUDE.md rule 7); use this only when building HTML text.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml (value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, ch => MAP[ch])
}
