import { expect, test } from 'claude-code/testing'

import { parseInline } from './inline'
import type { Span } from './inline'
import { renderMarkdown, sanitize, wrapSpans } from './render'
import type { Row } from './render'
import { strWidth } from './width'

const fence = '```'
const textOf = (row: Row): string => row.spans.map(s => s.text).join('')
const texts = (md: string, width = 60): string[] => renderMarkdown(md, width).rows.map(textOf)
const spanOf = (spans: Span[], text: string): Span | undefined => spans.find(s => s.text === text)

const widthCases: Array<{ name: string; text: string; width: number }> = [
  { name: 'ascii', text: 'abc', width: 3 },
  { name: 'wide CJK counts two', text: '漢字', width: 4 },
  { name: 'emoji counts two', text: '🙂', width: 2 },
  { name: 'box drawing counts one', text: '│─┌', width: 3 },
]
for (const { name, text, width } of widthCases) test(`strWidth: ${name}`, () => expect(strWidth(text)).toBe(width))

test('sanitize drops CRs and control characters and expands tabs to 4-column stops', () => {
  expect(sanitize('a\r\nb\u0007c\n\tx\nab\ty')).toBe('a\nbc\n    x\nab  y')
})

const inlineCases: Array<{ name: string; md: string; want: Array<Partial<Span> & { text: string }> }> = [
  { name: 'bold', md: 'a **b** c', want: [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }] },
  { name: 'italic star', md: '*i*', want: [{ text: 'i', italic: true }] },
  { name: 'italic underscore', md: '_i_', want: [{ text: 'i', italic: true }] },
  { name: 'snake_case stays plain', md: 'snake_case_name', want: [{ text: 'snake_case_name' }] },
  { name: 'bold italic', md: '***x***', want: [{ text: 'x', bold: true, italic: true }] },
  { name: 'strike', md: '~~s~~', want: [{ text: 's', strikethrough: true }] },
  { name: 'code keeps stars', md: '`a*b*`', want: [{ text: 'a*b*', color: 'suggestion' }] },
  { name: 'double backtick code', md: '`` a`b ``', want: [{ text: 'a`b', color: 'suggestion' }] },
  { name: 'escaped star', md: '\\*no\\*', want: [{ text: '*no*' }] },
  { name: 'link shows its text underlined', md: '[site](http://x.y)', want: [{ text: 'site', underline: true, color: 'permission' }] },
  { name: 'autolink', md: '<http://x.y>', want: [{ text: 'http://x.y', underline: true, color: 'permission' }] },
  { name: 'bare url', md: 'see https://x.y/z.', want: [{ text: 'see ' }, { text: 'https://x.y/z', underline: true, color: 'permission' }, { text: '.' }] },
  { name: 'bold inside link', md: '[**b**](u)', want: [{ text: 'b', bold: true, underline: true, color: 'permission' }] },
  { name: 'italic inside bold', md: '**a *b* c**', want: [{ text: 'a ', bold: true }, { text: 'b', bold: true, italic: true }, { text: ' c', bold: true }] },
  { name: 'unclosed star is literal', md: 'a * b', want: [{ text: 'a * b' }] },
  { name: 'image shows its alt', md: '![alt text](p.png)', want: [{ text: '[image: alt text]', dimColor: true }] },
  { name: 'footnote ref is plain', md: 'x[^1]', want: [{ text: 'x[^1]' }] },
  { name: 'inline html is plain', md: 'a <b>c</b>', want: [{ text: 'a <b>c</b>' }] },
]
for (const { name, md, want } of inlineCases) test(`parseInline: ${name}`, () => expect(parseInline(md)).toEqual(want))

const prose = 'The quick brown fox jumps over the lazy dog, then naps by a well-known river bank. '.repeat(4)
const wrapWidths = [80, 40, 23, 10, 5, 2, 1]
for (const width of wrapWidths) {
  test(`wrapSpans at ${width} never exceeds the width and keeps every non-space character`, () => {
    const lines = wrapSpans([{ text: prose }, { text: 'supercalifragilisticexpialidocious', bold: true }], width)
    const joined = lines.map(l => l.map(s => s.text).join(''))
    expect(Math.max(...joined.map(strWidth))).toBeLessThanOrEqual(width)
    expect(joined.join('').replace(/\s/g, '')).toBe((prose + 'supercalifragilisticexpialidocious').replace(/\s/g, ''))
  })
}

