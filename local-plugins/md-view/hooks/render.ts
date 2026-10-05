import { appendSpan, CODE_COLOR, parseInline } from './inline'
import type { Span, Style } from './inline'
import { headerRowCount, layoutTable, tableAt } from './table'
import type { TableSegment } from './table'
import { breakToWidth, cutToWidth, strWidth } from './width'

export type RowKind = 'text' | 'heading' | 'rule' | 'code' | 'table' | 'blank' | 'old'
export type Mark = 'added' | 'changed' | 'removed'

/** One terminal row of the drawn doc: never wider than the width it was laid out for. */
export type Row = {
  spans: Span[]
  kind: RowKind
  /** The source lines [from, to) this row draws; absent on rows of no line (blanks, table borders, struck text). */
  lines?: [number, number]
  /** Set on every row of a table: which one (TableSpan.id). */
  table?: { id: number }
  /** Set by the diff marks: how the block this row draws changed. */
  mark?: Mark
  /** Set by the diff marks on rows of a whole block added or removed: the row's background. */
  tint?: Tint
}

/** A whole row's diff background: GitHub's green for an added block, red for a removed one. */
export type Tint = 'added' | 'removed'

/** Inline spans that stand in for a block's own, by the source line the block starts on: a changed block's word diff. */
export type Patches = ReadonlyMap<number, Span[]>

/** Where a table's rows are: `start` its top border, `end` its last row (inclusive), `headerRows` its pinnable header (0: none). */
export type TableSpan = { id: number; start: number; headerRows: number; end: number }

export type Rendered = { rows: Row[]; tables: TableSpan[] }

type Line = { text: string; n: number }

type Block =
  | { kind: 'heading'; level: number; text: string; from: number; to: number }
  | { kind: 'paragraph'; text: string; from: number; to: number }
  | { kind: 'code'; lines: Line[] }
  | { kind: 'rule'; from: number }
  | { kind: 'table'; table: TableSegment; from: number }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; isOrdered: boolean; start: number; delimiter: string; isLoose: boolean; items: Item[] }
  | { kind: 'html'; lines: Line[] }

type Item = { task: boolean | undefined; children: Block[]; from: number }

const BLANK = /^\s*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/
const SETEXT_1 = /^ {0,3}=+[ \t]*$/
const SETEXT_2 = /^ {0,3}-+[ \t]*$/
const HTML = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|\/[A-Za-z]|!--|\?|![A-Z])/
const INDENTED = /^ {4}/
const TASK = /^\[([ xX])\](?:[ \t]+|$)/

const BULLETS = ['•', '◦', '▪'] as const
const QUOTE_GUTTER: Span = { text: '│ ', color: 'subtle' }
const QUOTE_BLANK: Span = { text: '│', color: 'subtle' }
const WRAP_MARK: Span = { text: '↩', dimColor: true }

const HEADING_STYLES: Style[] = [
  { bold: true, color: 'claude' },
  { bold: true, color: 'permission' },
  { bold: true },
  { bold: true, italic: true },
  { italic: true, dimColor: true },
  { italic: true, dimColor: true },
]

/** Drops what a terminal row cannot hold (carriage returns, control characters) and expands tabs to 4-column stops. */
export const sanitize = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/^[^\t\n]*\t[^\n]*$/gm, line =>
      line.split('\t').reduce((acc, part, i, all) => (i === all.length - 1 ? acc + part : `${acc}${part}${' '.repeat(4 - ((strWidth(acc) + strWidth(part)) % 4))}`), ''),
    )

/**
 * Word-wraps styled text to rows of at most `width` cells: breaks at spaces
 * (dropped at a break) and at `\n`; a word longer than a row is cut.
 */
