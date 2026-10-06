import type { BashRecord } from '../types'
import { SLACK_MS, startedMs } from './attribute'
import { parseChildren, parseStat } from './proc'
import type { Stat } from './proc'

export type Source = { reader: Reader; claudePid: number; comm: string; bootMs: number; cores: number; note: string }

/** Reads /proc in batches: the files it could read (a vanished process's are just absent), and directories' entry names. */
export type Reader = {
  via: 'fs' | 'process'
  read: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>
  list: (dirs: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>
}

const readStats = async (reader: Reader, pids: readonly number[]) => {
  const files = await reader.read(pids.map(pid => `/proc/${pid}/stat`))
  return pids.map(pid => parseStat(files.get(`/proc/${pid}/stat`) ?? '')).filter(stat => stat !== undefined && stat.pid !== 0)
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
