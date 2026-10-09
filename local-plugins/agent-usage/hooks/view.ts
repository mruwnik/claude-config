import type { PluginOptions } from 'claude-code'

import type { AgentUsage, Level, ProcUsage } from './usage'
import { cellWidth, padEnd, padStart } from './width'

const MB = 1024 * 1024
const GB = 1024 * MB

export type Thresholds = { memBytes: number; cpuPercent: number }

/** Keys of the rows that are no single agent's: the main conversation, claude itself, claude's untracked children. */
export const MAIN = 'main'
export const CLAUDE = 'claude'
export const OTHER = 'other'
export const SHARED: readonly string[] = [CLAUDE, OTHER]

/** `always`: a column in the footer; `alerts`: the status line while something is over; `off`: neither. */
export type FooterMode = 'always' | 'alerts' | 'off'

const FOOTER_MODES: readonly FooterMode[] = ['always', 'alerts', 'off']

export type Config = Thresholds & {
  intervalMs: number
  footer: FooterMode
  /** MemAvailable under floorMb + marginMb sends one notice; 0 is off. */
  floorMb: number
  marginMb: number
  /** Where each sample's JSON is written; empty is off. */
  snapshotPath: string
  /** The footer column shows a row only over one of these (bytes, % of one core). */
  footerMin: Level
  /** Reap a stopped agent's leftovers on its own, after a grace period. */
  reapOnStop: boolean
}

const DEFAULTS = { memoryThresholdGB: 2, cpuThresholdPercent: 150, intervalSeconds: 5 } as const
const FOOTER_MIN_DEFAULTS = { footerMinMemoryMB: 500, footerMinCpuPercent: 30 } as const

/** A number of at least 0 set in the plugin's options, else the default. */
const nonNegative = (options: PluginOptions, name: keyof typeof FOOTER_MIN_DEFAULTS) => {
  const value = options[name]
  return typeof value === 'number' && value >= 0 ? value : FOOTER_MIN_DEFAULTS[name]
}

const footerModeOf = (value: unknown): FooterMode => FOOTER_MODES.find(mode => mode === value) ?? 'always'

/** A positive number set in the plugin's options, else the default. */
const positive = (options: PluginOptions, name: keyof typeof DEFAULTS) => {
  const value = options[name]
  return typeof value === 'number' && value > 0 ? value : DEFAULTS[name]
}

export const thresholdsFrom = (options: PluginOptions): Config => ({
  memBytes: positive(options, 'memoryThresholdGB') * GB,
  cpuPercent: positive(options, 'cpuThresholdPercent'),
  intervalMs: positive(options, 'intervalSeconds') * 1000,
  footer: footerModeOf(options.footer),
  floorMb: typeof options.memoryFloorMB === 'number' && options.memoryFloorMB > 0 ? options.memoryFloorMB : 0,
  marginMb: typeof options.pressureMarginMB === 'number' && options.pressureMarginMB >= 0 ? options.pressureMarginMB : 1024,
  snapshotPath: typeof options.snapshotPath === 'string' ? options.snapshotPath.trim() : '',
  footerMin: { pss: nonNegative(options, 'footerMinMemoryMB') * MB, cpu: nonNegative(options, 'footerMinCpuPercent') },
  reapOnStop: options.reapOnStop === true,
})

/** One past the line goes on; it comes off only below this share of it, so a value hovering at the line does not flap. */
const EXIT_RATIO = 0.9

const isOver = (u: Level, limits: Thresholds, ratio: number) => u.pss >= limits.memBytes * ratio || u.cpu >= limits.cpuPercent * ratio

/** Which agents are over now, and which of them just crossed. */
export const alertStep = (alerting: readonly string[], usages: readonly AgentUsage[], limits: Thresholds) => {
  const over = usages.filter(u => isOver(u, limits, alerting.includes(u.key) ? EXIT_RATIO : 1)).map(u => u.key)
  return { alerting: over, entered: over.filter(key => !alerting.includes(key)) }
}

export const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0M'
  if (bytes < 10 * MB) return `${(bytes / MB).toFixed(1)}M`
  if (bytes < 1000 * MB) return `${Math.round(bytes / MB)}M`
  if (bytes < 10 * GB) return `${(bytes / GB).toFixed(1)}G`
  return `${Math.round(bytes / GB)}G`
}

const formatCpu = (cpu: number) => `${Math.round(cpu)}%`

type NameOf = (key: string) => string

