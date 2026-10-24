// Reads the member's token from the URL fragment (/m/#<token>).
// The token is a password: exactly 16 base64url characters, nothing else.

const TOKEN = /^[A-Za-z0-9_-]{16}$/

/** location.hash (leading # optional) -> the token, or null. Never throws. */
export function tokenFromHash (hash) {
  if (typeof hash !== 'string') return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  return TOKEN.test(raw) ? raw : null
}
