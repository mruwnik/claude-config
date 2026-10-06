import type { RunRecord } from '../types'
import { formatDuration } from './duration'
import { sameArgs } from './clash'

export type View = 'footer' | 'band' | 'band-right' | 'pane'

export const VIEWS: readonly View[] = ['footer', 'band', 'band-right', 'pane']

export const parseView = (args: string): View | undefined => {
  const name = args.trim().toLowerCase()
  return VIEWS.find(view => view === name)
}

export const MARKS = { running: '▶', passed: '✓', failed: '✗' } as const

const percent = (done: number, total: number) => (total > 0 ? ` ${Math.floor((100 * done) / total)}%` : '')

export const progressText = (run: RunRecord) => {
  const done = run.counts.passed + run.counts.failed + run.counts.error + run.counts.skipped
  if (run.planned > 0) return `${done}/${run.planned}${percent(done, run.planned)}`
  if (run.progress !== null) return `${done} tests ${run.progress.done}/${run.progress.total} ${run.progress.unit}`
  return done > 0 ? `${done} tests` : 'starting…'
}

const seconds = (run: RunRecord) => formatDuration(run.now - run.startedAt)

const stepText = (run: RunRecord) =>
  run.labels.length > 1 ? `${run.stepIndex + 1}/${run.labels.length} ${run.labels[run.stepIndex] ?? ''} ` : ''

const ARGS_HINT_CELLS = 24

const argsHint = (args: readonly string[]) => {
  const text = args.join(' ')
  return text.length <= ARGS_HINT_CELLS ? text : `${text.slice(0, ARGS_HINT_CELLS - 1)}…`
}

const agentTag = (run: RunRecord) => {
  if (run.agentName !== null) return ` [${run.agentName}]`
  return run.agentId === null ? '' : ' [subagent]'
}

/** A run's suite, the subagent that started it (a main-conversation run has no tag), and a hint of its args. */
export const runLabel = (run: RunRecord) => {
  const args = run.args ?? []
  return `${run.suite}${agentTag(run)}${args.length > 0 ? ` ${argsHint(args)}` : ''}`
}

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
] as const

const charWidth = (char: string) => {
  if (/[\p{Mn}\p{Me}\p{Cf}\uFE00-\uFE0F]/u.test(char)) return 0
  const code = char.codePointAt(0) ?? 0
  return /\p{Emoji_Presentation}/u.test(char) || WIDE.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1
}

/** How many terminal cells a string takes: wide CJK and emoji count two, combining marks none. */
export const cellWidth = (text: string) => [...text].reduce((sum, char) => sum + charWidth(char), 0)

const padEnd = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)))

const padStart = (text: string, width: number) => ' '.repeat(Math.max(0, width - cellWidth(text))) + text

/** A theme colour name, so the footer follows the person's light or dark theme. */
export type Tone = 'error' | 'success'

/** A stretch of a footer line: plain (dim) text, or text in a tone. */
export type Segment = { text: string; tone?: Tone }

export type Cell = readonly Segment[]

type FooterCells = readonly [name: Cell, status: Cell, time: Cell]

const plain = (cell: Cell) => cell.map(s => s.text).join('')

const MARK_TONES: Partial<Record<RunRecord['outcome'], Tone>> = { passed: 'success', failed: 'error' }

const COUNT_GAP: Segment = { text: '  ' }

/**
 * A finished run's counts as symbols: `32 ✓  3 ✗  1 ⊘`, errors counted with the failures,
 * zero counts left out; ✓ green, ✗ red, ⊘ dim. The summary for Claude keeps the words.
 */
export const countsCell = (counts: RunRecord['counts']): Cell => {
  const bad = counts.failed + counts.error
  const parts: Segment[] = [
    ...(counts.passed > 0 ? [{ text: `${counts.passed} ✓`, tone: 'success' as const }] : []),
    ...(bad > 0 ? [{ text: `${bad} ✗`, tone: 'error' as const }] : []),
    ...(counts.skipped > 0 ? [{ text: `${counts.skipped} ⊘` }] : []),
  ]
  if (parts.length === 0) return [{ text: 'no tests' }]
  return parts.flatMap((part, i) => (i === 0 ? [part] : [COUNT_GAP, part]))
}

/**
 * What a run's status says: its counts when finished; while running its progress (after its step
 * unless `withStep` is false, for a view that shows the step on its own), and failures so far in red.
 */
export const statusCell = (run: RunRecord, withStep = true): Cell => {
  if (run.outcome !== 'running') return countsCell(run.counts)
  const bad = run.counts.failed + run.counts.error
  const progress = `${withStep ? stepText(run) : ''}${progressText(run)}`
  return [{ text: progress }, ...(bad > 0 ? [COUNT_GAP, { text: `${bad} ✗`, tone: 'error' as const }] : [])]
}

