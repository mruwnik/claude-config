import { applyKey, follow, fromText, normalize, toText } from './editor'
import type { Editor, Key, Viewport } from './editor'

/**
 * A vim layer over the source editor: normal, insert and command-line modes,
 * counts, the d/c/y operators over the common motions, put, undo and redo.
 *
 * The engine keeps Escape for itself (it hands the keyboard back), so insert
 * mode is left with `jk`, Ctrl+C or Ctrl+[ instead.
 */
export type Mode = 'normal' | 'insert' | 'command'

/** What a key asks of the hooks: a save, a save then leaving, or leaving (`force` drops unsaved edits). */
export type Effect = 'save' | 'save-quit' | 'quit' | 'force-quit'

type Operator = 'd' | 'c' | 'y'

/** Keys typed toward a command not yet complete: `2d3`, `g`, `r`. */
type Pending = { count: string; op?: Operator; opCount: string; prefix?: 'g' | 'r' }

type Register = { text: string; isLine: boolean }

type Snapshot = Pick<Editor, 'lines' | 'row' | 'col'>

export type Vim = {
  editor: Editor
  mode: Mode
  /** The text the buffer is clean against, LF line ends. */
  saved: string
  pending: Pending
  /** The command line's text after `:`, while in command mode. */
  command: string
  /** What the status line says until the next key (`E37: ...`). */
  message?: string
  register: Register
  undo: Snapshot[]
  redo: Snapshot[]
  /** The last key in insert mode was a typed `j`: a `k` now leaves insert mode. */
  isAfterJ: boolean
}

export type VimOutcome = { vim: Vim; effect?: Effect }

type Pos = { row: number; col: number }

/** Where a motion goes and how an operator takes it: whole lines, or characters up to (or through) `pos`. */
type Motion = { pos: Pos; isLinewise: boolean; isInclusive: boolean; goal?: number }

const MAX_UNDO = 100
const END_GOAL = Number.MAX_SAFE_INTEGER
const NO_PENDING: Pending = { count: '', opCount: '' }

export const startVim = (text: string): Vim => ({
  editor: fromText(text),
  mode: 'normal',
  saved: normalize(text),
  pending: NO_PENDING,
  command: '',
  register: { text: '', isLine: false },
  undo: [],
  redo: [],
  isAfterJ: false,
})

export const isDirty = (vim: Vim): boolean => toText(vim.editor) !== vim.saved

const chars = (line: string): string[] => [...line]

const lineOf = (ed: Editor, row: number): string[] => chars(ed.lines[row] ?? '')

const lastRow = (ed: Editor): number => ed.lines.length - 1

const firstNonBlank = (line: string[]): number => {
  const i = line.findIndex(ch => !/\s/.test(ch))
  return i < 0 ? Math.max(0, line.length - 1) : i
}

/** The cursor kept on a character, as normal mode keeps it: never past the last one. */
const clampNormal = (ed: Editor): Editor => {
  const col = Math.min(ed.col, Math.max(0, lineOf(ed, ed.row).length - 1))
  return col === ed.col ? ed : { ...ed, col }
}

const at = (ed: Editor, row: number, col: number, goal?: number): Editor => {
  const { goal: _, ...rest } = ed
  return goal === undefined ? { ...rest, row, col } : { ...rest, row, col, goal }
}

// ---- words: 0 blank (a line end too), 1 keyword characters, 2 any other run

const classOf = (ch: string | undefined): number => (ch === undefined || /\s/.test(ch) ? 0 : /\w/.test(ch) ? 1 : 2)

const charAt = (ed: Editor, p: Pos): string | undefined => lineOf(ed, p.row)[p.col]

/** The next position, a line's end counted as one (blank) position; null past the doc's end. */
const nextPos = (ed: Editor, p: Pos): Pos | null => {
  if (p.col < lineOf(ed, p.row).length) return { row: p.row, col: p.col + 1 }
  return p.row < lastRow(ed) ? { row: p.row + 1, col: 0 } : null
}

