import { GUTTER } from './view'
import { charWidth, cutToWidth } from './width'

/**
 * The source editor's buffer: the doc's lines, the cursor (`col` counts code
 * points), and the window's top row and left code point. `goal` is the column
 * up and down aim for across shorter lines.
 */
export type Editor = { lines: string[]; row: number; col: number; top: number; left: number; goal?: number }

/** The editor's region: its last row is the status line, its first `GUTTER` columns are blank as the view's are. */
export type Viewport = { rows: number; columns: number }

export type Key = { key: string; ctrl?: true; shift?: true; meta?: true }

/** What a key comes to: a new buffer, a save, or nothing. */
export type Outcome = { kind: 'edit'; editor: Editor } | { kind: 'save' } | { kind: 'none' }

/** A visible line: the cursor line is split round the cursor cell. */
export type Line = { before: string; cursor?: string; after?: string }

const TAB = '  '

/** `text` with CRLF and lone CR line ends as LF: the editor's one line end. */
export const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

export const fromText = (text: string): Editor => ({ lines: normalize(text).split('\n'), row: 0, col: 0, top: 0, left: 0 })

export const toText = (ed: Editor): string => ed.lines.join('\n')

const chars = (line: string): string[] => [...line]

const lineAt = (ed: Editor, row: number): string[] => chars(ed.lines[row] ?? '')

const textRows = (view: Viewport): number => Math.max(1, view.rows - 1)

const textColumns = (view: Viewport): number => Math.max(1, view.columns - GUTTER)

const moveTo = (ed: Editor, row: number, col: number): Editor => {
  const { goal: _, ...rest } = ed
  return { ...rest, row, col }
}

/** Up or down by `by` rows, aiming for the column the last vertical move wanted. */
const moveVertically = (ed: Editor, by: number): Editor => {
  const goal = ed.goal ?? ed.col
  const target = ed.row + by
  if (target < 0) return moveTo(ed, 0, 0)
  if (target > ed.lines.length - 1) return moveTo(ed, ed.lines.length - 1, lineAt(ed, ed.lines.length - 1).length)
  return { ...ed, row: target, col: Math.min(goal, lineAt(ed, target).length), goal }
}

const moveLeft = (ed: Editor): Editor => {
  if (ed.col > 0) return moveTo(ed, ed.row, ed.col - 1)
  if (ed.row === 0) return ed
  return moveTo(ed, ed.row - 1, lineAt(ed, ed.row - 1).length)
}

const moveRight = (ed: Editor): Editor => {
  if (ed.col < lineAt(ed, ed.row).length) return moveTo(ed, ed.row, ed.col + 1)
  if (ed.row === ed.lines.length - 1) return ed
  return moveTo(ed, ed.row + 1, 0)
}

const withLines = (ed: Editor, lines: string[], row: number, col: number): Editor => moveTo({ ...ed, lines }, row, col)

/** `text` (newlines and all) inserted at the cursor, the cursor after it. */
const insert = (ed: Editor, text: string): Editor => {
  const line = lineAt(ed, ed.row)
  const head = line.slice(0, ed.col).join('')
  const tail = line.slice(ed.col).join('')
  const pieces = normalize(text).split('\n')
  const last = pieces.length - 1
  const added = pieces.map((p, i) => (i === 0 ? head : '') + p + (i === last ? tail : ''))
  const lines = [...ed.lines.slice(0, ed.row), ...added, ...ed.lines.slice(ed.row + 1)]
  const col = last === 0 ? ed.col + chars(text).length : chars(pieces[last] as string).length
  return withLines(ed, lines, ed.row + last, col)
}

const backspace = (ed: Editor): Editor => {
  const line = lineAt(ed, ed.row)
  if (ed.col > 0) {
    const lines = ed.lines.with(ed.row, [...line.slice(0, ed.col - 1), ...line.slice(ed.col)].join(''))
    return withLines(ed, lines, ed.row, ed.col - 1)
  }
  if (ed.row === 0) return ed
  const above = lineAt(ed, ed.row - 1)
  const lines = [...ed.lines.slice(0, ed.row - 1), above.join('') + line.join(''), ...ed.lines.slice(ed.row + 1)]
  return withLines(ed, lines, ed.row - 1, above.length)
}

