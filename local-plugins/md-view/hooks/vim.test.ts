import { expect, test } from 'claude-code/testing'

import { toText } from './editor'
import { startVim, vimKey } from './vim'
import type { Effect, Vim } from './vim'

const VIEW = { rows: 10, columns: 40 }

/** `keys` as the editor receives them: one per character, `<Name>` a named key, `<C-x>` ctrl+x. */
const parseKeys = (keys: string) =>
  [...keys.matchAll(/<C-(.)>|<([A-Za-z]+)>|(.)/gsu)].map(([, ctrl, name, ch]) =>
    ctrl !== undefined ? { key: ctrl, ctrl: true as const } : { key: name ?? (ch as string) },
  )

type Run = { vim: Vim; effects: Effect[] }

const run = (text: string, keys: string): Run =>
  parseKeys(keys).reduce<Run>(
    (acc, k) => {
      const out = vimKey(acc.vim, k, VIEW)
      return { vim: out.vim, effects: out.effect === undefined ? acc.effects : [...acc.effects, out.effect] }
    },
    { vim: startVim(text), effects: [] },
  )

const textOf = (r: Run) => toText(r.vim.editor)
const cursorOf = (r: Run) => [r.vim.editor.row, r.vim.editor.col]

const EDITS = [
  ['i inserts before the cursor; jk leaves insert', 'world', 'ihello jk', 'hello world', [0, 5]],
  ['ctrl+c leaves insert too', 'b', 'ia<C-c>', 'ab', [0, 0]],
  ['a appends after the cursor', 'ac', 'abjk', 'abc', [0, 1]],
  ['A appends at the line end', 'ab', 'Acjk', 'abc', [0, 2]],
  ['I inserts at the first non-blank', '  ab', 'Ixjk', '  xab', [0, 2]],
  ['o opens a line below', 'a\nc', 'objk', 'a\nb\nc', [1, 0]],
  ['O opens a line above', 'b', 'Oajk', 'a\nb', [0, 0]],
  ['a j not followed by k stays typed', 'x', 'ijojk', 'jox', [0, 1]],
  ['x deletes the character under the cursor', 'abc', 'x', 'bc', [0, 0]],
  ['3x deletes three', 'abcde', '3x', 'de', [0, 0]],
  ['x at the last character moves the cursor back', 'abc', '$x', 'ab', [0, 1]],
  ['dd deletes the line', 'a\nb\nc', 'jdd', 'a\nc', [1, 0]],
  ['2dd deletes two lines', 'a\nb\nc', '2dd', 'c', [0, 0]],
  ['dd on the only line leaves it empty', 'a', 'dd', '', [0, 0]],
  ['dw deletes to the next word', 'foo bar baz', 'dw', 'bar baz', [0, 0]],
  ['d2w deletes two words', 'foo bar baz', 'd2w', 'baz', [0, 0]],
  ['dw on the last word stops at the line end', 'foo bar\nnext', 'wdw', 'foo \nnext', [0, 3]],
  ['de deletes to the word end', 'foo bar', 'de', ' bar', [0, 0]],
  ['db deletes back to the word start', 'foo bar', '$db', 'foo r', [0, 4]],
  ['d$ and D delete to the line end', 'foo bar', 'wD', 'foo ', [0, 3]],
  ['d0 deletes to the line start', 'foo bar', 'wd0', 'bar', [0, 0]],
  ['dj deletes this line and the next', 'a\nb\nc', 'dj', 'c', [0, 0]],
  ['dG deletes to the end', 'a\nb\nc', 'jdG', 'a', [0, 0]],
  ['cw changes to the word end, keeping the space', 'foo bar', 'cwbazjk', 'baz bar', [0, 2]],
  ['cc changes the whole line', 'foo\nbar', 'ccxjk', 'x\nbar', [0, 0]],
  ['C changes to the line end', 'foo bar', 'wCxjk', 'foo x', [0, 4]],
  ['yy then p puts the line below', 'a\nb', 'yyp', 'a\na\nb', [1, 0]],
  ['yy then P puts the line above', 'a\nb', 'jyyP', 'a\nb\nb', [1, 0]],
  ['dd then p moves a line down', 'a\nb\nc', 'ddp', 'b\na\nc', [1, 0]],
  ['yw then P puts the word and its space before the cursor', 'foo bar baz', 'wywP', 'foo bar bar baz', [0, 7]],
  ['x then p swaps two characters', 'ab', 'xp', 'ba', [0, 1]],
  ['r replaces the character under the cursor', 'abc', 'lrx', 'axc', [0, 1]],
  ['J joins the next line with a space', 'a\n  b', 'J', 'a b', [0, 1]],
  ['u undoes the last change', 'abc', 'xxu', 'bc', [0, 0]],
  ['an insert session is one undo', 'z', 'iabcjku', 'z', [0, 0]],
  ['ctrl+r redoes', 'abc', 'xu<C-r>', 'bc', [0, 0]],
  ['u with nothing to undo leaves the text', 'abc', 'u', 'abc', [0, 0]],
] as const

