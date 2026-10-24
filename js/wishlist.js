// Checks a member's list before it is sent. The page twin of save_my_list, so
// the page never sends what the database would refuse.

import { isValidWishLink } from './links.js'

export const MAX_WISHES = 10
export const MAX_TEXT = 200
export const MAX_URL = 500

const ABOUT_KEYS = ['fav_color', 'fav_snack', 'sizes', 'please_no']
const ABOUT_NAMES = { fav_color: 'Favorite color', fav_snack: 'Favorite snack', sizes: 'Sizes', please_no: 'Please no' }

const clean = v => (typeof v === 'string' ? v.trim() : '')

/** { about, items:[{text,url}] } -> { ok, about, items, errors:[{field,index?,message}] }. Does not mutate. */
export function checkList (input) {
  const src = input ?? {}
  const errors = []

  const about = {}
  for (const key of ABOUT_KEYS) {
    const v = clean(src.about?.[key])
    if (v.length > MAX_TEXT) errors.push({ field: key, message: `${ABOUT_NAMES[key]} is too long. Please keep it under ${MAX_TEXT} letters.` })
    about[key] = v === '' ? null : v
  }

  const items = []
  const rows = Array.isArray(src.items) ? src.items : []
  rows.forEach((row, index) => {
    const text = clean(row?.text)
    const url = clean(row?.url)
    if (text === '' && url === '') return // an untouched row
    let good = true
    if (text === '') {
      errors.push({ field: 'text', index, message: 'Please say what you wish for.' })
      good = false
    } else if (text.length > MAX_TEXT) {
      errors.push({ field: 'text', index, message: `That wish is too long. Please keep it under ${MAX_TEXT} letters.` })
      good = false
    }
    if (url !== '' && !isValidWishLink(url)) {
      errors.push({ field: 'url', index, message: url.length > MAX_URL
        ? `That link is too long. Please keep it under ${MAX_URL} characters.`
        : 'Links must start with http:// or https://' })
      good = false
    }
    if (good) items.push({ text, url: url === '' ? null : url })
    else items.push(null)
  })

  const kept = items.filter(Boolean)
  if (items.length > MAX_WISHES) {
    errors.push({ field: 'items', message: `You can have up to ${MAX_WISHES} wishes. Please remove one.` })
  }
  return { ok: errors.length === 0, about, items: kept, errors }
}