const prevPos = (ed: Editor, p: Pos): Pos | null => {
  if (p.col > 0) return { row: p.row, col: p.col - 1 }
  return p.row > 0 ? { row: p.row - 1, col: lineOf(ed, p.row - 1).length } : null
}

const isEmptyLine = (ed: Editor, p: Pos): boolean => lineOf(ed, p.row).length === 0

const docEnd = (ed: Editor): Pos => ({ row: lastRow(ed), col: lineOf(ed, lastRow(ed)).length })

/** `w`: the next word's start; an empty line is a word. */
const wordForward = (ed: Editor, from: Pos): Pos => {
  const start = classOf(charAt(ed, from))
  let p: Pos | null = from
  if (start !== 0) {
    while (p !== null && p.row === from.row && classOf(charAt(ed, p)) === start) p = nextPos(ed, p)
  }
  while (p !== null && classOf(charAt(ed, p)) === 0) {
    if (p.row !== from.row && isEmptyLine(ed, p)) return p
    p = nextPos(ed, p)
  }
  return p ?? docEnd(ed)
}

/** `e`: the end of this word, or of the next when already at one. */
const wordEnd = (ed: Editor, from: Pos): Pos => {
  let p = nextPos(ed, from)
  while (p !== null && classOf(charAt(ed, p)) === 0) p = nextPos(ed, p)
  if (p === null) return from
  const c = classOf(charAt(ed, p))
  for (let q = nextPos(ed, p); q !== null && q.row === p.row && classOf(charAt(ed, q)) === c; q = nextPos(ed, q)) p = q
  return p
}

/** `b`: the start of this word, or of the one before when already at one. */
const wordBack = (ed: Editor, from: Pos): Pos => {
  let p = prevPos(ed, from)
  while (p !== null && classOf(charAt(ed, p)) === 0) {
    if (isEmptyLine(ed, p) && p.row !== from.row) return p
    p = prevPos(ed, p)
  }
  if (p === null) return { row: 0, col: 0 }
  const c = classOf(charAt(ed, p))
  for (let q = prevPos(ed, p); q !== null && q.row === p.row && classOf(charAt(ed, q)) === c; q = prevPos(ed, q)) p = q
  return p
}

const repeat = (n: number, step: (p: Pos) => Pos, from: Pos): Pos => Array.from({ length: n }).reduce<Pos>(p => step(p), from)

// ---- motions

const lineMotion = (ed: Editor, row: number): Motion => {
  const target = Math.min(Math.max(0, row), lastRow(ed))
  return { pos: { row: target, col: firstNonBlank(lineOf(ed, target)) }, isLinewise: true, isInclusive: false }
}

const verticalMotion = (ed: Editor, by: number): Motion => {
  const goal = ed.goal ?? ed.col
  const row = Math.min(Math.max(0, ed.row + by), lastRow(ed))
  return { pos: { row, col: Math.min(goal, Math.max(0, lineOf(ed, row).length - 1)) }, isLinewise: true, isInclusive: false, goal }
}

const charMotion = (pos: Pos, isInclusive = false): Motion => ({ pos, isLinewise: false, isInclusive })

