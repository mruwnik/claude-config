import { expect, test } from 'claude-code/testing'

import { blocks, compare, countChanges, diffBlocks, fnv1a, snapshotPath } from './diff'
import type { Change } from './diff'

const fence = '```'
const ops = (changes: Change[]): string[] => changes.map(c => c.op)
const diff = (a: string, b: string): Change[] => diffBlocks(blocks(a), blocks(b))

const blockCases: { name: string; text: string; kinds: string[]; texts: string[]; lines: number[] }[] = [
  { name: 'heading and paragraphs', text: '# T\n\none\ntwo\n\nthree\n', kinds: ['heading', 'paragraph', 'paragraph'], texts: ['# T\n', 'one\ntwo\n', 'three\n'], lines: [0, 2, 5] },
  { name: 'list items with continuation', text: '- a\n  more\n- b\n  - nested\n1. c\n', kinds: ['list-item', 'list-item', 'list-item', 'list-item'], texts: ['- a\n  more\n', '- b\n', '  - nested\n', '1. c\n'], lines: [0, 2, 3, 4] },
  { name: 'fence is one block, blanks inside kept', text: `${fence}js\na\n\n# not heading\n${fence}\nafter\n`, kinds: ['code', 'paragraph'], texts: [`${fence}js\na\n\n# not heading\n${fence}\n`, 'after\n'], lines: [0, 5] },
  { name: 'table rows are blocks', text: 'x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', kinds: ['paragraph', 'table-row', 'table-row', 'table-row'], texts: ['x\n', '| a | b |\n', '|---|---|\n', '| 1 | 2 |\n'], lines: [0, 2, 3, 4] },
  { name: 'unclosed fence runs to the end', text: `${fence}\na\nb`, kinds: ['code'], texts: [`${fence}\na\nb`], lines: [0] },
  { name: 'empty', text: '', kinds: [], texts: [], lines: [] },
  { name: 'only blanks', text: '\n\n', kinds: [], texts: [], lines: [] },
]

for (const { name, text, kinds, texts, lines } of blockCases) {
  test(`blocks: ${name}`, () => {
    const bs = blocks(text)
    expect(bs.map(b => b.kind)).toEqual(kinds)
    expect(bs.map(b => b.text)).toEqual(texts)
    expect(bs.map(b => b.line)).toEqual(lines)
  })
}

const roundTrips: string[] = [
  '',
  '\n\n# a\n\n\npara\n\n',
  '- a\n\n  cont\n\n- b\n',
  `x\n\n${fence}\ncode\n\n${fence}\n\n| a |\n|---|\n| 1 |\n\n\ntail`,
  'a\r\n\r\nb\r\n',
  '| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n',
]

for (const text of roundTrips) {
  test(`blocks raw concatenates back to the text: ${JSON.stringify(text)}`, () => {
    expect(blocks(text).map(b => b.raw).join('')).toBe(text)
  })
}

test('table rows are tagged with table, row index and part', () => {
  const bs = blocks('| a |\n|---|\n| 1 |\n| 2 |\n\ntext\n\n| b |\n|---|\n| 3 |\n')
  expect(bs.filter(b => b.kind === 'table-row').map(b => [b.table, b.rowIndex, b.part])).toEqual([
    [0, 0, 'header'], [0, 1, 'delimiter'], [0, 2, 'body'], [0, 3, 'body'],
    [1, 0, 'header'], [1, 1, 'delimiter'], [1, 2, 'body'],
  ])
})

const table = (rows: string[]): string => `| k | v |\n|---|---|\n${rows.join('\n')}\n`

const diffCases: { name: string; old: string; next: string; ops: string[]; hunks: number }[] = [
  { name: 'no change', old: '# T\n\na\n\nb\n', next: '# T\n\na\n\nb\n', ops: ['same', 'same', 'same'], hunks: 0 },
  { name: 'insert paragraph', old: 'a\n\nc\n', next: 'a\n\nb\n\nc\n', ops: ['same', 'added', 'same'], hunks: 1 },
  { name: 'delete paragraph', old: 'a\n\nb\n\nc\n', next: 'a\n\nc\n', ops: ['same', 'removed', 'same'], hunks: 1 },
  { name: 'reword paragraph', old: 'the quick brown fox jumps\n', next: 'the quick brown fox leaps\n', ops: ['changed'], hunks: 1 },
  { name: 'unrelated replacement is removed plus added', old: 'alpha beta gamma\n', next: 'one two three four\n', ops: ['removed', 'added'], hunks: 1 },
  { name: 'one table row changed', old: table(['| a | 1 |', '| b | 2 |', '| c | 3 |']), next: table(['| a | 1 |', '| b | 22 |', '| c | 3 |']), ops: ['same', 'same', 'same', 'changed', 'same'], hunks: 1 },
  { name: 'edit inside a fence changes the whole fence', old: `x\n\n${fence}\na = 1\nb = 2\n${fence}\n`, next: `x\n\n${fence}\na = 1\nb = 3\n${fence}\n`, ops: ['same', 'changed'], hunks: 1 },
  { name: 'heading moved', old: '# H\n\np1\n\np2\n\np3\n', next: 'p1\n\np2\n\np3\n\n# H\n', ops: ['removed', 'same', 'same', 'same', 'added'], hunks: 2 },
  { name: 'two separate edits are two hunks', old: 'a\n\nb\n\nc\n\nd\n', next: 'a\n\nx y\n\nc\n\nd\n\ne\n', ops: ['same', 'removed', 'added', 'same', 'same', 'added'], hunks: 2 },
  { name: 'CRLF equals LF', old: 'a\r\n\r\nb\r\n', next: 'a\n\nb\n', ops: ['same', 'same'], hunks: 0 },
  { name: 'trailing whitespace is ignored', old: 'a  \n\nb\n', next: 'a\n\nb\t\n', ops: ['same', 'same'], hunks: 0 },
]