export const wrapSpans = (spans: Span[], width: number): Span[][] => {
  const w = Math.max(1, width)
  const lines: Span[][] = []
  let line: Span[] = []
  let used = 0
  let gap: Span | undefined
  let word: Span[] = []
  let wordWidth = 0

  const newline = () => {
    lines.push(line)
    line = []
    used = 0
    gap = undefined
  }
  const placeWord = () => {
    if (word.length === 0) return
    const gapWidth = gap !== undefined && used > 0 ? strWidth(gap.text) : 0
    if (used > 0 && used + gapWidth + wordWidth <= w) {
      if (gap !== undefined) appendSpan(line, gap)
      word.forEach(s => appendSpan(line, s))
      used += gapWidth + wordWidth
    } else {
      if (used > 0) newline()
      if (wordWidth <= w) {
        word.forEach(s => appendSpan(line, s))
        used = wordWidth
      } else {
        for (const s of word) {
          for (const piece of breakToWidth(s.text, 1)) {
            const c = strWidth(piece)
            if (used + c > w && used > 0) newline()
            appendSpan(line, { ...s, text: piece })
            used += c
          }
        }
      }
    }
    word = []
    wordWidth = 0
    gap = undefined
  }

  for (const s of spans) {
    for (const part of s.text.split(/(\n| +)/)) {
      if (part === '') continue
      if (part === '\n') {
        placeWord()
        newline()
        continue
      }
      if (part.startsWith(' ')) {
        placeWord()
        gap = { ...s, text: part }
        continue
      }
      word.push({ ...s, text: part })
      wordWidth += strWidth(part)
    }
  }
  placeWord()
  if (line.length > 0 || lines.length === 0) lines.push(line)
  return lines
}

/** `spans` cut to `width` cells. */
const fitSpans = (spans: Span[], width: number): Span[] => {
  const out: Span[] = []
  let used = 0
  for (const s of spans) {
    const w = strWidth(s.text)
    if (used + w <= width) {
      out.push(s)
      used += w
      continue
    }
    const cut = cutToWidth(s.text, width - used)
    if (cut !== '') out.push({ ...s, text: cut })
    break
  }
  return out
}

const indentOf = (text: string): number => text.length - text.trimStart().length

const isListStart = (text: string): boolean => {
  const m = LIST.exec(text)
  return m !== null && (m[4] ?? '').trim() !== '' && !HR.test(text)
}

/** Whether the line at `i` begins a block that ends a paragraph before it. */
const isBlockStart = (texts: string[], i: number): boolean => {
  const t = texts[i] as string
  return (
    ATX.test(t) || FENCE_OPEN.test(t) || HR.test(t) || QUOTE.test(t) || isListStart(t) || HTML.test(t) || tableAt(texts, i) !== undefined
  )
}

/** A paragraph's lines as one inline text: soft breaks are spaces, a line ending in two spaces or `\` is a hard break (`\n`). */
const joinParagraph = (parts: string[]): string =>
  parts
    .map((p, k) => {
      const isLast = k === parts.length - 1
      const isHard = !isLast && (/ {2,}$/.test(p) || /\\$/.test(p.trimEnd()))
      const body = isHard ? p.trim().replace(/\\$/, '') : p.trim()
      return body + (isLast ? '' : isHard ? '\n' : ' ')
    })
    .join('')
    .trimEnd()

const parseList = (lines: Line[], texts: string[], i: number): { block: Block; next: number } => {
  const first = LIST.exec(texts[i] as string) as RegExpExecArray
  const bullet = first[2] as string
  const isOrdered = /\d/.test(bullet)
  const delimiter = isOrdered ? bullet.slice(-1) : bullet
  const items: Item[] = []
  let isLoose = false
  let j = i
  while (j < lines.length) {
    const text = texts[j] as string
    const m = LIST.exec(text)
    if (m === null || HR.test(text)) break
    const marker = m[2] as string
    const isSame = isOrdered ? /\d/.test(marker) && marker.endsWith(delimiter) : marker === bullet
    if (!isSame) break
    const spaces = m[3]?.length ?? 1
    const pad = spaces > 4 ? 1 : spaces
    const contentIndent = (m[1] as string).length + marker.length + pad
    const firstText = spaces > 4 ? ' '.repeat(spaces - 1) + (m[4] ?? '') : (m[4] ?? '')
    const body: Line[] = [{ text: firstText, n: (lines[j] as Line).n }]
    let k = j + 1
    let isPrevBlank = firstText.trim() === ''
    while (k < lines.length) {
      const t = texts[k] as string
      if (BLANK.test(t)) {
        body.push({ text: '', n: (lines[k] as Line).n })
        isPrevBlank = true
        k++
        continue
      }
      if (indentOf(t) >= contentIndent) {
        body.push({ text: t.slice(contentIndent), n: (lines[k] as Line).n })
        isPrevBlank = false
        k++
        continue
      }
      if (isPrevBlank || isBlockStart(texts, k)) break
      body.push({ text: t.trimStart(), n: (lines[k] as Line).n })
      k++
    }
    let end = body.length
    while (end > 1 && (body[end - 1] as Line).text === '') end--
    const content = body.slice(0, end)
    if (content.some(l => l.text === '')) isLoose = true
    if (end < body.length && k < lines.length && LIST.test(texts[k] as string)) isLoose = true
    const head = content[0] as Line
    const task = TASK.exec(head.text)
    const children = parseBlocks(task === null ? content : [{ ...head, text: head.text.slice(task[0].length) }, ...content.slice(1)])
    items.push({ task: task === null ? undefined : task[1] !== ' ', children, from: head.n })
    j = k
  }
  return { block: { kind: 'list', isOrdered, start: isOrdered ? parseInt(bullet, 10) : 1, delimiter, isLoose, items }, next: j }
}