/** The status line: every agent over a threshold, or undefined to clear it. */
export const statusLine = (alerting: readonly string[], usages: readonly AgentUsage[], nameOf: NameOf) => {
  const over = usages.filter(u => alerting.includes(u.key))
  if (over.length === 0) return undefined
  return `⚠ ${over.map(u => `${nameOf(u.key)} ${formatBytes(u.pss)} ${formatCpu(u.cpu)}cpu`).join(' · ')}`
}

/** One row of the /agent-usage table: an agent, or a shared row (claude itself, its untracked children). */
/** What the table shows of a process. */
type TableProc = Pick<ProcUsage, 'pid' | 'command' | 'pss' | 'cpu'>

export type TableRow = {
  name: string
  kind: 'agent' | 'shared'
  now: Level
  peak: Level
  max: Level
  procs: readonly TableProc[]
}

const TOP_PROCS = 3
const COMMAND_WIDTH = 80
const GAP = '  '

/** Lines of cells, each column padded to its widest; the last column is not padded. */
const columns = (lines: readonly (readonly string[])[], indent = '') => {
  const widths = (lines[0] ?? []).map((_, i) => Math.max(...lines.map(cells => (cells[i] ?? '').length)))
  return lines.map(cells => indent + cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join(GAP))
}

const oneLine = (command: string) => {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > COMMAND_WIDTH ? `${flat.slice(0, COMMAND_WIDTH - 1)}…` : flat
}

const levelCells = (row: TableRow) => [
  [formatBytes(row.now.pss), formatBytes(row.peak.pss), formatBytes(row.max.pss)],
  [formatCpu(row.now.cpu), formatCpu(row.peak.cpu), formatCpu(row.max.cpu)],
]

const procLines = (procs: readonly TableProc[]) =>
  procs.length === 0 ? [] : columns(procs.slice(0, TOP_PROCS).map(p => [`pid ${p.pid}`, formatBytes(p.pss), formatCpu(p.cpu), oneLine(p.command)]), '    ')

/** The /agent-usage table: agents biggest first, then the shared rows; each with its top processes under it. */
export const usageTable = (rows: readonly TableRow[]) => {
  const ordered = [
    ...rows.filter(r => r.kind === 'agent').sort((a, b) => b.now.pss - a.now.pss),
    ...rows.filter(r => r.kind === 'shared'),
  ]
  const header = ['agent', 'mem', '1m peak', 'max', 'cpu', '1m peak', 'max']
  const lines = columns([header, ...ordered.map(row => [row.name, ...levelCells(row).flat()])])
  const [head, ...body] = lines
  return [head ?? '', ...body.flatMap((line, i) => [line, ...procLines(ordered[i]?.procs ?? [])])].join('\n')
}

/** One line of the footer column. */
export type FooterLine = { key: string; text: string; isOver: boolean }

const footerName = (key: string, names: Readonly<Record<string, string>>) => {
  if (key === CLAUDE) return 'claude'
  if (key === OTHER) return 'untracked'
  if (key === MAIN) return 'main'
  return names[key] ?? key.slice(0, 8)
}

/**
 * The footer column: the rows over `min` in memory or CPU (and any over a warning threshold),
 * agents biggest first, then claude and the untracked rest; name, memory and CPU padded to
 * columns by cell width, with a leading ⚠ column while any row is over a threshold. Empty
 * when no row is over: no column is drawn then.
 */
export const footerColumn = (usages: readonly AgentUsage[], alerting: readonly string[], names: Readonly<Record<string, string>>, min: Level): FooterLine[] => {
  const shown = usages.filter(u => alerting.includes(u.key) || u.pss > min.pss || u.cpu > min.cpu)
  const ordered = [
    ...shown.filter(u => !SHARED.includes(u.key)).sort((a, b) => b.pss - a.pss),
    ...SHARED.flatMap(key => shown.filter(u => u.key === key)),
  ]
  const cells = ordered.map(u => [footerName(u.key, names), formatBytes(u.pss), formatCpu(u.cpu)] as const)
  const width = (i: number) => Math.max(0, ...cells.map(row => cellWidth(row[i] ?? '')))
  const [name, mem, cpu] = [width(0), width(1), width(2)]
  const hasMark = ordered.some(u => alerting.includes(u.key))
  return ordered.map((u, i) => {
    const [n, m, c] = cells[i] ?? ['', '', '']
    const isOver = alerting.includes(u.key)
    const mark = hasMark ? (isOver ? '⚠ ' : '  ') : ''
    return { key: u.key, text: `${mark}${padEnd(n, name)}  ${padStart(m, mem)}  ${padStart(c, cpu)}`, isOver }
  })
}