for (const { name, old, next, ops: expected, hunks } of diffCases) {
  test(`diffBlocks: ${name}`, () => {
    const changes = diff(old, next)
    expect(ops(changes)).toEqual(expected)
    expect(countChanges(changes)).toBe(hunks)
  })
}

test('a reworded paragraph carries its old text; the changed table row is only that row', () => {
  const [c] = diff('the quick brown fox jumps\n', 'the quick brown fox leaps\n')
  expect(c).toMatchObject({ op: 'changed', old: { text: 'the quick brown fox jumps\n' }, block: { text: 'the quick brown fox leaps\n' } })
  const row = diff(table(['| a | 1 |', '| b | 2 |']), table(['| a | 1 |', '| b | 9 |'])).find(x => x.op === 'changed')
  expect(row).toMatchObject({ old: { text: '| b | 2 |\n', table: 0, rowIndex: 3 }, block: { text: '| b | 9 |\n' } })
})

test('removed blocks keep their old position and the new blocks follow the new doc', () => {
  const changes = diff('a\n\nb\n\nc\n', 'a\n\nc\n\nd\n')
  expect(changes.map(c => (c.op === 'removed' ? c.block.text : c.op + ':' + c.block.text))).toEqual(['same:a\n', 'b\n', 'same:c\n', 'added:d\n'])
})

const noBaseline: (string | undefined)[] = [undefined, '', '\n \n']

for (const baseline of noBaseline) {
  test(`compare with no baseline marks nothing: ${JSON.stringify(baseline)}`, () => {
    const changes = compare(baseline, 'a\n\nb\n')
    expect(ops(changes)).toEqual(['same', 'same'])
    expect(countChanges(changes)).toBe(0)
  })
}

test('diffBlocks with an empty old is all added', () => {
  expect(ops(diff('', 'a\n\nb\n'))).toEqual(['added', 'added'])
})

test('countChanges counts runs', () => {
  const b = blocks('a\n\nb\n\nc\n')
  const [x, y, z] = b as [(typeof b)[0], (typeof b)[0], (typeof b)[0]]
  expect(countChanges([{ op: 'added', block: x }, { op: 'removed', block: y }, { op: 'same', block: z }, { op: 'added', block: x }])).toBe(2)
  expect(countChanges([])).toBe(0)
})

const bigDoc = (n: number): string => Array.from({ length: n }, (_, i) => `paragraph number ${i} with some words in it`).join('\n\n') + '\n'

test('a 5000-block doc with a handful of edits diffs correctly', () => {
  const old = bigDoc(5000).split('\n\n')
  const next = [...old]
  next[10] = 'edited ten completely different'
  next.splice(1000, 1)
  next.splice(2500, 0, 'brand new block here')
  next[4900] = 'paragraph number 4900 with some words in it, reworded'
  const changes = diff(old.join('\n\n'), next.join('\n\n'))
  expect(changes.filter(c => c.op === 'same').length).toBe(4997)
  expect(countChanges(changes)).toBe(4)
  expect(changes.filter(c => c.op === 'changed').map(c => c.block.text.trim())).toContain('paragraph number 4900 with some words in it, reworded')
  expect(changes.filter(c => c.op === 'removed').length).toBe(2)
  expect(changes.filter(c => c.op === 'added').length).toBe(2)
})

test('a wholly different doc falls back to removed plus added', () => {
  const old = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join('\n\n')
  const next = Array.from({ length: 2000 }, (_, i) => `new ${i} x y`).join('\n\n')
  const changes = diff(old, next)
  expect(changes.filter(c => c.op === 'same').length).toBe(0)
  expect(countChanges(changes)).toBe(1)
})

test('snapshotPath is stable, keyed by the path, under the home dir', () => {
  expect(snapshotPath('/home/u', '/a/b.md')).toBe(snapshotPath('/home/u', '/a/b.md'))
  expect(snapshotPath('/home/u', '/a/b.md')).not.toBe(snapshotPath('/home/u', '/a/c.md'))
  expect(snapshotPath('/home/u', '/a/b.md')).toMatch(/^\/home\/u\/\.claude\/md-view\/snapshots\/[0-9a-f]{8}\.md$/)
})

test('fnv1a matches known vectors', () => {
  expect(fnv1a('')).toBe('811c9dc5')
  expect(fnv1a('a')).toBe('e40c292c')
})