/** The blocks of `lines` (a doc, or the inside of a quote or list item, each line keeping its source line number). */
const parseBlocks = (lines: Line[]): Block[] => {
  const texts = lines.map(l => l.text)
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as Line
    const t = line.text
    if (BLANK.test(t)) {
      i++
      continue
    }
    const fence = FENCE_OPEN.exec(t)
    if (fence !== null && !((fence[2] as string).startsWith('`') && (fence[3] as string).includes('`'))) {
      const open = fence[2] as string
      const indent = (fence[1] as string).length
      let j = i + 1
      const body: Line[] = []
      while (j < lines.length) {
        const close = FENCE_CLOSE.exec(texts[j] as string)
        if (close !== null && (close[1] as string)[0] === open[0] && (close[1] as string).length >= open.length) break
        const l = lines[j] as Line
        body.push({ text: l.text.slice(Math.min(indent, indentOf(l.text))), n: l.n })
        j++
      }
      blocks.push({ kind: 'code', lines: body })
      i = j + 1
      continue
    }
    const atx = ATX.exec(t)
    if (atx !== null) {
      blocks.push({ kind: 'heading', level: (atx[1] as string).length, text: atx[2] ?? '', from: line.n, to: line.n + 1 })
      i++
      continue
    }
    if (HR.test(t)) {
      blocks.push({ kind: 'rule', from: line.n })
      i++
      continue
    }
    const table = tableAt(texts, i)
    if (table !== undefined) {
      blocks.push({ kind: 'table', table: table.table, from: line.n })
      i = table.end
      continue
    }
    if (QUOTE.test(t)) {
      const inner: Line[] = []
      let j = i
      while (j < lines.length) {
        const tj = texts[j] as string
        const q = QUOTE.exec(tj)
        if (q !== null) inner.push({ text: q[1] as string, n: (lines[j] as Line).n })
        else if (!BLANK.test(tj) && !BLANK.test((inner[inner.length - 1] as Line).text) && !isBlockStart(texts, j))
          inner.push({ text: tj, n: (lines[j] as Line).n })
        else break
        j++
      }
      blocks.push({ kind: 'quote', children: parseBlocks(inner) })
      i = j
      continue
    }
    if (LIST.test(t)) {
      const { block, next } = parseList(lines, texts, i)
      blocks.push(block)
      i = next
      continue
    }
    if (INDENTED.test(t)) {
      let j = i
      while (j < lines.length && (INDENTED.test(texts[j] as string) || BLANK.test(texts[j] as string))) j++
      while (j > i && BLANK.test(texts[j - 1] as string)) j--
      blocks.push({ kind: 'code', lines: lines.slice(i, j).map(l => ({ text: l.text.slice(4), n: l.n })) })
      i = j
      continue
    }
    if (HTML.test(t)) {
      let j = i
      while (j < lines.length && !BLANK.test(texts[j] as string)) j++
      blocks.push({ kind: 'html', lines: lines.slice(i, j) })
      i = j
      continue
    }
    const parts = [t]
    let j = i + 1
    let level = 0
    while (j < lines.length) {
      const tj = texts[j] as string
      if (BLANK.test(tj)) break
      if (SETEXT_1.test(tj) || SETEXT_2.test(tj)) {
        level = SETEXT_1.test(tj) ? 1 : 2
        j++
        break
      }
      if (isBlockStart(texts, j)) break
      parts.push(tj)
      j++
    }
    const text = joinParagraph(parts)
    const to = (lines[j - 1] as Line).n + 1
    blocks.push(level === 0 ? { kind: 'paragraph', text, from: line.n, to } : { kind: 'heading', level, text, from: line.n, to })
    i = j
  }
  return blocks
}