/** The motion `key` names, `count` times (`hasCount`: a count was typed), from the cursor; undefined when it names none. */
const motionOf = (ed: Editor, key: string, count: number, hasCount: boolean, view: Viewport): Motion | undefined => {
  const here = { row: ed.row, col: ed.col }
  const line = lineOf(ed, ed.row)
  const page = Math.max(1, view.rows - 1)
  switch (key) {
    case 'h':
    case 'left':
    case 'backspace':
      return charMotion({ row: ed.row, col: Math.max(0, ed.col - count) })
    case 'l':
    case 'right':
    case ' ':
    case 'space':
      return charMotion({ row: ed.row, col: Math.min(line.length, ed.col + count) })
    case 'j':
    case 'down':
      return verticalMotion(ed, count)
    case 'k':
    case 'up':
      return verticalMotion(ed, -count)
    case 'return':
    case 'enter':
      return lineMotion(ed, ed.row + count)
    case 'w':
      return charMotion(repeat(count, p => wordForward(ed, p), here))
    case 'b':
      return charMotion(repeat(count, p => wordBack(ed, p), here))
    case 'e':
      return charMotion(repeat(count, p => wordEnd(ed, p), here), true)
    case '0':
    case 'home':
      return charMotion({ row: ed.row, col: 0 })
    case '^':
      return charMotion({ row: ed.row, col: firstNonBlank(line) })
    case '$':
    case 'end':
      return { ...charMotion({ row: ed.row, col: Math.max(0, line.length - 1) }, true), goal: END_GOAL }
    case 'G':
      return lineMotion(ed, hasCount ? count - 1 : lastRow(ed))
    case 'gg':
      return lineMotion(ed, hasCount ? count - 1 : 0)
    case 'pagedown':
      return verticalMotion(ed, page * count)
    case 'pageup':
      return verticalMotion(ed, -page * count)
    default:
      return undefined
  }
}

// ---- edits

const snapshot = (ed: Editor): Snapshot => ({ lines: ed.lines, row: ed.row, col: ed.col })

/** `vim` with its buffer as it is now kept for `u`; the redo list cleared, as any new change does. */
const remember = (vim: Vim): Vim => ({ ...vim, undo: [...vim.undo, snapshot(vim.editor)].slice(-MAX_UNDO), redo: [] })

const restore = (ed: Editor, s: Snapshot): Editor => clampNormal(at({ ...ed, lines: s.lines }, s.row, s.col))

const normalMode = (vim: Vim, editor: Editor): Vim => ({ ...vim, editor: clampNormal(editor), mode: 'normal', pending: NO_PENDING, isAfterJ: false })

const insertMode = (vim: Vim, editor: Editor): Vim => ({ ...vim, editor, mode: 'insert', pending: NO_PENDING, isAfterJ: false })

const ordered = (a: Pos, b: Pos): [Pos, Pos] => (a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a])

/** The text from `a` up to (not through) `b`, and the lines with it cut out. */
const cutChars = (ed: Editor, a: Pos, b: Pos): { text: string; lines: string[] } => {
  const head = lineOf(ed, a.row).slice(0, a.col).join('')
  const tail = lineOf(ed, b.row).slice(b.col).join('')
  const taken =
    a.row === b.row
      ? lineOf(ed, a.row).slice(a.col, b.col).join('')
      : [lineOf(ed, a.row).slice(a.col).join(''), ...ed.lines.slice(a.row + 1, b.row), lineOf(ed, b.row).slice(0, b.col).join('')].join('\n')
  return { text: taken, lines: [...ed.lines.slice(0, a.row), head + tail, ...ed.lines.slice(b.row + 1)] }
}

/** `op` over whole lines `from`..`to`. */
const operateLines = (vim: Vim, op: Operator, from: number, to: number): Vim => {
  const ed = vim.editor
  const [r1, r2] = from <= to ? [from, to] : [to, from]
  const register = { text: ed.lines.slice(r1, r2 + 1).join('\n'), isLine: true }
  if (op === 'y') return normalMode({ ...vim, register }, at(ed, r1, ed.row === r1 ? ed.col : 0))
  const kept = [...ed.lines.slice(0, r1), ...ed.lines.slice(r2 + 1)]
  if (op === 'c') return insertMode({ ...remember(vim), register }, at({ ...ed, lines: [...ed.lines.slice(0, r1), '', ...ed.lines.slice(r2 + 1)] }, r1, 0))
  const lines = kept.length === 0 ? [''] : kept
  const row = Math.min(r1, lines.length - 1)
  return normalMode({ ...remember(vim), register }, at({ ...ed, lines }, row, firstNonBlank(chars(lines[row] ?? ''))))
}

