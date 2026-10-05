import { expect, test } from 'claude-code/testing'

import { headerRowCount, layoutTable, plainCell, splitSegments } from './table'
import type { TableLine, TableSegment } from './table'

const fence = '```'

const tables = (text: string): TableSegment[] =>
  splitSegments(text).filter((s): s is TableSegment => s.kind === 'table')

const parseCases: { name: string; text: string; header: string[]; rows: string[][]; indent: number }[] = [
  { name: 'plain', text: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n', header: ['a', 'b'], rows: [['1', '2'], ['3', '4']], indent: 0 },
  { name: 'no outer pipes, alignment colons', text: 'a | b\n:--|--:\n1 | 2\n', header: ['a', 'b'], rows: [['1', '2']], indent: 0 },
  { name: 'escaped pipe stays in the cell', text: '| a | b |\n|-|-|\n| x \\| y | 2 |\n', header: ['a', 'b'], rows: [['x \\| y', '2']], indent: 0 },
  { name: 'indented in a list item', text: '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n', header: ['a', 'b'], rows: [['1', '2']], indent: 2 },
  { name: 'short rows are padded, long rows cut', text: '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n', header: ['a', 'b'], rows: [['1', ''], ['1', '2']], indent: 0 },
  { name: 'ends at a blank line', text: '| a |\n|---|\n| 1 |\n\n| not | row |\n', header: ['a'], rows: [['1']], indent: 0 },
]

for (const { name, text, header, rows, indent } of parseCases) {
  test(`splitSegments finds a table: ${name}`, () => {
    expect(tables(text)[0]).toMatchObject({ header, rows, indent })
  })
}

const notTables: { name: string; text: string }[] = [
  { name: 'inside a fence', text: `${fence}\n| a | b |\n|---|---|\n| 1 | 2 |\n${fence}\n` },
  { name: 'pipes in prose', text: 'a | b\nc | d\n' },
  { name: 'delimiter row without header', text: '|---|---|\n| 1 | 2 |\n' },
  { name: 'column counts differ', text: '| a | b |\n|---|\n| 1 | 2 |\n' },
]

for (const { name, text } of notTables) {
  test(`splitSegments leaves it alone: ${name}`, () => {
    expect(splitSegments(text)).toEqual([{ kind: 'md', text }])
  })
}

test('md segments keep every line that is not table and a table after a fence is found', () => {
  const text = `before\n${fence}\n| x |\n|-|\n${fence}\n| a |\n|---|\n| 1 |\nafter\n`
  const segments = splitSegments(text)
  expect(segments.map(s => s.kind)).toEqual(['md', 'table', 'md'])
  expect(segments[0]).toEqual({ kind: 'md', text: `before\n${fence}\n| x |\n|-|\n${fence}\n` })
  expect(segments[2]).toEqual({ kind: 'md', text: 'after\n' })
  expect(splitSegments('')).toEqual([])
})

test('plainCell strips inline markdown', () => {
  expect(plainCell('`code` and **bold** and [a link](http://x.y/z) ~~gone~~ _it_ snake_case')).toBe(
    'code and bold and a link gone it snake_case',
  )
  expect(plainCell('x \\| y<br>z')).toBe('x | y z')
})

const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda '.repeat(3).trim()
const wide: TableSegment = {
  kind: 'table',
  indent: 0,
  source: '',
  header: ['Name', 'Description', 'Notes'],
  rows: [
    ['`one`', long, 'short'],
    ['two', 'tiny', `${long} supercalifragilisticexpialidocious_and_then_some_more_characters`],
  ],
}

const widths = [200, 120, 80, 60, 45, 38, 30, 20, 10, 3]

for (const width of widths) test(`layoutTable at width ${width} never exceeds it`, () => {
  const lines = layoutTable(wide, width)
  expect(lines.length).toBeGreaterThan(0)
  expect(Math.max(...lines.map(l => Array.from(l.text).length))).toBeLessThanOrEqual(width)
})

const counts = (s: string): Map<string, number> =>
  [...s.replace(/[^A-Za-z_]/g, '')].reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())

