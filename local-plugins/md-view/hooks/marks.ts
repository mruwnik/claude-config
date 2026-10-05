import type { Block, Change } from './diff'
import { inlineOf, tableSpans, wrapSpans } from './render'
import type { Mark, Patches, Rendered, Row, TableSpan, Tint } from './render'
import { plainCell, splitRow } from './table'
import { wordDiff } from './words'

/** One change placed in the NEW text: `start`/`end` are its character range (a removed block has none: both are where it used to sit). */
export type MarkItem = {
  op: Change['op']
  start: number
  end: number
  /** The new block, or for `removed` the old one. */
  block: Block
  /** `changed` only: the block it replaced. */
  old?: Block
  /** Set on the first item of each change hunk: the hunk's number, from 0. */
  hunk?: number
}

/**
 * Places `changes` (as `compare` returns them) in the new text and numbers the
 * hunks: a run of consecutive non-same changes is one hunk, numbered on its
 * first item. A `removed` item sits at the offset of the block after it.
 */
export const markItems = (changes: Change[]): MarkItem[] => {
  const out: MarkItem[] = []
  let offset = 0
  let hunks = 0
  changes.forEach((change, i) => {
    const isHunkStart = change.op !== 'same' && (i === 0 || changes[i - 1]?.op === 'same')
    const hunk = isHunkStart ? hunks++ : undefined
    if (change.op === 'removed') {
      out.push({ op: 'removed', start: offset, end: offset, block: change.block, hunk })
      return
    }
    const end = offset + change.block.raw.length
    out.push({
      op: change.op,
      start: offset,
      end,
      block: change.block,
      ...(change.op === 'changed' ? { old: change.old } : {}),
      hunk,
    })
    offset = end
  })
  return out
}

/**
 * The word diffs of the changed blocks that draw as one heading or paragraph
 * (in a list item or quote too), by the line each starts on in the new text:
 * `renderMarkdown` draws these in place of the blocks' own spans. Code and
 * table rows are not diffed inline.
 */
export const inlinePatches = (changes: Change[]): Patches =>
  new Map(
    changes.flatMap((c): [number, ReturnType<typeof wordDiff>][] => {
      if (c.op !== 'changed' || c.block.kind === 'code' || c.block.kind === 'table-row') return []
      const old = inlineOf(c.old.text)
      const next = inlineOf(c.block.text)
      return old === undefined || next === undefined ? [] : [[c.block.line, wordDiff(old, next)]]
    }),
  )

/** The doc's rows with the marks on, the tables where they now sit, and the row each change hunk starts on (by hunk). */
export type Marked = { rows: Row[]; tables: TableSpan[]; hunkRows: number[] }

/** The source lines a block draws; a table's delimiter row draws none, its change shows on the header row above it. */
const blockLines = (block: Block): number[] => {
  if (block.kind === 'table-row' && block.part === 'delimiter') return [block.line - 1]
  const count = block.text.split('\n').length - (block.text.endsWith('\n') ? 1 : 0)
  return Array.from({ length: Math.max(1, count) }, (_, k) => block.line + k)
}

