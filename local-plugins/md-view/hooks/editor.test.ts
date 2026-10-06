import { expect, test } from 'claude-code/testing'

import { applyKey, fromText, toText, visibleLines } from './editor'
import type { Editor } from './editor'

const VIEW = { rows: 5, columns: 20 }

/** The editor after each key in turn, from `text` with the cursor at its start. */
const typed = (text: string, keys: ({ key: string; ctrl?: true; shift?: true; meta?: true } | string)[]): Editor =>
  keys.reduce<Editor>((ed, k) => {
    const out = applyKey(ed, typeof k === 'string' ? { key: k } : k, VIEW)
    return out.kind === 'edit' ? out.editor : ed
  }, fromText(text))

const at = (ed: Editor) => [ed.row, ed.col]

test('fromText and toText round-trip, a trailing newline included', () => {
  for (const text of ['', 'a', 'a\nb', 'a\n', '\n\n']) expect(toText(fromText(text))).toBe(text)
})

test('fromText reads CRLF as lines', () => {
  expect(fromText('a\r\nb').lines).toEqual(['a', 'b'])
})

const EDITS = [
  ['a printable key inserts at the cursor', 'bc', ['a'], 'abc', [0, 1]],
  ['space by name inserts a space', 'ab', ['right', 'space'], 'a b', [0, 2]],
  ['a paste inserts every character', 'x', ['Hi, you'], 'Hi, youx', [0, 7]],
  ['a pasted newline splits the line', 'x', ['a\nb'], 'a\nbx', [1, 1]],
  ['return splits the line', 'abcd', ['right', 'right', 'return'], 'ab\ncd', [1, 0]],
  ['backspace deletes before the cursor', 'abc', ['end', 'backspace'], 'ab', [0, 2]],
  ['backspace at a line start joins it to the one above', 'ab\ncd', ['down', 'backspace'], 'abcd', [0, 2]],
  ['backspace at the very start does nothing', 'ab', ['backspace'], 'ab', [0, 0]],
  ['delete removes the character at the cursor', 'abc', ['delete'], 'bc', [0, 0]],
  ['delete at a line end joins the next line', 'ab\ncd', ['end', 'delete'], 'abcd', [0, 2]],
  ['tab inserts two spaces', 'a', ['tab'], '  a', [0, 2]],
  ['ctrl+k cuts to the line end', 'abcd', ['right', { key: 'k', ctrl: true }], 'a', [0, 1]],
  ['a wide character counts as one step', '日本', ['right', 'x'], '日x本', [0, 2]],
] as const

for (const [name, text, keys, want, cursor] of EDITS) {
  test(name, () => {
    const ed = typed(text, [...keys])
    expect(toText(ed)).toBe(want)
    expect(at(ed)).toEqual([...cursor])
  })
}

const MOVES = [
  ['right at a line end goes to the next line', 'ab\ncd', ['end', 'right'], [1, 0]],
  ['left at a line start goes to the previous line end', 'ab\ncd', ['down', 'left'], [0, 2]],
  ['down keeps the column it wanted past a short line', 'abcd\na\nabcd', ['end', 'down', 'down'], [2, 4]],
  ['up from the first line goes to its start', 'abc', ['end', 'up'], [0, 0]],
  ['down from the last line goes to its end', 'abc', ['down'], [0, 3]],
  ['ctrl+a and ctrl+e are home and end', 'abc', [{ key: 'e', ctrl: true }, 'x', { key: 'a', ctrl: true }, 'y'], [0, 1]],
  ['pagedown moves a window of text rows', Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'), ['pagedown'], [4, 0]],
  ['pageup from the top stays at the top', 'a\nb', ['pageup'], [0, 0]],
] as const

for (const [name, text, keys, cursor] of MOVES) {
  test(name, () => {
    expect(at(typed(text, [...keys]))).toEqual([...cursor])
  })
}

test('ctrl+s asks to save; other ctrl keys and unknown names change nothing', () => {
  const ed = fromText('abc')
  expect(applyKey(ed, { key: 's', ctrl: true }, VIEW)).toEqual({ kind: 'save' })
  for (const key of [{ key: 'z', ctrl: true as const }, { key: 'f1' }, { key: 'x', meta: true as const }]) {
    expect(applyKey(ed, key, VIEW)).toEqual({ kind: 'none' })
  }
})

test('the window follows the cursor down and back up', () => {
  const text = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  const down = typed(text, Array.from({ length: 10 }, () => 'down'))
  // five rows, one of them the status line: four text rows, so row 10 shows last
  expect(down.top).toBe(7)
  const up = typed(text, [...Array.from({ length: 10 }, () => 'down'), ...Array.from({ length: 9 }, () => 'up')])
  expect(up.top).toBe(1)
})

test('the window scrolls sideways to keep the cursor in its columns', () => {
  const ed = typed('x'.repeat(50), ['end'])
  // 20 columns less the 2-column gutter: the cursor cell is the last of 18
  expect(ed.left).toBe(33)
  expect(typed('x'.repeat(50), ['end', 'home']).left).toBe(0)
})

test('visibleLines cuts each line to the window and splits the cursor line round the cursor', () => {
  const ed = typed('hello world\nsecond', ['right', 'right'])
  const lines = visibleLines(ed, VIEW)
  expect(lines).toHaveLength(2)
  expect(lines[0]).toEqual({ before: 'he', cursor: 'l', after: 'lo world' })
  expect(lines[1]).toEqual({ before: 'second' })
})

test('the cursor past a line end is drawn as a space', () => {
  const lines = visibleLines(typed('ab', ['end']), VIEW)
  expect(lines[0]).toEqual({ before: 'ab', cursor: ' ', after: '' })
})