for (const width of widths) test(`layoutTable at width ${width} keeps every word (no letter lost)`, () => {
  const drawn = counts(layoutTable(wide, width).map(l => l.text).join(''))
  const written = counts(['Name', 'Description', 'Notes', 'one', long, 'short', 'two', 'tiny', long, 'supercalifragilisticexpialidocious_and_then_some_more_characters'].join(''))
  const lost = [...written].filter(([c, n]) => (drawn.get(c) ?? 0) < n)
  expect(lost).toEqual([])
})

test('a fitting table is a box with a bold header and a rule under it', () => {
  const small: TableSegment = { kind: 'table', indent: 0, source: '', header: ['a', 'b'], rows: [['1', '2']] }
  expect(layoutTable(small, 40)).toEqual([
    { text: '┌───┬───┐', isHeader: false },
    { text: '│ a │ b │', isHeader: true, row: 0 },
    { text: '├───┼───┤', isHeader: false },
    { text: '│ 1 │ 2 │', isHeader: false, row: 2 },
    { text: '└───┴───┘', isHeader: false },
  ])
})

test('layout lines name the source row they draw: 0 the header, 2.. the body rows (1 is the delimiter)', () => {
  const t = tables('| a | b |\n|---|---|\n| x y z | 2 |\n| 3 | 4 |\n')[0] as TableSegment
  const rows = (width: number) => layoutTable(t, width).map(l => l.row)
  expect(rows(40)).toEqual([undefined, 0, undefined, 2, 3, undefined])
  const narrow = layoutTable(t, 5)
  expect(narrow.filter(l => l.row === 2).length).toBeGreaterThan(0)
  expect(narrow.filter(l => l.row === 3).length).toBeGreaterThan(0)
  expect(narrow.some(l => l.row === 0)).toBe(false)
})

test('a tall table keeps its row tags on wrapped lines and none on the rules between rows', () => {
  const t = tables(`| a | b |\n|---|---|\n| ${'word '.repeat(30)}| 2 |\n| 3 | 4 |\n`)[0] as TableSegment
  const lines = layoutTable(t, 40)
  const tagged = lines.filter(l => l.row === 2)
  expect(tagged.length).toBeGreaterThan(1)
  expect(lines.filter(l => l.text.startsWith('├')).every(l => l.row === undefined)).toBe(true)
})

test('a table that cannot fit even at minimum widths falls back to a block per row', () => {
  const lines = layoutTable(wide, 20).map(l => l.text)
  expect(lines.some(l => l.includes('┌'))).toBe(false)
  expect(lines[0]).toBe('Name: `one`'.replace(/`/g, ''))
  expect(lines.filter(l => /^─+$/.test(l))).toHaveLength(1)
})

test('wide columns share the width in proportion and the box uses it', () => {
  const lines = layoutTable(wide, 80).map(l => l.text)
  expect(lines[0]).toMatch(/^┌/)
  expect(Math.max(...lines.map(l => l.length))).toBe(80)
})

test('a wide-character cell is padded by the cells it takes, so the box stays aligned', () => {
  const t: TableSegment = { kind: 'table', indent: 0, source: '', header: ['k', 'v'], rows: [['漢字', '1'], ['ab', '2']] }
  const lines = layoutTable(t, 40).map(l => l.text)
  expect(lines).toContain('│ 漢字 │ 1 │')
  expect(lines).toContain('│ ab   │ 2 │')
})

const line = (text: string, isHeader = false): TableLine => ({ text, isHeader })
const headerCases: { name: string; lines: TableLine[]; expected: number }[] = [
  { name: 'border, two header lines, separator', lines: [line('┌'), line('│a', true), line('│a', true), line('├'), line('│1'), line('└')], expected: 4 },
  { name: 'one header line', lines: [line('┌─┐'), line('│a│', true), line('├─┤'), line('│1│'), line('└─┘')], expected: 3 },
  { name: 'the block-per-row fallback has none', lines: [line('a: 1'), line('b: 2'), line('───'), line('a: 3')], expected: 0 },
  { name: 'nothing drawn', lines: [], expected: 0 },
]
for (const { name, lines, expected } of headerCases) test(`headerRowCount: ${name}`, () => expect(headerRowCount(lines)).toBe(expected))