type Ctx = { depth: number; tables: { next: number; headers: Map<number, number> }; patches: Patches }

const blank = (): Row => ({ spans: [], kind: 'blank' })

const textRows = (spans: Span[], width: number, kind: RowKind, lines: [number, number]): Row[] =>
  wrapSpans(spans, width).map(s => ({ spans: s, kind, lines }))

/** `rows` with `first` in front of the first row and `rest` in front of the others; blank rows get `blankPrefix`. */
const prefixed = (rows: Row[], first: Span[], rest: Span[], blankPrefix: Span[]): Row[] =>
  rows.map((row, k) => ({ ...row, spans: [...(row.kind === 'blank' && k > 0 ? blankPrefix : k === 0 ? first : rest), ...row.spans] }))

const codeRows = (lines: Line[], width: number): Row[] =>
  lines.flatMap(({ text, n }): Row[] => {
    const at: [number, number] = [n, n + 1]
    if (text === '') return [{ spans: [], kind: 'code', lines: at }]
    if (strWidth(text) <= width) return [{ spans: [{ text, color: CODE_COLOR }], kind: 'code', lines: at }]
    const pieces = breakToWidth(text, Math.max(1, width - 1))
    return pieces.map((piece, k) => ({
      spans: k === pieces.length - 1 ? [{ text: piece, color: CODE_COLOR }] : [{ text: piece, color: CODE_COLOR }, WRAP_MARK],
      kind: 'code',
      lines: at,
    }))
  })

const headingRows = (block: Extract<Block, { kind: 'heading' }>, width: number, ctx: Ctx): Row[] => {
  const style = HEADING_STYLES[block.level - 1] ?? {}
  const at: [number, number] = [block.from, block.to]
  const rows = textRows(ctx.patches.get(block.from) ?? parseInline(block.text, style), width, 'heading', at)
  if (block.level > 2) return rows
  const ruleWidth = Math.max(1, Math.min(width, ...rows.map(r => strWidth(r.spans.map(s => s.text).join('')))))
  const rule: Span = block.level === 1 ? { text: '═'.repeat(ruleWidth), color: 'claude' } : { text: '─'.repeat(ruleWidth), dimColor: true }
  return [...rows, { spans: [rule], kind: 'rule', lines: at }]
}

const tableRows = (block: Extract<Block, { kind: 'table' }>, width: number, ctx: Ctx): Row[] => {
  const id = ctx.tables.next++
  const lines = layoutTable(block.table, width)
  ctx.tables.headers.set(id, headerRowCount(lines))
  return lines.map(l => ({
    spans: [l.isHeader ? { text: l.text, bold: true } : { text: l.text }],
    kind: 'table',
    ...(l.row === undefined ? {} : { lines: [block.from + l.row, block.from + l.row + 1] as [number, number] }),
    table: { id },
  }))
}

const listRows = (block: Extract<Block, { kind: 'list' }>, width: number, ctx: Ctx): Row[] =>
  block.items.flatMap((item, k) => {
    const number = block.isOrdered ? `${block.start + k}${block.delimiter}` : BULLETS[ctx.depth % BULLETS.length]
    const marker = item.task === undefined ? `${number}` : `${number} [${item.task ? 'x' : ' '}]`
    const markerWidth = strWidth(marker) + 1
    const inner = renderBlocks(item.children, Math.max(1, width - markerWidth), { ...ctx, depth: ctx.depth + 1 }, block.isLoose)
    const body = inner.length === 0 ? [{ spans: [], kind: 'text' as const, lines: [item.from, item.from + 1] as [number, number] }] : inner
    const rows = prefixed(body, [{ text: `${marker} ` }], [{ text: ' '.repeat(markerWidth) }], [])
    return k > 0 && block.isLoose ? [blank(), ...rows] : rows
  })

