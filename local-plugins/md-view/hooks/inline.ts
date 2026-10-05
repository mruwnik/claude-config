/** How a run of text is drawn: the `Text` style props md-view uses (only set keys are present). */
export type Style = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  dimColor?: boolean
  color?: string
  backgroundColor?: string
}

/** A run of text in one style. */
export type Span = Style & { text: string }

/** Theme keys: inline code and code blocks, links. */
export const CODE_COLOR = 'suggestion'
export const LINK_COLOR = 'permission'

const STYLE_KEYS = ['bold', 'italic', 'underline', 'strikethrough', 'dimColor', 'color', 'backgroundColor'] as const

export const sameStyle = (a: Style, b: Style): boolean => STYLE_KEYS.every(k => a[k] === b[k])

/** Appends `span` to `line`, joining it to the last span when they share a style. Mutates `line` (and only spans it made). */
export const appendSpan = (line: Span[], span: Span): void => {
  if (span.text === '') return
  const last = line[line.length - 1]
  if (last !== undefined && sameStyle(last, span)) {
    line[line.length - 1] = { ...last, text: last.text + span.text }
    return
  }
  line.push({ ...span })
}

const PUNCT = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const WORD = /[\p{L}\p{N}]/u
const AUTOLINK = /^<((?:https?|ftp|mailto):[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/
const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,:;"'!?)\]*_~]/

const runLength = (s: string, i: number, ch: string): number => {
  let j = i
  while (s[j] === ch) j++
  return j - i
}

/** Where the backtick run of exactly `n` closing a code span opened before `from` starts, or -1. */
const codeClose = (s: string, from: number, n: number): number => {
  let j = from
  while (j < s.length) {
    if (s[j] !== '`') {
      j++
      continue
    }
    const run = runLength(s, j, '`')
    if (run === n) return j
    j += run
  }
  return -1
}

/** Index past a code span starting at `j` (a backtick run), or past the run when it never closes. */
const skipCode = (s: string, j: number): number => {
  const n = runLength(s, j, '`')
  const close = codeClose(s, j + n, n)
  return close === -1 ? j + n : close + n
}

/** Where the closing run of exactly `want` `ch` for an emphasis opened before `from` starts, or -1. */
const emphasisClose = (s: string, from: number, ch: string, want: number): number => {
  let j = from
  while (j < s.length) {
    const c = s[j] as string
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') {
      j = skipCode(s, j)
      continue
    }
    if (c !== ch) {
      j++
      continue
    }
    const run = runLength(s, j, ch)
    const before = s[j - 1] ?? ' '
    const after = s[j + run]
    const isRightFlanking = j > from && !SPACE.test(before)
    const isWordAfter = ch === '_' && after !== undefined && WORD.test(after)
    if (run === want && isRightFlanking && !isWordAfter) return j
    j += run
  }
  return -1
}

/** Index of the bracket closing the one at `open`, or -1. */
const bracketClose = (s: string, open: number, left: string, right: string): number => {
  let depth = 0
  let j = open
  while (j < s.length) {
    const c = s[j] as string
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`' && left === '[') {
      j = skipCode(s, j)
      continue
    }
    if (c === left) depth++
    if (c === right) {
      depth--
      if (depth === 0) return j
    }
    j++
  }
  return -1
}

const emphasisStyle = (style: Style, ch: string, n: number): Style => {
  if (ch === '~') return { ...style, strikethrough: true }
  if (n === 1) return { ...style, italic: true }
  if (n === 2) return { ...style, bold: true }
  return { ...style, bold: true, italic: true }
}

const linkStyle = (style: Style): Style => ({ ...style, underline: true, color: LINK_COLOR })

type Link = { text: string; end: number }

/** A link (or image) starting at the `[` at `open`: its text and the index past it, or undefined when it is not one. */
const linkAt = (s: string, open: number): Link | undefined => {
  if (s[open + 1] === '^') return undefined
  const close = bracketClose(s, open, '[', ']')
  if (close === -1) return undefined
  const text = s.slice(open + 1, close)
  if (s[close + 1] === '(') {
    const end = bracketClose(s, close + 1, '(', ')')
    return end === -1 ? undefined : { text: text === '' ? s.slice(close + 2, end).trim() : text, end: end + 1 }
  }
  if (s[close + 1] === '[') {
    const end = s.indexOf(']', close + 2)
    return end === -1 ? undefined : { text, end: end + 1 }
  }
  return undefined
}

const scan = (s: string, style: Style): Span[] => {
  const out: Span[] = []
  let buf = ''
  const flush = () => {
    if (buf !== '') out.push({ ...style, text: buf })
    buf = ''
  }
  let i = 0
  while (i < s.length) {
    const c = s[i] as string
    const next = s[i + 1]
    if (c === '\\' && next !== undefined && PUNCT.test(next)) {
      buf += next
      i += 2
      continue
    }
    if (c === '\n') {
      flush()
      out.push({ ...style, text: '\n' })
      i++
      continue
    }
    if (c === '`') {
      const n = runLength(s, i, '`')
      const close = codeClose(s, i + n, n)
      if (close === -1) {
        buf += s.slice(i, i + n)
        i += n
        continue
      }
      flush()
      const raw = s.slice(i + n, close).replace(/\n/g, ' ')
      const code = raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '' ? raw.slice(1, -1) : raw
      out.push({ ...style, color: CODE_COLOR, text: code })
      i = close + n
      continue
    }
    if (c === '!' && next === '[') {
      const link = linkAt(s, i + 1)
      if (link !== undefined) {
        flush()
        out.push({ ...style, dimColor: true, text: `[image: ${link.text}]` })
        i = link.end
        continue
      }
    }
    if (c === '[') {
      const link = linkAt(s, i)
      if (link !== undefined) {
        flush()
        out.push(...scan(link.text, linkStyle(style)))
        i = link.end
        continue
      }
    }
    if (c === '<') {
      const auto = AUTOLINK.exec(s.slice(i, i + 2048))
      if (auto !== null) {
        flush()
        out.push({ ...linkStyle(style), text: auto[1] as string })
        i += auto[0].length
        continue
      }
    }
    if (c === 'h' && (i === 0 || !WORD.test(s[i - 1] as string))) {
      const url = BARE_URL.exec(s.slice(i, i + 2048))
      if (url !== null) {
        flush()
        out.push({ ...linkStyle(style), text: url[0] })
        i += url[0].length
        continue
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const n = runLength(s, i, c)
      const after = s[i + n]
      const before = s[i - 1]
      const isLeftFlanking = after !== undefined && !SPACE.test(after)
      const isIntraword = c === '_' && before !== undefined && WORD.test(before)
      const isValidRun = c === '~' ? n === 2 : n <= 3
      const close = isLeftFlanking && !isIntraword && isValidRun ? emphasisClose(s, i + n, c, n) : -1
      if (close === -1) {
        buf += s.slice(i, i + n)
        i += n
        continue
      }
      flush()
      out.push(...scan(s.slice(i + n, close), emphasisStyle(style, c, n)))
      i = close + n
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

/**
 * The spans of one paragraph's inline markdown: code spans, emphasis (`*`,
 * `_`, `**`, `***`, `~~`), links and images (their text), autolinks and bare
 * URLs; HTML and footnote references stay as written. `\n` is a hard break.
 * Adjacent spans of one style are joined.
 */
export const parseInline = (text: string, base: Style = {}): Span[] => {
  const out: Span[] = []
  for (const span of scan(text, base)) appendSpan(out, span)
  return out
}
