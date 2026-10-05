import { expect, test } from 'claude-code/testing'

import type { Span } from './inline'
import { inlineOf } from './render'
import { wordDiff } from './words'

const plain = (text: string): Span[] => [{ text }]
/** Each span as [text, background], the background '' when none. */
const tinted = (spans: Span[]) => spans.map(s => [s.text, s.backgroundColor ?? ''])

const diffs: { name: string; old: string; next: string; want: string[][] }[] = [
  {
    name: 'words added at the end',
    old: 'second paragraph about cats',
    next: 'second paragraph about cats and dogs',
    want: [['second paragraph about cats', ''], [' and dogs', 'diffAddedWord']],
  },
  {
    name: 'words replaced: the old words first, then the new',
    old: 'sdasd asd as da',
    next: 'sdasd asd changed',
    want: [['sdasd asd ', ''], ['as da', 'diffRemovedWord'], ['changed', 'diffAddedWord']],
  },
  {
    name: 'a word removed from the middle',
    old: 'one two three',
    next: 'one three',
    want: [['one ', ''], ['two ', 'diffRemovedWord'], ['three', '']],
  },
  {
    name: 'nothing in common',
    old: 'alpha',
    next: 'beta',
    want: [['alpha', 'diffRemovedWord'], ['beta', 'diffAddedWord']],
  },
  {
    name: 'no change',
    old: 'same words',
    next: 'same words',
    want: [['same words', '']],
  },
]

for (const { name, old, next, want } of diffs) {
  test(`wordDiff: ${name}`, () => {
    expect(tinted(wordDiff(plain(old), plain(next)))).toEqual(want)
  })
}

test('wordDiff strikes removed words and keeps each word its own style', () => {
  const got = wordDiff([{ text: 'very ' }, { text: 'bold', bold: true }], [{ text: 'bold', bold: true }, { text: ' claim' }])
  expect(got).toEqual([
    { text: 'very ', backgroundColor: 'diffRemovedWord', strikethrough: true },
    { text: 'bold', bold: true },
    { text: ' claim', backgroundColor: 'diffAddedWord' },
  ])
})

test('wordDiff past its size cap marks the whole old text removed and the whole new text added', () => {
  const many = (word: string) => plain(Array.from({ length: 600 }, (_, i) => `${word}${i}`).join(' '))
  const got = tinted(wordDiff(many('a'), many('b')))
  expect(got.map(([, bg]) => bg)).toEqual(['diffRemovedWord', 'diffAddedWord'])
})

const inlines: { source: string; want: string | undefined }[] = [
  { source: 'just a paragraph', want: 'just a paragraph' },
  { source: 'two lines\nof one paragraph', want: 'two lines of one paragraph' },
  { source: '# A heading', want: 'A heading' },
  { source: '- a list item', want: 'a list item' },
  { source: '1. an ordered item', want: 'an ordered item' },
  { source: '> a quote', want: 'a quote' },
  { source: '```\ncode\n```', want: undefined },
  { source: '| a | b |\n|---|---|', want: undefined },
  // two blocks where the diff saw one: no inline diff
  { source: 'para\n- and a list', want: undefined },
]

for (const { source, want } of inlines) {
  test(`inlineOf(${JSON.stringify(source)}) is ${JSON.stringify(want)}`, () => {
    expect(inlineOf(source)?.map(s => s.text).join('')).toBe(want)
  })
}

test('inlineOf keeps the heading style and inline markup', () => {
  const spans = inlineOf('# Big **bold**') ?? []
  expect(spans.every(s => s.bold === true)).toBe(true)
  expect(spans.map(s => s.text).join('')).toBe('Big bold')
})