for (const [name, text, keys, want, cursor] of EDITS) {
  test(name, () => {
    const r = run(text, keys)
    expect(textOf(r)).toBe(want)
    expect(cursorOf(r)).toEqual([...cursor])
  })
}

const MOVES = [
  ['h j k l move', 'abc\ndef', 'lljh', [1, 1]],
  ['l stops at the last character in normal mode', 'abc', '5l', [0, 2]],
  ['a count moves that many', 'a\nb\nc\nd', '3j', [3, 0]],
  ['w goes to the next word start', 'foo bar', 'w', [0, 4]],
  ['w treats punctuation as its own word', 'foo.bar', 'w', [0, 3]],
  ['w crosses a line end', 'foo\nbar', 'w', [1, 0]],
  ['w stops on an empty line', 'foo\n\nbar', 'w', [1, 0]],
  ['b goes back a word', 'foo bar', '$b', [0, 4]],
  ['e goes to the word end', 'foo bar', 'e', [0, 2]],
  ['e from a word end goes to the next', 'foo bar', 'ee', [0, 6]],
  ['0 and $ go to the line ends', '  foo', '$0', [0, 0]],
  ['^ goes to the first non-blank', '  foo', '$^', [0, 2]],
  ['G goes to the last line, gg to the first', 'a\nb\nc', 'Gkgg', [0, 0]],
  ['3G goes to line 3', 'a\nb\nc\nd', '3G', [2, 0]],
  ['j keeps the wanted column across a short line', 'abcd\na\nabcd', '$jj', [2, 3]],
  ['leaving insert steps the cursor back', 'ab', 'Ajk', [0, 1]],
  ['arrows move in normal mode', 'ab\ncd', '<right><down>', [1, 1]],
] as const

for (const [name, text, keys, cursor] of MOVES) {
  test(name, () => {
    expect(cursorOf(run(text, keys))).toEqual([...cursor])
  })
}

test('the mode is normal at first, insert after i, normal after jk', () => {
  expect(run('a', '').vim.mode).toBe('normal')
  expect(run('a', 'i').vim.mode).toBe('insert')
  expect(run('a', 'ijk').vim.mode).toBe('normal')
})

test('an unknown normal key changes nothing and types nothing', () => {
  expect(textOf(run('abc', 'QZ'))).toBe('abc')
})

const COMMANDS = [
  [':w saves', ':w<return>', ['save']],
  [':wq and :x save and quit', ':wq<return>:x<return>', ['save-quit', 'save-quit']],
  [':q! quits without saving', ':q!<return>', ['force-quit']],
  ['ctrl+s saves from normal mode', '<C-s>', ['save']],
  ['ctrl+s saves from insert mode', 'i<C-s>', ['save']],
] as const

for (const [name, keys, effects] of COMMANDS) {
  test(name, () => {
    expect(run('abc', keys).effects).toEqual([...effects])
  })
}

test(':q quits a clean buffer', () => {
  expect(run('abc', ':q<return>').effects).toEqual(['quit'])
})

test(':q on a dirty buffer refuses with E37 and stays', () => {
  const r = run('abc', 'x:q<return>')
  expect(r.effects).toEqual([])
  expect(r.vim.message).toMatch(/^E37/)
})

test('the command line shows what is typed, backspace edits it, and an unknown command is E492', () => {
  expect(run('abc', ':wx').vim.command).toBe('wx')
  expect(run('abc', ':wx<backspace>').vim.command).toBe('w')
  const r = run('abc', ':nope<return>')
  expect(r.vim.mode).toBe('normal')
  expect(r.vim.message).toMatch(/^E492/)
})

test('a line number on the command line goes to that line', () => {
  expect(cursorOf(run('a\nb\nc', ':3<return>'))).toEqual([2, 0])
})

test('backspace on an empty command line leaves it', () => {
  expect(run('abc', ':<backspace>').vim.mode).toBe('normal')
})

test('a message stays until the next key', () => {
  expect(run('abc', ':nope<return>l').vim.message).toBeUndefined()
})

test('the dirty check knows the text the buffer started from', () => {
  expect(run('abc', 'xu').vim.editor.lines).toEqual(['abc'])
})