const deleteForward = (ed: Editor): Editor => {
  const line = lineAt(ed, ed.row)
  if (ed.col < line.length) return withLines(ed, ed.lines.with(ed.row, [...line.slice(0, ed.col), ...line.slice(ed.col + 1)].join('')), ed.row, ed.col)
  if (ed.row === ed.lines.length - 1) return ed
  const lines = [...ed.lines.slice(0, ed.row), line.join('') + (ed.lines[ed.row + 1] ?? ''), ...ed.lines.slice(ed.row + 2)]
  return withLines(ed, lines, ed.row, ed.col)
}

const cutToEnd = (ed: Editor): Editor => withLines(ed, ed.lines.with(ed.row, lineAt(ed, ed.row).slice(0, ed.col).join('')), ed.row, ed.col)

/** Cells the code points `from`..`to` of `line` take. */
const cellsBetween = (line: string[], from: number, to: number): number =>
  line.slice(from, to).reduce((n, ch) => n + charWidth(ch.codePointAt(0) as number), 0)

/** The window moved the least that shows the cursor's row and its cell. */
export const follow = (ed: Editor, view: Viewport): Editor => {
  const rows = textRows(view)
  const top = Math.min(Math.max(ed.top, ed.row - rows + 1), ed.row)
  const line = lineAt(ed, ed.row)
  const cursorCells = (line[ed.col] === undefined ? 1 : cellsBetween(line, ed.col, ed.col + 1))
  let left = Math.min(ed.left, ed.col)
  while (left < ed.col && cellsBetween(line, left, ed.col) + cursorCells > textColumns(view)) left += 1
  return top === ed.top && left === ed.left ? ed : { ...ed, top, left }
}

/** Key names the editor acts on, or knows to ignore; any other lowercase word is a key name it does not know. */
const isKeyName = (key: string): boolean => /^[a-z][a-z0-9]+$/.test(key)

const CTRL_KEYS: Record<string, (ed: Editor) => Editor> = {
  a: ed => moveTo(ed, ed.row, 0),
  e: ed => moveTo(ed, ed.row, lineAt(ed, ed.row).length),
  k: cutToEnd,
}

const named = (view: Viewport): Record<string, (ed: Editor) => Editor> => ({
  up: ed => moveVertically(ed, -1),
  down: ed => moveVertically(ed, 1),
  left: moveLeft,
  right: moveRight,
  home: ed => moveTo(ed, ed.row, 0),
  end: ed => moveTo(ed, ed.row, lineAt(ed, ed.row).length),
  pageup: ed => moveVertically(ed, -textRows(view)),
  pagedown: ed => moveVertically(ed, textRows(view)),
  return: ed => insert(ed, '\n'),
  enter: ed => insert(ed, '\n'),
  backspace,
  delete: deleteForward,
  tab: ed => insert(ed, TAB),
  space: ed => insert(ed, ' '),
})

/** What the key `k` does to the buffer `ed` shown in `view`. */
export const applyKey = (ed: Editor, k: Key, view: Viewport): Outcome => {
  if (k.meta) return { kind: 'none' }
  if (k.ctrl) {
    if (k.key === 's') return { kind: 'save' }
    const act = CTRL_KEYS[k.key]
    return act === undefined ? { kind: 'none' } : { kind: 'edit', editor: follow(act(ed), view) }
  }
  const act = named(view)[k.key]
  if (act !== undefined) return { kind: 'edit', editor: follow(act(ed), view) }
  // a lowercase word is a key's name (`f1`, `insert`): one the editor does not use
  if (isKeyName(k.key) || k.key === '') return { kind: 'none' }
  // a character typed, or several at once (a paste)
  return { kind: 'edit', editor: follow(insert(ed, k.key), view) }
}

/** The text rows `view` shows of `ed`, each cut to the window's columns from `ed.left`. */
export const visibleLines = (ed: Editor, view: Viewport): Line[] => {
  const columns = textColumns(view)
  return ed.lines.slice(ed.top, ed.top + textRows(view)).map((text, i) => {
    const line = chars(text).slice(ed.left)
    if (ed.top + i !== ed.row) return { before: cutToWidth(line.join(''), columns) }
    const at = ed.col - ed.left
    const before = line.slice(0, at).join('')
    const cursor = line[at] ?? ' '
    const room = columns - cellsBetween([...before, cursor], 0, at + 1)
    return { before, cursor, after: cutToWidth(line.slice(at + 1).join(''), Math.max(0, room)) }
  })
}
