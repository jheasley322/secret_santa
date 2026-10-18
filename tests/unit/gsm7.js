// An independent GSM 03.38 oracle, owned by the tests (not the implementation),
// so "is this one SMS segment?" is checked against the standard, not against
// whatever the builder thinks GSM-7 is.

// Basic character set (1 septet each). ESC (0x1B) is deliberately left out.
const BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
// Extension table (2 septets each: ESC + char).
const EXTENSION = '\f^{}\\[~]|€'

const basic = new Set([...BASIC])
const extension = new Set([...EXTENSION])

/** Characters in `text` that GSM-7 can't encode at all. */
export function nonGsm7 (text) {
  return [...text].filter(ch => !basic.has(ch) && !extension.has(ch))
}

export function isGsm7 (text) {
  return nonGsm7(text).length === 0
}

/** Septets used. Throws if a character isn't GSM-7. */
export function septets (text) {
  let n = 0
  for (const ch of text) {
    if (basic.has(ch)) n += 1
    else if (extension.has(ch)) n += 2
    else throw new Error(`not GSM-7: U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  }
  return n
}

/** One SMS segment = one credit. */
export function fitsOneSegment (text) {
  return isGsm7(text) && septets(text) <= 160
}