test('wrapSpans breaks at a hard break and keeps styles on wrapped words', () => {
  const lines = wrapSpans([{ text: 'one\ntwo ' }, { text: 'bold word', bold: true }], 8)
  expect(lines.map(l => l.map(s => s.text).join(''))).toEqual(['one', 'two bold', 'word'])
  expect(lines[2]).toEqual([{ text: 'word', bold: true }])
})

const docWidths = [100, 60, 30, 12, 6]
const bigDoc = [
  '# Title heading that is long enough to wrap',
  '',
  'Para with **bold**, *it*, `code`, ~~gone~~ and [a link](http://example.com/very/long/path) plus 漢字 and 🙂.',
  '',
  '- item one with some words',
  '  - nested item with more words',
  '    1. deep ordered',
  '- [ ] task open',
  '- [x] task done',
  '',
  '> quoted text that goes on for a while',
  '> > nested quote',
  '',
  `${fence}ts`,
  'const x = "a very long line of code that will not fit in a narrow pane at all"',
  '    indented()',
  fence,
  '',
  '    indented code block',
  '',
  '---',
  '',
  '| Name | Value |',
  '|---|---|',
  '| alpha | a long value in a cell that wraps |',
  '| beta | 2 |',
  '',
  '<div>html stays</div>',
  '',
  '[^1]: footnote text',
].join('\n')

for (const width of docWidths) {
  test(`renderMarkdown at width ${width}: no row is wider than the width`, () => {
    const rows = renderMarkdown(sanitize(bigDoc), width).rows
    expect(rows.length).toBeGreaterThan(10)
    expect(Math.max(...rows.map(r => strWidth(textOf(r))))).toBeLessThanOrEqual(width)
  })
}