/** `op` over the characters from the cursor to `motion`'s end. */
const operateChars = (vim: Vim, op: Operator, motion: Motion): Vim => {
  const ed = vim.editor
  const [a, b] = ordered({ row: ed.row, col: ed.col }, motion.pos)
  const end = motion.isInclusive ? { row: b.row, col: Math.min(b.col + 1, lineOf(ed, b.row).length) } : b
  const { text, lines } = cutChars(ed, a, end)
  const register = { text, isLine: false }
  if (op === 'y') return normalMode({ ...vim, register }, at(ed, a.row, a.col))
  if (op === 'c') return insertMode({ ...remember(vim), register }, at({ ...ed, lines }, a.row, a.col))
  return normalMode({ ...remember(vim), register }, at({ ...ed, lines }, a.row, a.col))
}

/** The motion an operator takes for `key`: `cw` is `ce`, and a `w` that would run onto a later line stops at this one's end. */
const operatorMotion = (vim: Vim, op: Operator, key: string, count: number, hasCount: boolean, view: Viewport): Motion | undefined => {
  const ed = vim.editor
  const isOnWord = classOf(charAt(ed, { row: ed.row, col: ed.col })) !== 0
  if (key === 'w' && op === 'c' && isOnWord) return motionOf(ed, 'e', count, hasCount, view)
  const motion = motionOf(ed, key, count, hasCount, view)
  if (key !== 'w' || motion === undefined || motion.pos.row === ed.row) return motion
  const isPastEnd = motion.pos.row === lastRow(ed) && motion.pos.col === lineOf(ed, lastRow(ed)).length && motion.pos.col > 0
  if (isPastEnd || motion.pos.col > 0) return motion
  const row = motion.pos.row - 1
  return charMotion({ row, col: lineOf(ed, row).length })
}

const put = (vim: Vim, isBefore: boolean, count: number): Vim => {
  const { register } = vim
  if (register.text === '' && !register.isLine) return vim
  const ed = vim.editor
  const text = Array.from({ length: count }, () => register.text).join(register.isLine ? '\n' : '')
  if (register.isLine) {
    const row = isBefore ? ed.row : ed.row + 1
    const lines = [...ed.lines.slice(0, row), ...text.split('\n'), ...ed.lines.slice(row)]
    return normalMode(remember(vim), at({ ...ed, lines }, row, firstNonBlank(chars(lines[row] ?? ''))))
  }
  const line = lineOf(ed, ed.row)
  const col = isBefore || line.length === 0 ? ed.col : ed.col + 1
  const pieces = text.split('\n')
  const head = line.slice(0, col).join('')
  const tail = line.slice(col).join('')
  const last = pieces.length - 1
  const added = pieces.map((p, i) => (i === 0 ? head : '') + p + (i === last ? tail : ''))
  const lines = [...ed.lines.slice(0, ed.row), ...added, ...ed.lines.slice(ed.row + 1)]
  const endCol = last === 0 ? col + chars(text).length - 1 : chars(pieces[last] as string).length - 1
  return normalMode(remember(vim), at({ ...ed, lines }, ed.row + last, Math.max(0, endCol)))
}

const join = (vim: Vim, count: number): Vim => {
  const ed = vim.editor
  const joins = Math.min(Math.max(1, count - 1), lastRow(ed) - ed.row)
  if (joins <= 0) return { ...vim, pending: NO_PENDING }
  const parts = ed.lines.slice(ed.row, ed.row + joins + 1)
  const joined = parts.slice(1).reduce((acc, next) => {
    const rest = next.trimStart()
    return rest === '' ? acc : `${acc.trimEnd()} ${rest}`
  }, parts[0] as string)
  const col = chars((parts[0] as string).trimEnd()).length
  const lines = [...ed.lines.slice(0, ed.row), joined, ...ed.lines.slice(ed.row + joins + 1)]
  return normalMode(remember(vim), at({ ...ed, lines }, ed.row, col))
}

