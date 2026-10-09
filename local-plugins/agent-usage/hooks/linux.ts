import { readArgvs, readEnvirons, readPss, readStats, scanAll, walk } from './gather'
import type { Host, Reader, System } from './gather'
import { parseArgv, parseBtime, parseCpuCount, parseCpuTimes, parseEnvAgent, parseGrepOutput, parseLoadavg, parseMeminfo, parsePss, parseRss, parseStat } from './proc'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const fsReader = (host: Host): Reader => ({
  via: 'fs',
  read: async paths => {
    const read = await Promise.all(paths.map(path => host.read(path).then(text => [path, text] as const, () => undefined)))
    return new Map(read.filter(entry => entry !== undefined))
  },
  list: async dirs => {
    const listed = await Promise.all(dirs.map(dir => host.list(dir).catch(() => [])))
    return new Map(dirs.map((dir, i) => [dir, listed[i] ?? []]))
  },
})

/** Arguments per subprocess, well under the kernel's limit. */
const CHUNK = 400

const chunks = <T,>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

/** The fallback when `$.fs` cannot read /proc: fixed argv, no shell; `grep` prints the files, `find` lists the directories. */
const processReader = (host: Host): Reader => ({
  via: 'process',
  read: async paths => {
    const outs = await Promise.all(chunks(paths).map(part => host.run(['grep', '-asH', '-e', '', '--', ...part])))
    return new Map(outs.flatMap(out => [...parseGrepOutput(out.stdout)]))
  },
  list: async dirs => {
    const outs = await Promise.all(chunks(dirs).map(part => host.run(['find', ...part, '-mindepth', '1', '-maxdepth', '1', '-printf', '%p\\n'])))
    const paths = outs.flatMap(out => out.stdout.split('\n')).filter(line => line !== '')
    const nameIn = (dir: string) => paths.filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1))
    return new Map(dirs.map(dir => [dir, nameIn(dir)]))
  },
})

const SELF_STAT = '/proc/self/stat'

const systemOf = async (reader: Reader, claudePid: number, note: string): Promise<System> => {
  const files = await reader.read([`/proc/${claudePid}/stat`, '/proc/stat', '/proc/cpuinfo'])
  const bootMs = parseBtime(files.get('/proc/stat') ?? '') * 1000
  if (!Number.isFinite(bootMs)) throw new Error('could not read the boot time from /proc/stat')
  return {
    claudePid,
    comm: parseStat(files.get(`/proc/${claudePid}/stat`) ?? '')?.comm ?? '?',
    bootMs,
    cores: parseCpuCount(files.get('/proc/cpuinfo') ?? ''),
    note,
    memory: 'PSS',
    scanAll: () => scanAll(reader),
    walk: roots => walk(reader, roots),
    stats: async pids => new Map((await readStats(reader, pids)).map(stat => [stat.pid, stat])),
    argvs: async pids => new Map([...(await readArgvs(reader, pids))].map(([pid, text]) => [pid, parseArgv(text)])),
    envAgents: async pids => new Map([...(await readEnvirons(reader, pids))].map(([pid, text]) => [pid, parseEnvAgent(text)])),
    memoryOf: async pids => new Map([...(await readPss(reader, pids))].map(([pid, text]) => [pid, { pss: parsePss(text), rss: parseRss(text) }])),
    machine: async () => {
      const machine = await reader.read(['/proc/meminfo', '/proc/loadavg', '/proc/stat'])
      return {
        mem: parseMeminfo(machine.get('/proc/meminfo') ?? ''),
        loadavg: parseLoadavg(machine.get('/proc/loadavg') ?? ''),
        cpuTimes: parseCpuTimes(machine.get('/proc/stat') ?? ''),
      }
    },
  }
}

/**
 * Finds a way to read /proc and claude's pid. `$.fs` runs in claude's own process, so its
 * /proc/self is claude; procfs files report size 0, so an empty read means `$.fs` cannot
 * read them, and the fallback's /proc/self is grep, whose parent is claude.
 */
export const linuxSystem = async (host: Host): Promise<System> => {
  const viaFs = await host.read(SELF_STAT).catch((error: unknown) => new Error(errorText(error)))
  const fsStat = viaFs instanceof Error ? undefined : parseStat(viaFs)
  if (fsStat !== undefined) return systemOf(fsReader(host), fsStat.pid, 'reading /proc through $.fs')
  const why = viaFs instanceof Error ? `$.fs.read failed: ${viaFs.message}` : `$.fs.read came back ${viaFs === '' ? 'empty' : 'unparseable'}`
  const reader = processReader(host)
  const grepStat = parseStat((await reader.read([SELF_STAT])).get(SELF_STAT) ?? '')
  if (grepStat === undefined) throw new Error(`cannot read /proc: ${why}, and grep could not either`)
  return systemOf(reader, grepStat.ppid, `reading /proc through grep/find subprocesses (${why} for ${SELF_STAT})`)
}
