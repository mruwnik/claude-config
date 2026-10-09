import { descendantsOf } from './gather'
import type { Host, Machine, System } from './gather'
import { parseEnvAgent } from './proc'
import type { Stat } from './proc'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Ticks per second the Stat fields are given in, as on Linux. */
const HZ = 100

/** `ps -o time`: `[[dd-]hh:]mm:ss.cc` of CPU (user and system), in ticks. */
export const parseCpuTime = (text: string) => {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text]
  const seconds = (clock ?? '').split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400
  return /^[\d:.-]+$/.test(text) ? Math.round(seconds * HZ) : NaN
}

/** `ps -o lstart` under TZ=UTC0 and LC_ALL=C, `Thu Oct  8 21:46:45 2026`, in ms since the epoch. */
export const parseLstart = (text: string) => {
  const [, month = '', day, h, m, s, year] = /^\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(text.trim()) ?? []
  const index = MONTHS.indexOf(month)
  return index < 0 ? NaN : Date.UTC(Number(year), index, Number(day), Number(h), Number(m), Number(s))
}

const STATS = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}) (.*)$/

/**
 * `ps -o pid=,ppid=,time=,lstart=,ucomm=` into stats. lstart has whole seconds, so a process
 * is put at the middle of its second: within half a second of when it really started.
 */
export const parsePsStats = (text: string, bootMs: number) =>
  new Map(
    text.split('\n').flatMap((line): [number, Stat][] => {
      const [, pid, ppid, time = '', started = '', comm = ''] = STATS.exec(line) ?? []
      const stat = { pid: Number(pid), comm: comm.trim(), ppid: Number(ppid), sid: 0, utime: parseCpuTime(time), stime: 0, start: Math.round(((parseLstart(started) + 500 - bootMs) * HZ) / 1000) }
      return Number.isFinite(stat.utime) && Number.isFinite(stat.start) ? [[stat.pid, stat]] : []
    }),
  )

const ROW = /^\s*(\d+) ?(.*)$/

const rows = (text: string) => text.split('\n').flatMap(line => {
  const [, pid, rest = ''] = ROW.exec(line) ?? []
  return pid === undefined ? [] : [[Number(pid), rest] as const]
})

/** ps escapes newline and tab (and other controls) as `\ooo`, and leaves a backslash alone. */
const unvis = (text: string) => text.replace(/\\([0-3][0-7]{2})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))

/**
 * `ps -ww -o pid=,args=`: the arguments joined by single spaces, so they are split on single
 * spaces and joined again exactly; where one argument held a space it is two here.
 */
export const parsePsArgs = (text: string) => new Map(rows(text).map(([pid, args]) => [pid, unvis(args).split(' ')]))

/** The agent `ps -E -ww -o pid=,command=` names: the environment follows the arguments, so the last LIVE_TESTS_AGENT_ID wins. */
export const parsePsEnvAgents = (text: string) =>
  new Map(rows(text).map(([pid, command]) => [pid, parseEnvAgent(unvis(command).split(' ').filter(word => word.startsWith('LIVE_TESTS_AGENT_ID=')).at(-1) ?? '')]))

/** `ps -o pid=,rss=`: kB to bytes. */
export const parsePsRss = (text: string) => new Map(rows(text).map(([pid, kb]) => [pid, Number(kb) * 1024]))

/** `sysctl -n kern.boottime`: `{ sec = 1787924349, usec = 682773 } ...`. */
export const parseBoottime = (text: string) => {
  const [, sec, usec] = /sec = (\d+), usec = (\d+)/.exec(text) ?? []
  return sec === undefined ? NaN : Number(sec) * 1000 + Number(usec) / 1000
}

/**
 * `sysctl -n vm.loadavg hw.memsize kern.memorystatus_level`, a line each. Available memory is
 * the kernel's free percentage of the total, the figure its memory pressure works from.
 */
export const parseSysctlMachine = (text: string): Machine => {
  const [loadavg = '', memsize = '', level = ''] = text.split('\n')
  const [load1, load5] = loadavg.replace(/[{}]/g, '').trim().split(/\s+/).map(Number)
  const totalKb = Number(memsize) / 1024
  const free = Number(level)
  const isMem = memsize !== '' && level !== '' && Number.isFinite(totalKb) && Number.isFinite(free)
  const isLoad = load1 !== undefined && load5 !== undefined && Number.isFinite(load1) && Number.isFinite(load5)
  return {
    mem: isMem ? { availableKb: Math.round((totalKb * free) / 100), totalKb } : undefined,
    loadavg: isLoad ? { load1, load5 } : undefined,
  }
}

/** Fixed environment: lstart in UTC, month names in English. */
const PS_ENV = { TZ: 'UTC0', LC_ALL: 'C' }

/** macOS: no /proc, so everything comes from ps and sysctl. ps has no PSS: memory is RSS. */
export const darwinSystem = async (host: Host): Promise<System> => {
  const run = async (argv: string[]) => (await host.run(argv, PS_ENV)).stdout
  const ps = (cols: string, pids: readonly number[] | 'all', flags: string[] = []) =>
    pids !== 'all' && pids.length === 0 ? Promise.resolve('') : run(['ps', ...flags, '-ww', '-o', cols, ...(pids === 'all' ? ['-A'] : ['-p', pids.join(',')])])
  // sh's parent is the process that ran it: claude.
  const claudePid = Number((await run(['sh', '-c', 'echo $PPID'])).trim())
  const [boottime = '', ncpu = ''] = (await run(['sysctl', '-n', 'kern.boottime', 'hw.ncpu'])).split('\n')
  const bootMs = parseBoottime(boottime)
  if (!Number.isFinite(bootMs)) throw new Error('could not read the boot time from sysctl kern.boottime')
  const stats = async (pids: readonly number[] | 'all') => parsePsStats(await ps('pid=,ppid=,time=,lstart=,ucomm=', pids), bootMs)
  return {
    claudePid,
    comm: (await stats([claudePid])).get(claudePid)?.comm ?? '?',
    bootMs,
    cores: Number(ncpu),
    note: 'reading processes through ps and sysctl',
    memory: 'RSS',
    scanAll: () => stats('all'),
    walk: async roots => descendantsOf(await stats('all'), roots),
    stats,
    argvs: async pids => parsePsArgs(await ps('pid=,args=', pids)),
    envAgents: async pids => parsePsEnvAgents(await ps('pid=,command=', pids, ['-E'])),
    memoryOf: async pids => new Map([...parsePsRss(await ps('pid=,rss=', pids))].map(([pid, rss]) => [pid, { pss: rss, rss }])),
    machine: async () => parseSysctlMachine(await run(['sysctl', '-n', 'vm.loadavg', 'hw.memsize', 'kern.memorystatus_level'])),
  }
}