const replaceChars = (vim: Vim, ch: string, count: number): Vim => {
  const ed = vim.editor
  const line = lineOf(ed, ed.row)
  if (ed.col + count > line.length || [...ch].length !== 1) return { ...vim, pending: NO_PENDING }
  const next = [...line.slice(0, ed.col), ...Array.from({ length: count }, () => ch), ...line.slice(ed.col + count)].join('')
  return normalMode(remember(vim), at({ ...ed, lines: ed.lines.with(ed.row, next) }, ed.row, ed.col + count - 1))
}

const undo = (vim: Vim): Vim => {
  const last = vim.undo.at(-1)
  if (last === undefined) return { ...vim, pending: NO_PENDING, message: 'Already at oldest change' }
  return normalMode({ ...vim, undo: vim.undo.slice(0, -1), redo: [...vim.redo, snapshot(vim.editor)] }, restore(vim.editor, last))
}

const redo = (vim: Vim): Vim => {
  const last = vim.redo.at(-1)
  if (last === undefined) return { ...vim, pending: NO_PENDING, message: 'Already at newest change' }
  return normalMode({ ...vim, redo: vim.redo.slice(0, -1), undo: [...vim.undo, snapshot(vim.editor)] }, restore(vim.editor, last))
}

/** Into insert mode at `col` of `row` (a new line opened there when `openAt` names it), the buffer remembered as one undo. */
const enterInsert = (vim: Vim, row: number, col: number, openAt?: number): Vim => {
  const ed = vim.editor
  const lines = openAt === undefined ? ed.lines : [...ed.lines.slice(0, openAt), '', ...ed.lines.slice(openAt)]
  return insertMode(remember(vim), at({ ...ed, lines }, row, col))
}

// ---- modes

const leaveInsert = (vim: Vim): Vim => normalMode(vim, at(vim.editor, vim.editor.row, Math.max(0, vim.editor.col - 1)))

const isEscapeLike = (k: Key): boolean => k.ctrl === true && (k.key === 'c' || k.key === '[')

const insertKey = (vim: Vim, k: Key, view: Viewport): VimOutcome => {
  if (isEscapeLike(k)) return { vim: leaveInsert(vim) }
  if (vim.isAfterJ && k.key === 'k' && !k.ctrl && !k.meta) {
    const ed = vim.editor
    const line = lineOf(ed, ed.row)
    const lines = ed.lines.with(ed.row, [...line.slice(0, ed.col - 1), ...line.slice(ed.col)].join(''))
    return { vim: leaveInsert({ ...vim, editor: at({ ...ed, lines }, ed.row, ed.col - 1) }) }
  }
  const out = applyKey(vim.editor, k, view)
  if (out.kind === 'save') return { vim, effect: 'save' }
  if (out.kind === 'none') return { vim: { ...vim, isAfterJ: false } }
  return { vim: { ...vim, editor: out.editor, isAfterJ: k.key === 'j' && !k.ctrl && !k.meta } }
}

const runCommand = (vim: Vim): VimOutcome => {
  const command = vim.command.trim()
  const done: Vim = { ...vim, mode: 'normal', command: '' }
  if (command === '') return { vim: done }
  if (command === 'w') return { vim: done, effect: 'save' }
  if (command === 'wq' || command === 'x') return { vim: done, effect: 'save-quit' }
  if (command === 'q!') return { vim: done, effect: 'force-quit' }
  if (command === 'q') {
    if (isDirty(vim)) return { vim: { ...done, message: 'E37: No write since last change (add ! to override)' } }
    return { vim: done, effect: 'quit' }
  }
  if (/^\d+$/.test(command)) {
    const motion = lineMotion(vim.editor, Number(command) - 1)
    return { vim: { ...done, editor: at(vim.editor, motion.pos.row, motion.pos.col) } }
  }
  return { vim: { ...done, message: `E492: Not an editor command: ${command}` } }
}

