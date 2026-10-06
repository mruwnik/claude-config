// The same cell counting as live-tests' footer, so the two columns pad alike.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
] as const

const charWidth = (char: string) => {
  if (/[\p{Mn}\p{Me}\p{Cf}︀-️]/u.test(char)) return 0
  const code = char.codePointAt(0) ?? 0
  return /\p{Emoji_Presentation}/u.test(char) || WIDE.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1
}

/** How many terminal cells a string takes: wide CJK and emoji count two, combining marks none. */
export const cellWidth = (text: string) => [...text].reduce((sum, char) => sum + charWidth(char), 0)

export const padEnd = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)))

export const padStart = (text: string, width: number) => ' '.repeat(Math.max(0, width - cellWidth(text))) + text
