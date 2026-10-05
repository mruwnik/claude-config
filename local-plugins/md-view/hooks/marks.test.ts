import { expect, test } from 'claude-code/testing'

import { compare } from './diff'
import { markItems } from './marks'
import type { MarkItem } from './marks'
import type { Row } from './render'
import { layoutDoc } from './view'

const items = (before: string, after: string): MarkItem[] => markItems(compare(before, after))
const textOf = (row: Row): string => row.spans.map(s => s.text).join('')
const marked = (rows: Row[]) => rows.filter(r => r.mark !== undefined).map(r => [r.mark, textOf(r).trimEnd()])

test('markItems: offsets follow the new text, removed blocks sit where they were, hunks number from 0', () => {
  const before = 'one\n\ntwo\n\nthree\n\nfour\n'
  const after = 'one\n\nthree\n\nfour changed here\n\nfive\n'
  const got = items(before, after)
  expect(got.map(i => i.op)).toEqual(['same', 'removed', 'same', 'changed', 'added'])
  expect(got.filter(i => i.op !== 'removed').map(i => [i.start, i.end])).toEqual([[0, 5], [5, 12], [12, 31], [31, 36]])
  expect(got.find(i => i.op === 'removed')?.start).toBe(5)
  expect(got.map(i => i.hunk)).toEqual([undefined, 0, undefined, 1, undefined])
})

const OLD = '# Doc\n\nkept paragraph\n\nsecond paragraph about cats\n\nthird paragraph\n\ndoomed paragraph that goes away\n'
const NEW = '# Doc\n\nkept paragraph\n\nsecond paragraph about cats and dogs\n\nthird paragraph\n\nbrand new addition\n'

const tints = (rows: Row[]) => rows.filter(r => r.tint !== undefined).map(r => [r.tint, textOf(r).trimEnd()])

test('changed, removed and added blocks mark their rows; a changed paragraph is diffed word by word in place', () => {
  const { rows, hunkRows } = layoutDoc(NEW, OLD, 60)
  expect(rows.map(r => textOf(r))).toEqual([
    'Doc',
    '═══',
    '',
    'kept paragraph',
    '',
    'second paragraph about cats and dogs',
    '',
    'third paragraph',
    '',
    'doomed paragraph that goes away',
    '',
    'brand new addition',
  ])
  expect(marked(rows)).toEqual([
    ['changed', 'second paragraph about cats and dogs'],
    ['removed', 'doomed paragraph that goes away'],
    ['added', 'brand new addition'],
  ])
  // whole rows tinted for whole blocks; a changed paragraph tints only its changed words
  expect(tints(rows)).toEqual([
    ['removed', 'doomed paragraph that goes away'],
    ['added', 'brand new addition'],
  ])
  expect((rows[5] as Row).spans.map(s => [s.text, s.backgroundColor ?? ''])).toEqual([
    ['second paragraph about cats', ''],
    [' and dogs', 'diffAddedWord'],
  ])
  const struck = rows.filter(r => r.kind === 'old')
  expect(struck.every(r => r.spans.every(s => s.strikethrough === true && s.dimColor !== true))).toBe(true)
  expect(hunkRows).toEqual([5, 9])
})

test('a changed paragraph shows its removed words struck inline, before the words that replaced them', () => {
  const { rows } = layoutDoc('a\n\nkeep this then new end\n', 'a\n\nkeep this then old end\n', 60)
  const row = rows.find(r => r.mark === 'changed') as Row
  expect(row.spans.map(s => [s.text, s.backgroundColor ?? '', s.strikethrough === true])).toEqual([
    ['keep this then ', '', false],
    ['old', 'diffRemovedWord', true],
    ['new', 'diffAddedWord', false],
    [' end', '', false],
  ])
  expect(rows.some(r => r.kind === 'old')).toBe(false)
})

