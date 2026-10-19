// Wish-list links: http(s) only, with a host, no spaces, at most 500 characters.
// The same rule as the database (wish_items.url check, save_my_list), so the
// page never accepts a link the database will refuse.

export function isValidWishLink (url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 500) return false
  // Any whitespace or control character anywhere (blocks "java\tscript:").
  if (/[\s\u0000-\u001F\u007F]/.test(url)) return false
  return /^https?:\/\/[^/?#]+/i.test(url)
}
