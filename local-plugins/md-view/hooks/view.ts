import { compare } from './diff'
import { applyMarks } from './marks'
import type { Marked } from './marks'
import { renderMarkdown, sanitize } from './render'
import type { Row, TableSpan } from './render'
import { cutToWidth, strWidth } from './width'

/** Columns left of every row for the change marker (`▌`) and a space: kept whether or not anything is marked, so nothing shifts. */
export const GUTTER = 2

/** The whole doc laid out for one width: its rows, its tables, the row each change hunk starts on. */
export type Layout = Marked

/** How much real work was done, so a test can see that redraws and scrolls reuse it (not a clock). */
export const stats = { layouts: 0 }

let last: { text: string; baseline: string | undefined; width: number; layout: Layout } | undefined

/**
 * The doc `text` laid out as rows `width` cells wide, marked against
 * `baseline` when there is one. The last answer is kept (matched by the texts
 * themselves): every redraw and scroll of one version at one width reuses it.
 */
export const layoutDoc = (text: string, baseline: string | undefined, width: number): Layout => {
  if (last !== undefined && last.text === text && last.baseline === baseline && last.width === width) return last.layout
  stats.layouts += 1
  const clean = sanitize(text)
  const rendered = renderMarkdown(clean, width)
  const layout =
    baseline === undefined || baseline.trim() === ''
      ? { rows: rendered.rows, tables: rendered.tables, hunkRows: [] }
      : applyMarks(rendered, compare(sanitize(baseline), clean), clean, width)
  last = { text, baseline, width, layout }
  return layout
}

/** The last window offset over `rowCount` rows shown `windowRows` at a time. */
export const maxOffset = (rowCount: number, windowRows: number): number => Math.max(0, rowCount - windowRows)

export const clampOffset = (offset: number, rowCount: number, windowRows: number): number =>
  Math.min(Math.max(0, offset), maxOffset(rowCount, windowRows))

/**
 * Where the person's scroll `e` puts a window of `windowRows` over `rowCount`
 * rows that now sits at `offset`. The engine's `by` counts its own tree: a
 * page key is `bodyRows` (a window here, less the header), Home and End are
 * `contentRows` (the top and the bottom; md-view draws its tree one row taller
 * than the body so they differ), anything else (wheel, arrows) is rows.
 */
export const scrollStep = (
  e: { by: number; bodyRows: number; contentRows: number },
  offset: number,
  rowCount: number,
  windowRows: number,
): number => {
  const from = clampOffset(offset, rowCount, windowRows)
  const size = Math.abs(e.by)
  if (e.contentRows > e.bodyRows && size >= e.contentRows) return e.by > 0 ? maxOffset(rowCount, windowRows) : 0
  const by = size === e.bodyRows ? Math.sign(e.by) * windowRows : e.by
  return clampOffset(from + by, rowCount, windowRows)
}

/** A table whose header is pinned at the window's top; `skip` of its header rows have slid off as the table ends. */
export type Sticky = { table: TableSpan; skip: number }

/**
 * Which table's header to pin with the window at `offset`: the one whose
 * first header line has scrolled off while more than its bottom border still
 * shows. Near the table's end the pinned rows slide up (`skip`) so the
 * separator never covers what follows the table.
 */
export const stickyAt = (tables: TableSpan[], offset: number): Sticky | null => {
  const table = tables.find(t => t.headerRows > 0 && offset > t.start + 1 && offset < t.end)
  if (table === undefined) return null
  return { table, skip: Math.max(0, offset + table.headerRows - 1 - table.end) }
}

export type Shown = { row: Row; isSticky: boolean }

/** The `count` rows the window at `offset` shows, a pinned table header over its top rows. */
export const visibleRows = (layout: { rows: Row[]; tables: TableSpan[] }, offset: number, count: number): Shown[] => {
  const slice = layout.rows.slice(offset, offset + count).map(row => ({ row, isSticky: false }))
  const sticky = stickyAt(layout.tables, offset)
  if (sticky === null) return slice
  const { table, skip } = sticky
  const pinned = layout.rows.slice(table.start + skip, table.start + table.headerRows).map(row => ({ row, isSticky: true }))
  return [...pinned, ...slice.slice(pinned.length)].slice(0, count)
}

/** The offset that shows `row` at the window's top, or just under the pinned header when it is a table's body row. */
export const jumpOffset = (tables: TableSpan[], row: number, rowCount: number, windowRows: number): number => {
  const table = tables.find(t => t.headerRows > 0 && row >= t.start + t.headerRows && row <= t.end)
  return clampOffset(table === undefined ? row : row - table.headerRows, rowCount, windowRows)
}

/** How far down the window is: `42%`, or `all` when the doc fits. */
export const position = (offset: number, rowCount: number, windowRows: number): string => {
  const max = maxOffset(rowCount, windowRows)
  if (max === 0) return 'all'
  return `${Math.round((Math.min(Math.max(0, offset), max) / max) * 100)}%`
}

/** The last code points of `text` that fit in `width` cells. */
const tailToWidth = (text: string, width: number): string => [...cutToWidth([...text].reverse().join(''), width)].reverse().join('')

export type HeaderInfo = { path: string; updated: string; position: string; changes: number }

/**
 * The pane's header line in `columns` less `reserve` (the button beside it):
 * path · updated · position, and the change count when there are changes; a
 * path too long is cut from the front.
 */
export const headerText = (info: HeaderInfo, columns: number, reserve: number): string => {
  const changes = info.changes === 0 ? '' : ` · ${info.changes} ${info.changes === 1 ? 'change' : 'changes'} since you last looked ·`
  const tail = ` · updated ${info.updated} · ${info.position}${changes}`
  const room = columns - reserve - strWidth(tail)
  const path = strWidth(info.path) <= room ? info.path : `…${tailToWidth(info.path, Math.max(0, room - 1))}`
  return cutToWidth(path + tail, Math.max(1, columns - reserve))
}