test('a changed list item and heading are diffed inline too, keeping their bullet and style', () => {
  const { rows } = layoutDoc('# New title\n\n- first item\n', '# Old title\n\n- first thing\n', 60)
  expect(marked(rows).map(([, t]) => t)).toEqual(['OldNew title', '═'.repeat(12), '• first thingitem'])
  expect(rows.some(r => r.kind === 'old')).toBe(false)
})

test('a changed code block is not diffed inline: its old rows are struck and tinted removed, its new rows tinted added', () => {
  const { rows } = layoutDoc('a\n\n```\nnew code\n```\n', 'a\n\n```\nold code\n```\n', 60)
  expect(tints(rows)).toEqual([
    ['added', 'new code'],
    ['removed', '```'],
    ['removed', 'old code'],
    ['removed', '```'],
  ])
})

test('no baseline, or the same text, marks nothing', () => {
  expect(marked(layoutDoc(NEW, undefined, 60).rows)).toEqual([])
  expect(layoutDoc(NEW, undefined, 60).hunkRows).toEqual([])
  expect(marked(layoutDoc(NEW, NEW, 60).rows)).toEqual([])
})

test('every row of a wrapped marked block carries the mark', () => {
  const { rows } = layoutDoc('a\n\nnew words that wrap over several narrow rows\n', 'a\n', 12)
  const added = rows.filter(r => r.mark === 'added')
  expect(added.length).toBeGreaterThan(2)
  expect(added.map(textOf).join(' ')).toBe('new words that wrap over several narrow rows')
})

const grid = (rows: string[]): string => `| key | value |\n|---|---|\n${rows.map(r => `| ${r} |\n`).join('')}`

test('a changed table row marks that row and no other; its old text is not drawn inside the box', () => {
  const before = `# T\n\n${grid(['alpha | 1', 'beta | 2', 'gamma | 3'])}\nafter\n`
  const after = `# T\n\n${grid(['alpha | 1', 'beta | 22', 'gamma | 3'])}\nafter\n`
  const { rows, hunkRows } = layoutDoc(after, before, 60)
  expect(marked(rows)).toEqual([['changed', '│ beta  │ 22    │']])
  expect(rows.some(r => r.kind === 'old')).toBe(false)
  expect(textOf(rows[hunkRows[0] as number] as Row)).toContain('beta')
})

test('a removed table row is listed struck under the table', () => {
  const { rows } = layoutDoc(`${grid(['alpha | 1'])}\nafter\n`, `${grid(['alpha | 1', 'beta | 2'])}\nafter\n`, 60)
  const bottom = rows.findIndex(r => textOf(r).startsWith('└'))
  expect(textOf(rows[bottom + 1] as Row)).toBe('beta │ 2')
  expect(rows[bottom + 1]?.mark).toBe('removed')
})

test('a changed delimiter row marks the header row, the line that draws', () => {
  const before = grid(['a | 1'])
  const { rows } = layoutDoc(before.replace('|---|---|', '|:--|--:|'), before, 60)
  expect(marked(rows)).toEqual([['changed', '│ key │ value │']])
})

test('a removed paragraph just before a table is struck above the table, not inside it', () => {
  const { rows } = layoutDoc(`intro\n\n${grid(['a | 1'])}`, `intro\n\ngone para\n\n${grid(['a | 1'])}`, 60)
  const gone = rows.findIndex(r => textOf(r) === 'gone para')
  expect(gone).toBeGreaterThan(0)
  expect(textOf(rows[gone + 2] as Row).startsWith('┌')).toBe(true)
})

test('hunks after struck rows count them: the hunk row is the row drawn', () => {
  const before = 'a\n\nold one\n\nb\n\nc\n'
  const after = 'a\n\nb\n\nc changed here\n'
  const { rows, hunkRows } = layoutDoc(after, before, 60)
  expect(hunkRows.map(i => textOf(rows[i] as Row))).toEqual(['old one', 'c changed here'])
})
