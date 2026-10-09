import type { BashRecord } from '../types'
import { SLACK_MS, startedMs } from './attribute'
import { parseChildren, parseStat } from './proc'
import type { CpuTimes, Stat } from './proc'

export type Machine = {
  mem: { availableKb: number; totalKb: number } | undefined
  loadavg: { load1: number; load5: number } | undefined
  /** The machine's CPU ticks so far; absent where they cannot be read (macOS). */
  cpuTimes?: CpuTimes | undefined
}

/** What the OS handlers may do: run a fixed argv (no shell), read a file, list a directory's names. */
export type Host = {
  run: (argv: readonly string[], env?: Record<string, string>) => Promise<{ stdout: string }>
  read: (path: string) => Promise<string>
  list: (dir: string) => Promise<string[]>
}

/** One operating system's way of reading processes: the sampler and agent_reap see only this. */
export type System = {
  claudePid: number
  comm: string
  bootMs: number
  cores: number
  /** How the processes are read, for /agent-usage. */
  note: string
  /** PSS where the kernel splits shared pages between their users (Linux); RSS where it cannot (macOS). */
  memory: 'PSS' | 'RSS'
  /** Every process on the machine. */
  scanAll: () => Promise<Map<number, Stat>>
  /** The process trees under these roots. */
  walk: (roots: readonly number[]) => Promise<Map<number, Stat>>
  /** These processes as they are now; a gone one is absent. */
  stats: (pids: readonly number[]) => Promise<Map<number, Stat>>
  argvs: (pids: readonly number[]) => Promise<Map<number, string[]>>
  /** The agent each one's environment names (LIVE_TESTS_AGENT_ID), undefined for none. */
  envAgents: (pids: readonly number[]) => Promise<Map<number, string | undefined>>
  /** Bytes per process; `pss` is RSS where there is no PSS. */
  memoryOf: (pids: readonly number[]) => Promise<Map<number, { pss: number; rss: number }>>
  machine: () => Promise<Machine>
}

/** The processes of `stats` under these roots, roots included. */
export const descendantsOf = (stats: ReadonlyMap<number, Stat>, roots: readonly number[]) => {
  const kids = new Map<number, number[]>()
  stats.forEach(stat => kids.set(stat.ppid, [...(kids.get(stat.ppid) ?? []), stat.pid]))
  const under = (pid: number, seen: ReadonlySet<number>): number[] =>
    seen.has(pid) || !stats.has(pid) ? [] : [pid, ...(kids.get(pid) ?? []).flatMap(child => under(child, new Set([...seen, pid])))]
  const pids = new Set(roots.flatMap(root => under(root, new Set())))
  return new Map([...stats].filter(([pid]) => pids.has(pid)))
}

/** Reads /proc in batches: the files it could read (a vanished process's are just absent), and directories' entry names. */
export type Reader = {
  via: 'fs' | 'process'
  read: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>
  list: (dirs: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>
}

export const readStats = async (reader: Reader, pids: readonly number[]) => {
  const files = await reader.read(pids.map(pid => `/proc/${pid}/stat`))
  return pids.map(pid => parseStat(files.get(`/proc/${pid}/stat`) ?? '')).filter((stat): stat is Stat => stat !== undefined && stat.pid !== 0)
}

/** Every child of these processes, from each thread's children file. */
const childrenOf = async (reader: Reader, pids: readonly number[]) => {
  const dirs = pids.map(pid => `/proc/${pid}/task`)
  const tasks = await reader.list(dirs)
  const files = dirs.flatMap(dir => (tasks.get(dir) ?? []).map(tid => `${dir}/${tid}/children`))
  const read = await reader.read(files)
  return [...new Set(files.flatMap(file => parseChildren(read.get(file) ?? '')))]
}

const MAX_DEPTH = 64

/** The process trees under `roots`, level by level, one batch of reads per level. */
export const walk = async (reader: Reader, roots: readonly number[], seen: ReadonlyMap<number, Stat> = new Map(), depth = 0): Promise<Map<number, Stat>> => {
  const frontier = [...new Set(roots)].filter(pid => !seen.has(pid))
  if (frontier.length === 0 || depth >= MAX_DEPTH) return new Map(seen)
  const stats = await readStats(reader, frontier)
  const found = new Map([...seen, ...stats.map(stat => [stat.pid, stat] as const)])
  return walk(reader, await childrenOf(reader, stats.map(stat => stat.pid)), found, depth + 1)
}

/** Every process on the machine: what the reparent heuristic needs to see orphans. */
export const scanAll = async (reader: Reader) => {
  const names = (await reader.list(['/proc'])).get('/proc') ?? []
  const stats = await readStats(reader, names.filter(name => /^\d+$/.test(name)).map(Number))
  return new Map(stats.map(stat => [stat.pid, stat] as const))
}

/** The processes orphans land on: init and every `systemd` (the user's manager is a subreaper). */
export const reapersOf = (stats: ReadonlyMap<number, Stat>) =>
  new Set([...stats.values()].filter(stat => stat.pid === 1 || stat.comm === 'systemd').map(stat => stat.pid))

/** Whose argv attribution needs: claude's direct children, and orphans started while some Bash call ran. */
export const argvNeeded = (stats: ReadonlyMap<number, Stat>, claudePid: number, reapers: ReadonlySet<number>, records: readonly BashRecord[], bootMs: number, hz: number) => {
  const inSomeWindow = (stat: Stat) => {
    const at = startedMs(stat, bootMs, hz)
    return records.some(r => r.startedAt - SLACK_MS <= at && at <= (r.endedAt ?? Infinity) + SLACK_MS)
  }
  return [...stats.values()].filter(stat => stat.ppid === claudePid || (reapers.has(stat.ppid) && stat.pid !== claudePid && inSomeWindow(stat))).map(stat => stat.pid)
}

export const readArgvs = async (reader: Reader, pids: readonly number[]) => {
  const files = await reader.read(pids.map(pid => `/proc/${pid}/cmdline`))
  return new Map(pids.map(pid => [pid, files.get(`/proc/${pid}/cmdline`) ?? ''] as const))
}

export const readPss = async (reader: Reader, pids: readonly number[]) => {
  const files = await reader.read(pids.map(pid => `/proc/${pid}/smaps_rollup`))
  return new Map(pids.map(pid => [pid, files.get(`/proc/${pid}/smaps_rollup`) ?? ''] as const))
}

export const readEnvirons = async (reader: Reader, pids: readonly number[]) => {
  const files = await reader.read(pids.map(pid => `/proc/${pid}/environ`))
  return new Map(pids.map(pid => [pid, files.get(`/proc/${pid}/environ`) ?? ''] as const))
}
