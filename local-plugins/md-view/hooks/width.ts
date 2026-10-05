/**
 * Terminal cells a character takes, counted conservatively: anything that may
 * draw wide (East Asian wide and fullwidth forms, emoji and pictographs, the
 * symbol blocks some fonts draw wide) counts two, everything else one. Zero-width
 * characters also count one: a row measured too wide only ends early, one
 * measured too narrow would spill.
 */
export const charWidth = (cp: number): number =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2600 && cp <= 0x27bf) ||
  (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe19) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f000 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1

/** Cells `text` takes (charWidth per code point). */
export const strWidth = (text: string): number => {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) as number)
  return w
}

/** The longest prefix of `text` that fits in `width` cells. */
export const cutToWidth = (text: string, width: number): string => {
  let w = 0
  let out = ''
  for (const ch of text) {
    const c = charWidth(ch.codePointAt(0) as number)
    if (w + c > width) break
    w += c
    out += ch
  }
  return out
}

/** `text` in pieces of at most `width` cells each (at least one code point per piece). */
export const breakToWidth = (text: string, width: number): string[] => {
  const pieces: string[] = []
  let current = ''
  let w = 0
  for (const ch of text) {
    const c = charWidth(ch.codePointAt(0) as number)
    if (w + c > width && current !== '') {
      pieces.push(current)
      current = ''
      w = 0
    }
    current += ch
    w += c
  }
  if (current !== '' || pieces.length === 0) pieces.push(current)
  return pieces
}