const commandKey = (vim: Vim, k: Key): VimOutcome => {
  if (isEscapeLike(k)) return { vim: { ...vim, mode: 'normal', command: '' } }
  if (k.key === 'return' || k.key === 'enter') return runCommand(vim)
  if (k.key === 'backspace') {
    if (vim.command === '') return { vim: { ...vim, mode: 'normal' } }
    return { vim: { ...vim, command: chars(vim.command).slice(0, -1).join('') } }
  }
  if (k.ctrl || k.meta) return { vim }
  if (k.key === 'space') return { vim: { ...vim, command: `${vim.command} ` } }
  if ([...k.key].length !== 1) return { vim }
  return { vim: { ...vim, command: vim.command + k.key } }
}

const countOf = (digits: string): number => (digits === '' ? 1 : Number(digits))

const halfPage = (view: Viewport): number => Math.max(1, Math.floor((view.rows - 1) / 2))

/** A normal-mode key with no operator pending that is not a motion: a command, or nothing. */
const normalCommand = (vim: Vim, k: Key, count: number, view: Viewport): VimOutcome | undefined => {
  const ed = vim.editor
  const line = lineOf(ed, ed.row)
  switch (k.key) {
    case 'i':
      return { vim: enterInsert(vim, ed.row, ed.col) }
    case 'a':
      return { vim: enterInsert(vim, ed.row, Math.min(line.length, ed.col + 1)) }
    case 'I':
      return { vim: enterInsert(vim, ed.row, line.findIndex(ch => !/\s/.test(ch)) < 0 ? line.length : firstNonBlank(line)) }
    case 'A':
      return { vim: enterInsert(vim, ed.row, line.length) }
    case 'o':
      return { vim: enterInsert(vim, ed.row + 1, 0, ed.row + 1) }
    case 'O':
      return { vim: enterInsert(vim, ed.row, 0, ed.row) }
    case 'x':
    case 'delete':
      return line.length === 0 ? { vim: { ...vim, pending: NO_PENDING } } : { vim: operateChars(vim, 'd', motionOf(ed, 'l', count, true, view) as Motion) }
    case 'X':
      return ed.col === 0 ? { vim: { ...vim, pending: NO_PENDING } } : { vim: operateChars(vim, 'd', motionOf(ed, 'h', count, true, view) as Motion) }
    case 'D':
      return { vim: line.length === 0 ? { ...vim, pending: NO_PENDING } : operateChars(vim, 'd', motionOf(ed, '$', 1, false, view) as Motion) }
    case 'C':
      return { vim: operateChars(vim, 'c', line.length === 0 ? charMotion({ row: ed.row, col: 0 }) : (motionOf(ed, '$', 1, false, view) as Motion)) }
    case 's':
      return { vim: operateChars(vim, 'c', line.length === 0 ? charMotion({ row: ed.row, col: 0 }) : (motionOf(ed, 'l', count, true, view) as Motion)) }
    case 'S':
      return { vim: operateLines(vim, 'c', ed.row, Math.min(lastRow(ed), ed.row + count - 1)) }
    case 'Y':
      return { vim: operateLines(vim, 'y', ed.row, Math.min(lastRow(ed), ed.row + count - 1)) }
    case 'p':
      return { vim: put(vim, false, count) }
    case 'P':
      return { vim: put(vim, true, count) }
    case 'J':
      return { vim: join(vim, count) }
    case 'u':
      return { vim: undo(vim) }
    case ':':
      return { vim: { ...vim, mode: 'command', command: '', pending: NO_PENDING } }
    default:
      return undefined
  }
}