const footerCells = (run: RunRecord): FooterCells => {
  const tone = MARK_TONES[run.outcome]
  const mark: Segment = tone === undefined ? { text: MARKS[run.outcome] } : { text: MARKS[run.outcome], tone }
  const name: Cell = [mark, { text: ` ${runLabel(run)}${run.taskId !== null && run.outcome === 'running' ? ' (bg)' : ''}` }]
  return [name, statusCell(run), [{ text: seconds(run) }]]
}

/** Neighbours of one tone joined, so a line is as few stretches as its colours need. */
const merged = (segments: readonly Segment[]) =>
  segments.reduce<Segment[]>((all, s) => {
    const last = all.at(-1)
    if (s.text === '') return all
    if (last === undefined || last.tone !== s.tone) return [...all, s]
    return [...all.slice(0, -1), { ...last, text: last.text + s.text }]
  }, [])

const padCell = (cell: Cell, width: number, side: 'end' | 'start'): Cell => {
  const fill = { text: ' '.repeat(Math.max(0, width - cellWidth(plain(cell)))) }
  return side === 'end' ? [...cell, fill] : [fill, ...cell]
}

/** One footer label per run: compact, no failure names. */
export const footerText = (run: RunRecord) => footerCells(run).map(plain).join(' ')

/**
 * The footer's lines: one per run, under the modes the footer already shows; several runs line
 * up in columns, worked out on the plain text. Each line's segments carry its colours.
 */
export const footerLines = (list: readonly RunRecord[]) => {
  if (list.length < 2) return list.map(run => ({ id: run.id, text: footerText(run), segments: merged(footerCells(run).flatMap((cell, i) => (i === 0 ? cell : [{ text: ' ' }, ...cell]))) }))
  const rows = list.map(run => ({ id: run.id, cells: footerCells(run) }))
  const widest = (i: number) => Math.max(...rows.map(row => cellWidth(plain(row.cells[i] ?? []))))
  const [name, status, time] = [widest(0), widest(1), widest(2)]
  return rows.map(({ id, cells: [a, b, c] }) => {
    const segments = merged([...padCell(a, name, 'end'), { text: '  ' }, ...padCell(b, status, 'end'), { text: '  ' }, ...padCell(c, time, 'start')])
    return { id, text: plain(segments), segments }
  })
}

/** The engine's plain-data tree, as far as this needs it: a Box's key and its children. */
type Tree = { type: string; props?: Readonly<Record<string, unknown>>; children?: readonly unknown[] }

const TRAILING = 'trailing:'

const isTrailing = (node: unknown) => {
  const key = (node as Tree | undefined)?.props?.key
  return (node as Tree | undefined)?.type === 'Box' && typeof key === 'string' && key.startsWith(TRAILING)
}

/**
 * The convention for footer columns that ask to stay last whichever plugin is outer: a Box keyed
 * `trailing:<plugin>`. Takes such boxes out of what the hooks beneath drew (the tree itself, or
 * its top-level children), so they can be drawn after this plugin's own column.
 */
export const splitTrailing = <T extends Tree>(tree: T): { kept: T | undefined; trailing: unknown[] } => {
  if (isTrailing(tree)) return { kept: undefined, trailing: [tree] }
  const children = tree.children ?? []
  const trailing = children.filter(isTrailing)
  if (trailing.length === 0) return { kept: tree, trailing: [] }
  return { kept: { ...tree, children: children.filter(child => !isTrailing(child)) }, trailing }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const agentKey = (run: RunRecord) => (run.agentId === null ? '' : `\u0001${run.agentName ?? ''}`)

/** The runs as shown: running first, then by suite, then by agent with the main conversation first; the stored list keeps its order. */
export const displayOrder = (list: readonly RunRecord[]) =>
  [...list].sort(
    (a, b) =>
      Number(a.outcome !== 'running') - Number(b.outcome !== 'running') ||
      compare(a.suite, b.suite) ||
      compare(agentKey(a), agentKey(b)),
  )

const isRerunOf = (run: RunRecord) => (old: RunRecord) =>
  old.outcome !== 'running' &&
  old.agentId === run.agentId &&
  old.root === run.root &&
  old.suite === run.suite &&
  sameArgs(old.args ?? [], run.args ?? [])

/** Adds a starting run, dropping only the finished run it repeats, so other agents' results stay up. */
export const withNewRun = (list: readonly RunRecord[], run: RunRecord) => [...list.filter(old => !isRerunOf(run)(old)), run]

type StartFields = { suite: string; taskId: string; isAsked: boolean; isSubagent: boolean; logPath: string }

/** What run_tests answers when the run goes on in the background, asked for or moved there at the Bash timeout. */
export const startReply = ({ suite, taskId, isAsked, isSubagent, logPath }: StartFields) => {
  const where = isSubagent ? 'sent to you as a message when the run ends' : 'attached to the completion notification'
  const note = `Its summary will be ${where}; stop it with TaskStop if needed. Progress is in ${logPath}, not the task output.`
  return isAsked
    ? `Suite ${suite} started as background task ${taskId}. ${note}`
    : `Suite ${suite} took longer than the Bash timeout and was moved to the background as task ${taskId}; it keeps running. ${note}`
}