const words = (s: string): string[] => s.match(/[A-Za-z]{3,}/g) ?? []
for (const width of [100, 60, 30]) {
  test(`renderMarkdown at width ${width}: every word of the doc shows`, () => {
    const drawn = texts(sanitize(bigDoc), width).join(' ').replace(/[│┌┐└┘├┤┬┴┼─↩]/g, ' ')
    const glued = drawn.replace(/\s/g, '')
    const missing = words(bigDoc.replace(/http:\S+\)/g, '').replace(/```ts/, '')).filter(w => !glued.includes(w))
    expect(missing).toEqual([])
  })
}

const blockCases: Array<{ name: string; md: string; want: string[] }> = [
  { name: 'heading 1 gets a rule under it', md: '# Hi', want: ['Hi', '══'] },
  { name: 'heading 2 gets a thin rule', md: '## Hi there', want: ['Hi there', '────────'] },
  { name: 'heading 3 has no rule', md: '### Three #', want: ['Three'] },
  { name: 'setext heading', md: 'Hi\n===', want: ['Hi', '══'] },
  { name: 'blank line between blocks', md: 'a\n\nb', want: ['a', '', 'b'] },
  { name: 'soft line breaks join', md: 'a\nb', want: ['a b'] },
  { name: 'hard line break', md: 'a  \nb', want: ['a', 'b'] },
  { name: 'bullets nest with hanging indent', md: '- a\n  - b\n- c', want: ['• a', '  ◦ b', '• c'] },
  { name: 'ordered list numbers from its start', md: '3. a\n4. b', want: ['3. a', '4. b'] },
  { name: 'task list', md: '- [ ] a\n- [x] b', want: ['• [ ] a', '• [x] b'] },
  { name: 'loose list keeps blank lines', md: '- a\n\n- b', want: ['• a', '', '• b'] },
  { name: 'list item continuation paragraph', md: '- a\n\n  more', want: ['• a', '', '  more'] },
  { name: 'quote gutter, nested', md: '> a\n> > b', want: ['│ a', '│', '│ │ b'] },
  { name: 'fenced code keeps indentation', md: `${fence}\n  x\n${fence}`, want: ['  x'] },
  { name: 'indented code', md: '    x = 1', want: ['x = 1'] },
  { name: 'rule fills the width', md: '***', want: ['──────────'] },
  { name: 'html block is plain text', md: '<div>\nhi\n</div>', want: ['<div>', 'hi', '</div>'] },
  { name: 'table', md: '| a | b |\n|---|---|\n| 1 | 2 |', want: ['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘'] },
]
for (const { name, md, want } of blockCases) {
  test(`renderMarkdown: ${name}`, () => expect(texts(md, 10).map(t => t.trimEnd())).toEqual(want))
}

test('a long code line wraps with a marker at the cut', () => {
  const got = texts(`${fence}\n${'x'.repeat(25)}\n${fence}`, 10)
  expect(got).toEqual(['xxxxxxxxx↩', 'xxxxxxxxx↩', 'xxxxxxx'])
})

test('heading, code and table header styles', () => {
  const rows = renderMarkdown(`# H\n\n${fence}\nc\n${fence}\n\n| a |\n|---|\n| 1 |`, 20).rows
  expect(rows[0]?.spans[0]).toMatchObject({ text: 'H', bold: true, color: 'claude' })
  expect(rows.find(r => r.kind === 'code')?.spans[0]).toMatchObject({ text: 'c', color: 'suggestion' })
  const header = rows.find(r => textOf(r) === '│ a │')
  expect(header?.spans[0]?.bold).toBe(true)
  expect(spanOf(rows.find(r => textOf(r) === '│ 1 │')?.spans ?? [], '│ 1 │')?.bold).toBeUndefined()
})

test('rows name the source lines they draw; tables are listed with their header height', () => {
  const md = 'para\n\n| a |\n|---|\n| 1 |\n| 2 |\n'
  const { rows, tables } = renderMarkdown(md, 20)
  expect(rows.map(r => r.lines)).toEqual([[0, 1], undefined, undefined, [2, 3], undefined, [4, 5], [5, 6], undefined])
  expect(tables).toEqual([{ id: 0, start: 2, headerRows: 3, end: 7 }])
  expect(rows.slice(2).every(r => r.table?.id === 0)).toBe(true)
})

test('a table inside a list item is indented and still listed', () => {
  const { rows, tables } = renderMarkdown('- x\n\n  | a |\n  |---|\n  | 1 |\n', 20)
  expect(rows.map(textOf)).toEqual(['• x', '', '  ┌───┐', '  │ a │', '  ├───┤', '  │ 1 │', '  └───┘'])
  expect(tables[0]).toMatchObject({ start: 2, headerRows: 3, end: 6 })
})

test('a table too narrow for a box falls back to blocks and has no header to pin', () => {
  const { tables } = renderMarkdown(`| ${'h'.repeat(20)} | ${'g'.repeat(20)} |\n|---|---|\n| 1 | 2 |\n`, 12)
  expect(tables[0]?.headerRows).toBe(0)
})

// A 200×300 picture: at 10 columns it is 10 * 300 / 200 / 2 = 8 rows.
const images = { sizes: new Map([['p.png', { pixelsWide: 200, pixelsHigh: 300 }]]), maxRows: 40 }
const imageRows = (md: string, width = 60, opts = images): Row[] => renderMarkdown(md, width, new Map(), opts).rows

const imageCases: Array<{ name: string; md: string; want: { columns: number; rows: number } }> = [
  { name: 'markdown image gets the default width', md: '![cover](p.png)', want: { columns: 30, rows: 23 } },
  { name: 'img tag width is columns', md: '<img src="p.png" alt="cover" width="10">', want: { columns: 10, rows: 8 } },
  { name: 'img tag width can be a share of the width', md: '<img src="p.png" alt="cover" width="50%">', want: { columns: 30, rows: 23 } },
]
for (const { name, md, want } of imageCases) {
  test(`image: ${name}`, () => {
    const rows = imageRows(md)
    expect(rows.length).toBe(want.rows)
    expect(rows.every(r => r.kind === 'image')).toBe(true)
    expect(rows[0]?.image).toEqual({ src: 'p.png', alt: 'cover', ...want })
    expect(rows.slice(1).every(r => r.image === undefined)).toBe(true)
  })
}

test('image: a picture taller than the window shrinks to fit it', () => {
  const rows = imageRows('![cover](p.png)', 60, { ...images, maxRows: 10 })
  expect(rows.length).toBe(10)
  expect(rows[0]?.image).toEqual({ src: 'p.png', alt: 'cover', columns: 13, rows: 10 })
})

test('image: an unmeasured picture is one placeholder row naming what to measure', () => {
  const rows = imageRows('![cover](q.png)')
  expect(rows.map(textOf)).toEqual(['[image: cover]'])
  expect(rows[0]?.image).toEqual({ src: 'q.png', alt: 'cover' })
})

test('image: mid-paragraph and in code it stays text', () => {
  expect(texts('see ![x](p.png) here')).toEqual(['see [image: x] here'])
  expect(imageRows(`${fence}\n![x](p.png)\n${fence}`).some(r => r.kind === 'image')).toBe(false)
})