const normalCtrl = (vim: Vim, k: Key, view: Viewport): VimOutcome => {
  const ed = vim.editor
  const done = { ...vim, pending: NO_PENDING }
  switch (k.key) {
    case 's':
      return { vim: done, effect: 'save' }
    case 'r':
      return { vim: redo(done) }
    case 'd':
      return { vim: { ...done, editor: clampNormal(at(ed, verticalMotion(ed, halfPage(view)).pos.row, verticalMotion(ed, halfPage(view)).pos.col)) } }
    case 'u':
      return { vim: { ...done, editor: clampNormal(at(ed, verticalMotion(ed, -halfPage(view)).pos.row, verticalMotion(ed, -halfPage(view)).pos.col)) } }
    default:
      return { vim: done }
  }
}

const normalKey = (vim: Vim, k: Key, view: Viewport): VimOutcome => {
  if (k.meta) return { vim }
  if (k.ctrl) return normalCtrl(vim, k, view)
  const { pending } = vim
  const ed = vim.editor

  if (pending.prefix === 'r') return { vim: replaceChars(vim, k.key === 'space' ? ' ' : k.key, countOf(pending.count)) }
  const key = pending.prefix === 'g' ? (k.key === 'g' ? 'gg' : '') : k.key
  if (key === '') return { vim: { ...vim, pending: NO_PENDING } }

  // a digit grows the count (the operator's, once one is typed); a leading 0 is the motion
  const digits = pending.op === undefined ? pending.count : pending.opCount
  if (/^[0-9]$/.test(key) && !(key === '0' && digits === '')) {
    return { vim: { ...vim, pending: pending.op === undefined ? { ...pending, count: pending.count + key } : { ...pending, opCount: pending.opCount + key } } }
  }
  if (key === 'g' || key === 'r') return { vim: { ...vim, pending: { ...pending, prefix: key } } }

  const hasCount = pending.count !== '' || pending.opCount !== ''
  const count = countOf(pending.count) * countOf(pending.opCount)

  if (pending.op !== undefined) {
    // dd, cc, yy: whole lines
    if (key === pending.op) return { vim: operateLines(vim, pending.op, ed.row, Math.min(lastRow(ed), ed.row + count - 1)) }
    const motion = operatorMotion(vim, pending.op, key, count, hasCount, view)
    if (motion === undefined) return { vim: { ...vim, pending: NO_PENDING } }
    return { vim: motion.isLinewise ? operateLines(vim, pending.op, ed.row, motion.pos.row) : operateChars(vim, pending.op, motion) }
  }

  if (key === 'd' || key === 'c' || key === 'y') return { vim: { ...vim, pending: { ...pending, op: key, prefix: undefined } } }

  const motion = motionOf(ed, key, count, hasCount, view)
  if (motion !== undefined) return { vim: { ...vim, pending: NO_PENDING, editor: clampNormal(at(ed, motion.pos.row, motion.pos.col, motion.goal)) } }

  return normalCommand(vim, { ...k, key }, count, view) ?? { vim: { ...vim, pending: NO_PENDING } }
}

/** What key `k` does to `vim` shown in `view`; the window then follows the cursor. */
export const vimKey = (vim: Vim, k: Key, view: Viewport): VimOutcome => {
  const fresh = vim.message === undefined ? vim : (({ message: _, ...rest }) => rest)(vim)
  const out = fresh.mode === 'insert' ? insertKey(fresh, k, view) : fresh.mode === 'command' ? commandKey(fresh, k) : normalKey(fresh, k, view)
  const editor = follow(out.vim.editor, view)
  return editor === out.vim.editor ? out : { ...out, vim: { ...out.vim, editor } }
}

/** The status line's left part: the mode, the command line, a message, or the keys pending. */
export const modeText = (vim: Vim): string => {
  if (vim.mode === 'command') return `:${vim.command}`
  if (vim.message !== undefined) return vim.message
  if (vim.mode === 'insert') return '-- INSERT --'
  const { count, op, opCount, prefix } = vim.pending
  return `${count}${op ?? ''}${opCount}${prefix ?? ''}`
}
