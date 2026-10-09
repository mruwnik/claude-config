import { expect, test } from 'claude-code/testing'

import type { Row, TableSpan } from './render'
import { headerText, jumpOffset, layoutDoc, placeImages, position, scrollStep, stats, stickyAt, visibleRows } from './view'
import type { Placed } from './view'
import { strWidth } from './width'

const TABLE: TableSpan = { id: 0, start: 5, headerRows: 3, end: 36 }
const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ spans: [{ text: `r${i}` }], kind: 'text' }))
const LAYOUT = { rows: rowsOf(100), tables: [TABLE] }

const stickyCases: Array<{ offset: number; want: number | null }> = [
  { offset: 0, want: null },
  { offset: 5, want: null }, // the table's own top border is the window's top row
  { offset: 6, want: null }, // its header line still shows
  { offset: 7, want: 0 }, // the header line has gone: pin the whole header
  { offset: 20, want: 0 },
  { offset: 34, want: 0 },
  { offset: 35, want: 1 }, // the table ends: the pinned rows slide up
  { offset: 36, want: null }, // only the bottom border is left
  { offset: 50, want: null },
]
for (const { offset, want } of stickyCases) {
  test(`stickyAt offset ${offset}: ${want === null ? 'nothing pinned' : `skip ${want}`}`, () => {
    expect(stickyAt([TABLE], offset)?.skip ?? null).toBe(want)
  })
}

test('stickyAt pins nothing for a table with no header (the block-per-row fallback)', () => {
  expect(stickyAt([{ ...TABLE, headerRows: 0 }], 20)).toBeNull()
})

const visibleCases: Array<{ offset: number; want: string[]; sticky: boolean[] }> = [
  { offset: 0, want: ['r0', 'r1', 'r2', 'r3', 'r4'], sticky: [false, false, false, false, false] },
  { offset: 20, want: ['r5', 'r6', 'r7', 'r23', 'r24'], sticky: [true, true, true, false, false] },
  { offset: 35, want: ['r6', 'r7', 'r37', 'r38', 'r39'], sticky: [true, true, false, false, false] },
  { offset: 98, want: ['r98', 'r99'], sticky: [false, false] },
]
for (const { offset, want, sticky } of visibleCases) {
  test(`visibleRows at ${offset} replaces the window's top rows with the pinned header`, () => {
    const shown = visibleRows(LAYOUT, offset, 5)
    expect(shown.map(s => s.row.spans[0]?.text)).toEqual(want)
    expect(shown.map(s => s.isSticky)).toEqual(sticky)
  })
}

// bodyRows 20, the tree drawn one taller (contentRows 21), a 19-row window under a 1-row header, 100 rows
const step = (by: number, offset: number, rowCount = 100) => scrollStep({ by, bodyRows: 20, contentRows: 21 }, offset, rowCount, 19)
const scrollCases: Array<{ name: string; by: number; offset: number; rowCount?: number; want: number }> = [
  { name: 'wheel down', by: 1, offset: 0, want: 1 },
  { name: 'wheel up at the top stays', by: -1, offset: 0, want: 0 },
  { name: 'clamped at the bottom', by: 3, offset: 80, want: 81 },
  { name: 'page down moves a window', by: 20, offset: 10, want: 29 },
  { name: 'page up moves a window', by: -20, offset: 30, want: 11 },
  { name: 'End goes to the bottom', by: 21, offset: 0, want: 81 },
  { name: 'Home goes to the top', by: -21, offset: 50, want: 0 },
  { name: 'a doc that fits never moves', by: 1, offset: 0, rowCount: 5, want: 0 },
  { name: 'a stale offset past the end steps from the end', by: -1, offset: 200, want: 80 },
]
for (const { name, by, offset, rowCount, want } of scrollCases) test(`scrollStep: ${name}`, () => expect(step(by, offset, rowCount)).toBe(want))

const jumpCases: Array<{ name: string; row: number; want: number }> = [
  { name: 'a row outside tables is the window top', row: 50, want: 50 },
  { name: 'a table body row lands just under the pinned header', row: 20, want: 17 },
  { name: 'a row near the top', row: 3, want: 3 },
  { name: 'clamped to the last offset', row: 99, want: 81 },
]
for (const { name, row, want } of jumpCases) test(`jumpOffset: ${name}`, () => expect(jumpOffset([TABLE], row, 100, 19)).toBe(want))

test('position is a percentage of the way down, or all when the doc fits', () => {
  expect(position(0, 100, 20)).toBe('0%')
  expect(position(40, 100, 20)).toBe('50%')
  expect(position(80, 100, 20)).toBe('100%')
  expect(position(0, 10, 20)).toBe('all')
})

test('headerText names the path, the update, the position and the changes', () => {
  const base = { path: 'docs/a.md', updated: '12:00:00', position: '42%' }
  expect(headerText({ ...base, changes: 0 }, 120, 0)).toBe('docs/a.md · updated 12:00:00 · 42%')
  expect(headerText({ ...base, changes: 1 }, 120, 0)).toBe('docs/a.md · updated 12:00:00 · 42% · 1 change since you last looked ·')
  expect(headerText({ ...base, changes: 2 }, 120, 0)).toBe('docs/a.md · updated 12:00:00 · 42% · 2 changes since you last looked ·')
})

test('headerText cuts the path from the front to fit the columns left beside the button', () => {
  const got = headerText({ path: '/a/very/long/path/to/some/document.md', updated: '12:00:00', position: '1%', changes: 0 }, 50, 8)
  expect(strWidth(got)).toBeLessThanOrEqual(42)
  expect(got.startsWith('…')).toBe(true)
  expect(got).toContain('document.md · updated')
})

test('layoutDoc is made once per version and width, and a new version or width makes it again', () => {
  const before = stats.layouts
  const a = layoutDoc('# one\n\ntext\n', undefined, 40)
  expect(layoutDoc('# one\n\ntext\n', undefined, 40)).toBe(a)
  expect(stats.layouts).toBe(before + 1)
  layoutDoc('# one\n\ntext\n', undefined, 30)
  layoutDoc('# two\n\ntext\n', undefined, 30)
  expect(stats.layouts).toBe(before + 3)
})

// An image 3 rows tall after a text row: [text, head, cont, cont, text].
const IMAGE = { src: 'p.png', alt: 'cover', columns: 6, rows: 3 }
const imageDoc: Row[] = [
  { spans: [{ text: 'before' }], kind: 'text' },
  { spans: [{ text: '• ' }], kind: 'image', image: IMAGE },
  { spans: [], kind: 'image' },
  { spans: [], kind: 'image' },
  { spans: [{ text: 'after' }], kind: 'text' },
]
const placed = (offset: number, count: number): Array<string> =>
  placeImages(visibleRows({ rows: imageDoc, tables: [] }, offset, count)).map((p: Placed) =>
    p.kind === 'image' ? `image ${p.image.rows}` : p.shown.row.spans.map(s => s.text).join(''),
  )

const placeCases: Array<{ name: string; offset: number; count: number; want: string[] }> = [
  { name: 'whole image in the window is one image', offset: 0, count: 5, want: ['before', 'image 3', 'after'] },
  { name: 'image cut at the bottom shows where it is', offset: 0, count: 3, want: ['before', '• [image: cover ↓]', ''] },
  { name: 'image whose top scrolled off says so', offset: 2, count: 3, want: ['↑ image', '', 'after'] },
]
for (const { name, offset, count, want } of placeCases) test(`placeImages: ${name}`, () => expect(placed(offset, count)).toEqual(want))