const renderBlock = (block: Block, width: number, ctx: Ctx): Row[] => {
  switch (block.kind) {
    case 'heading':
      return headingRows(block, width, ctx)
    case 'paragraph':
      return textRows(ctx.patches.get(block.from) ?? parseInline(block.text), width, 'text', [block.from, block.to])
    case 'code':
      return codeRows(block.lines, width)
    case 'rule':
      return [{ spans: [{ text: '─'.repeat(width), dimColor: true }], kind: 'rule', lines: [block.from, block.from + 1] }]
    case 'table':
      return tableRows(block, width, ctx)
    case 'quote':
      return prefixed(renderBlocks(block.children, Math.max(1, width - 2), ctx, true), [QUOTE_GUTTER], [QUOTE_GUTTER], [QUOTE_BLANK])
    case 'list':
      return listRows(block, width, ctx)
    case 'html':
      return block.lines.flatMap(l => textRows([{ text: l.text }], width, 'text', [l.n, l.n + 1]))
  }
}

const renderBlocks = (blocks: Block[], width: number, ctx: Ctx, isSpaced: boolean): Row[] =>
  blocks.flatMap((block, k) => (k > 0 && isSpaced ? [blank(), ...renderBlock(block, width, ctx)] : renderBlock(block, width, ctx)))

/** Where each table's rows sit in `rows`, by the `table.id` the rows carry, with each table's header height from `headers`. */
export const tableSpans = (rows: Row[], headers: ReadonlyMap<number, number>): TableSpan[] => {
  const byId = new Map<number, TableSpan>()
  rows.forEach((row, i) => {
    if (row.table === undefined) return
    const known = byId.get(row.table.id)
    if (known === undefined) byId.set(row.table.id, { id: row.table.id, start: i, headerRows: headers.get(row.table.id) ?? 0, end: i })
    else known.end = i
  })
  return [...byId.values()]
}

/**
 * The doc (already sanitized) as terminal rows of at most `width` cells:
 * headings, paragraphs with inline styles, lists, task lists, quotes, code,
 * rules, tables (table.ts) and HTML as plain text, a blank row between blocks.
 */
export const renderMarkdown = (text: string, width: number, patches: Patches = new Map()): Rendered & { headers: ReadonlyMap<number, number> } => {
  const w = Math.max(1, width)
  const ctx: Ctx = { depth: 0, tables: { next: 0, headers: new Map() }, patches }
  const lines = text.split('\n').map((t, n) => ({ text: t, n }))
  const rows = renderBlocks(parseBlocks(lines), w, ctx, true).map(row => ({ ...row, spans: fitSpans(row.spans, w) }))
  return { rows, tables: tableSpans(rows, ctx.tables.headers), headers: ctx.tables.headers }
}

/** The one heading's or paragraph's inline spans a block-level piece of markdown holds; descends into lists and quotes. */
const inlineBlock = (blocks: Block[]): Span[] | undefined => {
  if (blocks.length !== 1) return undefined
  const block = blocks[0] as Block
  switch (block.kind) {
    case 'heading':
      return parseInline(block.text, HEADING_STYLES[block.level - 1] ?? {})
    case 'paragraph':
      return parseInline(block.text)
    case 'quote':
      return inlineBlock(block.children)
    case 'list':
      return block.items.length === 1 ? inlineBlock((block.items[0] as Item).children) : undefined
    default:
      return undefined
  }
}

/**
 * The inline spans of `text` (one diff block's source) as the doc would draw
 * them, when it draws as a single heading or paragraph (inside a list item or
 * quote too); undefined for code, tables, or more than one block.
 */
export const inlineOf = (text: string): Span[] | undefined =>
  inlineBlock(parseBlocks(sanitize(text).replace(/\n+$/, '').split('\n').map((t, n) => ({ text: t, n }))))