/** The line of the character at `offset` of a text whose lines start at `starts`. */
const lineAt = (starts: number[], offset: number): number => {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

const lineStarts = (text: string): number[] => {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** Old text as struck rows on the removed background: each source line wrapped and struck through. */
const struck = (text: string, mark: Mark, width: number): Row[] =>
  text
    .replace(/\n+$/, '')
    .split('\n')
    .flatMap((line): Row[] =>
      line.trim() === ''
        ? [{ spans: [], kind: 'old', mark, tint: 'removed' }]
        : wrapSpans([{ text: line, strikethrough: true }], width).map(spans => ({ spans, kind: 'old', mark, tint: 'removed' })),
    )

const rowPlain = (block: Block): string => splitRow(block.text).map(plainCell).join(' │ ')

/** Moves an insertion point that falls between two rows of one table to just before it, or with `isAfter` just past it. */
const outsideTable = (rows: Row[], at: number, isAfter: boolean): number => {
  const id = rows[at]?.table?.id
  if (id === undefined || rows[at - 1]?.table?.id !== id) return at
  let i = at
  if (isAfter) while (rows[i]?.table?.id === id) i++
  else while (rows[i - 1]?.table?.id === id) i--
  return i
}

type Insert = { at: number; rows: Row[] }

/**
 * Puts `changes` (of the sanitized `text` against its baseline) on the rows
 * `rendered` drew of it: every row of an added or changed block carries its
 * mark. An added block's rows are tinted added. A changed block drawn from
 * `patches` already shows its word diff; any other's rows are tinted added and
 * its old text follows as struck rows (a table row's does not: it would break
 * the box). A removed block is struck rows where it stood, a removed table row
 * under its table; struck rows are tinted removed. No change marks nothing.
 */
export const applyMarks = (
  rendered: Rendered & { headers: ReadonlyMap<number, number> },
  changes: Change[],
  text: string,
  width: number,
  patches: Patches = new Map(),
): Marked => {
  const items = markItems(changes)
  if (!items.some(i => i.op !== 'same')) return { rows: rendered.rows, tables: rendered.tables, hunkRows: [] }

  const isInline = (it: MarkItem): boolean => it.op === 'changed' && patches.has(it.block.line)
  const lineMarks = new Map<number, Mark>()
  const lineTints = new Map<number, Tint>()
  for (const it of items) {
    if (it.op !== 'added' && it.op !== 'changed') continue
    const isDelimiter = it.block.part === 'delimiter'
    const isTinted = !isDelimiter && !isInline(it) && (it.op === 'added' || it.block.kind !== 'table-row')
    for (const n of blockLines(it.block)) {
      if (!isDelimiter || !lineMarks.has(n)) lineMarks.set(n, isDelimiter ? 'changed' : it.op)
      if (isTinted) lineTints.set(n, 'added')
    }
  }

  const firstRow = new Map<number, number>()
  const lastRow = new Map<number, number>()
  const rows = rendered.rows.map((row, idx): Row => {
    if (row.lines === undefined) return row
    let mark: Mark | undefined
    let tint: Tint | undefined
    for (let n = row.lines[0]; n < row.lines[1]; n++) {
      mark ??= lineMarks.get(n)
      tint ??= lineTints.get(n)
      if (!firstRow.has(n)) firstRow.set(n, idx)
      lastRow.set(n, idx)
    }
    return mark === undefined ? row : { ...row, mark, ...(tint === undefined ? {} : { tint }) }
  })

  const starts = lineStarts(text)
  const lastLine = starts.length
  const firstRowFrom = (line: number): number => {
    for (let n = line; n <= lastLine; n++) {
      const r = firstRow.get(n)
      if (r !== undefined) return r
    }
    return rows.length
  }
  const inserts: Insert[] = []
  const hunkTargets = new Map<number, Row>()
  const target = (hunk: number | undefined, row: Row | undefined) => {
    if (hunk !== undefined && row !== undefined) hunkTargets.set(hunk, row)
  }

  for (const it of items) {
    if (it.op === 'same') continue
    if (it.op === 'added' || it.op === 'changed') {
      const lines = blockLines(it.block)
      const first = lines.map(n => firstRow.get(n)).find(r => r !== undefined)
      target(it.hunk, first === undefined ? undefined : rows[first])
      if (it.op === 'added' || it.block.kind === 'table-row' || it.old === undefined || isInline(it)) continue
      const last = Math.max(-1, ...lines.map(n => lastRow.get(n) ?? -1))
      if (last !== -1) inserts.push({ at: last + 1, rows: struck(it.old.text, 'changed', width) })
      continue
    }
    const anchor = lineAt(starts, it.start)
    if (it.block.part === 'delimiter') {
      const header = firstRow.get(anchor - 1)
      target(it.hunk, header === undefined ? undefined : rows[header])
      continue
    }
    if (it.block.kind === 'table-row') {
      let at = firstRowFrom(anchor)
      while (at > 0 && rows[at - 1]?.kind === 'blank') at--
      at = outsideTable(rows, at, true)
      const gone = struck(rowPlain(it.block), 'removed', width)
      target(it.hunk, gone[0])
      inserts.push({ at, rows: gone })
      continue
    }
    const at = outsideTable(rows, firstRowFrom(anchor), false)
    const gone = struck(it.block.text, 'removed', width)
    target(it.hunk, gone[0])
    const before = at > 0 && rows[at - 1]?.kind !== 'blank' ? [{ spans: [], kind: 'blank' as const }] : []
    const after = at < rows.length && rows[at]?.kind !== 'blank' ? [{ spans: [], kind: 'blank' as const }] : []
    inserts.push({ at, rows: [...before, ...gone, ...after] })
  }

  const byAt = new Map<number, Row[]>()
  for (const ins of inserts) byAt.set(ins.at, [...(byAt.get(ins.at) ?? []), ...ins.rows])
  const out: Row[] = []
  for (let i = 0; i <= rows.length; i++) {
    out.push(...(byAt.get(i) ?? []))
    if (i < rows.length) out.push(rows[i] as Row)
  }
  const index = new Map<Row, number>()
  out.forEach((row, i) => index.set(row, i))
  const hunkRows = [...hunkTargets.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, row]) => {
      const i = index.get(row)
      return i === undefined ? [] : [i]
    })
  return { rows: out, tables: tableSpans(out, rendered.headers), hunkRows }
}
