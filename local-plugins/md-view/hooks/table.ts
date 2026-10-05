import { breakToWidth, strWidth } from './width'

const FENCE = /^\s*(```|~~~)/
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const UNESCAPED_PIPE = /(?<!\\)\|/
const MIN_COLUMN = 8

export type MdSegment = { kind: 'md'; text: string }
export type TableSegment = {
  kind: 'table'
  header: string[]
  rows: string[][]
  /** Leading spaces of the header row: a table inside a list item keeps its indent. */
  indent: number
  /** The table's lines as written. */
  source: string
}
export type Segment = MdSegment | TableSegment
/** One drawn line of a table; `row` is the source row it belongs to (0 the header, 1 the delimiter, 2.. the body), absent on rules. */
export type TableLine = { text: string; isHeader: boolean; row?: number }

const len = strWidth

export const splitRow = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return trimmed.split(UNESCAPED_PIPE).map(cell => cell.trim())
}

const isRow = (line: string): boolean => UNESCAPED_PIPE.test(line) && line.trim() !== ''

const isDelimiter = (line: string): boolean => line.includes('|') && DELIMITER.test(line)

const fit = (cells: string[], n: number): string[] => Array.from({ length: n }, (_, i) => cells[i] ?? '')

const indentOf = (line: string): number => line.length - line.trimStart().length

/** Lines of `lines` from `start` that are body rows of a table. */
const bodyEnd = (lines: string[], start: number): number => {
  let i = start
  while (i < lines.length && isRow(lines[i] as string)) i++
  return i
}

/** The GFM table whose header row is `lines[i]`, and the index past its last row; undefined when none starts there. */
export const tableAt = (lines: string[], i: number): { table: TableSegment; end: number } | undefined => {
  const head = lines[i]
  const rule = lines[i + 1]
  if (head === undefined || rule === undefined) return undefined
  if (!isRow(head) || !isDelimiter(rule)) return undefined
  const header = splitRow(head)
  if (splitRow(rule).length !== header.length) return undefined
  const end = bodyEnd(lines, i + 2)
  return {
    end,
    table: {
      kind: 'table',
      header,
      rows: lines.slice(i + 2, end).map(row => fit(splitRow(row), header.length)),
      indent: indentOf(head),
      source: lines.slice(i, end).join(''),
    },
  }
}

/**
 * Splits text into markdown segments and GFM tables (header row, delimiter row,
 * body rows), outside fenced code. The md segments and the tables' `source`s
 * concatenate back to the text.
 */
export const splitSegments = (text: string): Segment[] => {
  const lines = text.split(/(?<=\n)/).filter(l => l !== '')
  const out: Segment[] = []
  let pending: string[] = []
  let isInFence = false
  const flush = () => {
    if (pending.length > 0) out.push({ kind: 'md', text: pending.join('') })
    pending = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (FENCE.test(line)) isInFence = !isInFence
    const found = isInFence || FENCE.test(line) ? undefined : tableAt(lines, i)
    if (found === undefined) {
      pending.push(line)
      continue
    }
    flush()
    out.push(found.table)
    i = found.end - 1
  }
  flush()
  return out
}

/** A cell's text with the inline markdown taken off. */
export const plainCell = (cell: string): string =>
  cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
    .replace(/(?<!\w)_(\S(?:.*?\S)?)_(?!\w)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1')


/** Word-wraps text to lines of at most `width` characters; a longer word is cut. */
export const wrap = (text: string, width: number): string[] => {
  const w = Math.max(1, width)
  const lines = text
    .split(/\s+/)
    .filter(word => word !== '')
    .reduce<string[]>((acc, word) => {
      const last = acc[acc.length - 1]
      if (last !== undefined && last !== '' && len(last) + 1 + len(word) <= w) return [...acc.slice(0, -1), `${last} ${word}`]
      if (len(word) <= w) return [...acc, word]
      const parts = breakToWidth(word, w)
      return [...acc, ...parts]
    }, [])
  return lines.length === 0 ? [''] : lines
}

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - len(text)))

const columnWidths = (natural: number[], available: number): number[] => {
  if (natural.reduce((a, b) => a + b, 0) <= available) return natural
  const mins = natural.map(n => Math.min(n, MIN_COLUMN))
  const extra = available - mins.reduce((a, b) => a + b, 0)
  const deficits = natural.map((n, i) => n - (mins[i] as number))
  const total = deficits.reduce((a, b) => a + b, 0)
  const base = mins.map((m, i) => m + Math.floor((extra * (deficits[i] as number)) / total))
  const leftover = available - base.reduce((a, b) => a + b, 0)
  const order = base.map((_, i) => i).sort((a, b) => natural[b]! - base[b]! - (natural[a]! - base[a]!))
  return order.reduce((ws, i, k) => (k < leftover && ws[i]! < natural[i]! ? ws.map((x, j) => (j === i ? x + 1 : x)) : ws), base)
}

const rule = (widths: number[], left: string, mid: string, right: string): string =>
  left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right

const boxRow = (cells: string[], widths: number[]): string[] => {
  const wrapped = cells.map((cell, i) => wrap(plainCell(cell), widths[i] as number))
  const height = Math.max(...wrapped.map(w => w.length))
  return Array.from({ length: height }, (_, k) => '│ ' + wrapped.map((w, i) => pad(w[k] ?? '', widths[i] as number)).join(' │ ') + ' │')
}

const vertical = (table: TableSegment, width: number): TableLine[] => {
  const blocks = table.rows.map(row =>
    table.header.flatMap((h, i) => wrap(`${plainCell(h)}: ${plainCell(row[i] ?? '')}`, width)),
  )
  const separator = '─'.repeat(Math.max(1, width))
  return blocks.flatMap((block, i): TableLine[] => [
    ...(i === 0 ? [] : [{ text: separator, isHeader: false }]),
    ...block.map(text => ({ text, isHeader: false, row: i + 2 })),
  ])
}

/**
 * Lays a table out in at most `width` columns: a box with word-wrapped cells,
 * columns sized by content (each at least MIN_COLUMN where it has that much),
 * or, when that cannot fit, one block of `header: value` lines per row.
 */
export const layoutTable = (table: TableSegment, width: number): TableLine[] => {
  const n = table.header.length
  const cells = [table.header, ...table.rows].map(row => row.map(plainCell))
  const natural = table.header.map((_, i) => Math.max(1, ...cells.map(row => len(row[i] ?? ''))))
  const available = width - (3 * n + 1)
  const minSum = natural.reduce((a, c) => a + Math.min(c, MIN_COLUMN), 0)
  if (available < minSum) return vertical(table, width)
  const widths = columnWidths(natural, available)
  const bodies = table.rows.map(row => boxRow(row, widths))
  const isTall = bodies.some(b => b.length > 1)
  const line = (text: string): TableLine => ({ text, isHeader: false })
  const between = (i: number): TableLine[] => (isTall && i > 0 ? [line(rule(widths, '├', '┼', '┤'))] : [])
  return [
    line(rule(widths, '┌', '┬', '┐')),
    ...boxRow(table.header, widths).map(text => ({ text, isHeader: true, row: 0 })),
    line(rule(widths, '├', '┼', '┤')),
    ...bodies.flatMap((b, i) => [...between(i), ...b.map(text => ({ text, isHeader: false, row: i + 2 }))]),
    line(rule(widths, '└', '┴', '┘')),
  ]
}

/**
 * The rows a boxed table's header takes: the top border, the header lines and
 * the separator under them. 0 for the block-per-row fallback, which has none.
 */
export const headerRowCount = (lines: TableLine[]): number => {
  const headers = lines.slice(1).findIndex(l => !l.isHeader)
  if (headers <= 0) return 0
  return 1 + headers + 1
}
