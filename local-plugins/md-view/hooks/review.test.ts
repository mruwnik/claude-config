import { expect, test } from 'claude-code/testing'

import { compare, countChanges } from './diff'
import { acceptHunk, rejectHunk } from './review'

const reviews: { name: string; baseline: string; text: string; hunk: number; accepted: string; rejected: string }[] = [
  {
    name: 'a changed paragraph',
    baseline: 'a\n\nold words\n\nc\n',
    text: 'a\n\nnew words\n\nc\n',
    hunk: 0,
    accepted: 'a\n\nnew words\n\nc\n',
    rejected: 'a\n\nold words\n\nc\n',
  },
  {
    name: 'an added paragraph',
    baseline: 'a\n\nc\n',
    text: 'a\n\nadded\n\nc\n',
    hunk: 0,
    accepted: 'a\n\nadded\n\nc\n',
    rejected: 'a\n\nc\n',
  },
  {
    name: 'a removed paragraph in the middle',
    baseline: 'a\n\nb\n\nc\n',
    text: 'a\n\nc\n',
    hunk: 0,
    accepted: 'a\n\nc\n',
    rejected: 'a\n\nb\n\nc\n',
  },
  {
    name: 'a removed last paragraph: put back after a blank line, not merged into the one before',
    baseline: 'a\n\nb\n',
    text: 'a\n',
    hunk: 0,
    accepted: 'a\n',
    rejected: 'a\n\nb\n',
  },
  {
    name: 'an added last paragraph after a doc with no final newline',
    baseline: 'a',
    text: 'a\n\nb\n',
    hunk: 0,
    accepted: 'a\n\nb\n',
    rejected: 'a\n',
  },
  {
    name: 'the first of two changes: the second stays as it is',
    baseline: 'one\n\ntwo\n\nthree\n\nfour\n',
    text: 'ONE\n\ntwo\n\nthree\n\nFOUR\n',
    hunk: 0,
    accepted: 'ONE\n\ntwo\n\nthree\n\nfour\n',
    rejected: 'one\n\ntwo\n\nthree\n\nFOUR\n',
  },
  {
    name: 'the second of two changes',
    baseline: 'one\n\ntwo\n\nthree\n\nfour\n',
    text: 'ONE\n\ntwo\n\nthree\n\nFOUR\n',
    hunk: 1,
    accepted: 'one\n\ntwo\n\nthree\n\nFOUR\n',
    rejected: 'ONE\n\ntwo\n\nthree\n\nfour\n',
  },
  {
    name: 'list items changed and added in one hunk',
    baseline: '- one\n- two\n',
    text: '- one\n- 2\n- three\n',
    hunk: 0,
    accepted: '- one\n- 2\n- three\n',
    rejected: '- one\n- two\n',
  },
  {
    name: 'a removed list item keeps the list tight',
    baseline: '- one\n- two\n- three\n',
    text: '- one\n- three\n',
    hunk: 0,
    accepted: '- one\n- three\n',
    rejected: '- one\n- two\n- three\n',
  },
  {
    name: 'an unknown hunk changes nothing',
    baseline: 'a\n\nb\n',
    text: 'a\n\nB\n',
    hunk: 5,
    accepted: 'a\n\nb\n',
    rejected: 'a\n\nB\n',
  },
]

for (const { name, baseline, text, hunk, accepted, rejected } of reviews) {
  test(`acceptHunk: ${name}`, () => {
    expect(acceptHunk(baseline, text, hunk)).toBe(accepted)
  })
  test(`rejectHunk: ${name}`, () => {
    expect(rejectHunk(baseline, text, hunk)).toBe(rejected)
  })
}

test('accepting or rejecting a hunk leaves one change fewer', () => {
  const baseline = 'one\n\ntwo\n\nthree\n\nfour\n'
  const text = 'ONE\n\ntwo\n\nnew\n\nthree\n\nFOUR\n'
  expect(countChanges(compare(baseline, text))).toBe(3)
  expect(countChanges(compare(acceptHunk(baseline, text, 1), text))).toBe(2)
  expect(countChanges(compare(baseline, rejectHunk(baseline, text, 1)))).toBe(2)
})
