/** What the mod reads of /proc/<pid>/stat; times are in clock ticks, `start` since boot. */
export type Stat = {
  pid: number
  comm: string
  ppid: number
  sid: number
  utime: number
  stime: number
  start: number
}

/**
 * Parses /proc/<pid>/stat. `comm` may hold spaces and parens, so the fields are
 * counted from after its last `)`: field n (1-based, man 5 proc) is `rest[n - 3]`.
 */
export const parseStat = (text: string): Stat | undefined => {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return undefined
  const rest = text.slice(close + 2).trim().split(/\s+/)
  if (rest.length < 20) return undefined
  const field = (n: number) => Number(rest[n - 3])
  const stat = {
    pid: Number(text.slice(0, open)),
    comm: text.slice(open + 1, close),
    ppid: field(4),
    sid: field(6),
    utime: field(14),
    stime: field(15),
    start: field(22),
  }
  const numbers = [stat.pid, stat.ppid, stat.sid, stat.utime, stat.stime, stat.start]
  return numbers.every(Number.isFinite) ? stat : undefined
}

/** /proc/<pid>/cmdline: NUL-separated, with a trailing NUL; empty for a kernel thread. */
export const parseArgv = (text: string): string[] => (text === '' ? [] : text.replace(/\0$/, '').split('\0'))

/** The Bash tool's wrapper: `... && eval '<command>' [< /dev/null] && pwd -P >| /tmp/claude-XXXX-cwd`. */
const EVAL = /&& eval '([\s\S]*)'(?: < \/dev\/null)? && pwd -P >\| \S+\s*$/

/**
 * The exact command a Bash tool shell runs, from its argv, or undefined for any other process.
 * Any argument may hold the script, so a sandbox launcher in front of `bash -c` still matches;
 * so may all of them joined, as macOS ps gives the script split on its spaces.
 */
export const evalCommand = (argv: readonly string[]): string | undefined => {
  const quoted = [...argv, argv.join(' ')].map(arg => EVAL.exec(arg)?.[1]).find(match => match !== undefined)
  return quoted?.replaceAll(`'"'"'`, `'`)
}

const ENV_AGENT = 'LIVE_TESTS_AGENT_ID='
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The agent a process's environment names, from /proc/<pid>/environ (NUL-separated): live-tests
 * exports LIVE_TESTS_AGENT_ID in its suite commands. Undefined when absent, empty or no plain id.
 */
export const parseEnvAgent = (text: string) => {
  const value = text.split('\0').find(entry => entry.startsWith(ENV_AGENT))?.slice(ENV_AGENT.length)
  return value !== undefined && AGENT_ID.test(value) ? value : undefined
}

/** Proportional set size in bytes, from /proc/<pid>/smaps_rollup; 0 when absent. */
export const parsePss = (text: string) => {
  const kb = /^Pss:\s+(\d+) kB/m.exec(text)?.[1]
  return kb === undefined ? 0 : Number(kb) * 1024
}

/** Resident set size in bytes, from the same rollup; 0 when absent. */
export const parseRss = (text: string) => {
  const kb = /^Rss:\s+(\d+) kB/m.exec(text)?.[1]
  return kb === undefined ? 0 : Number(kb) * 1024
}

/** MemAvailable and MemTotal from /proc/meminfo, in kB; undefined when either is missing. */
export const parseMeminfo = (text: string) => {
  const kb = (name: string) => new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]
  const [available, total] = [kb('MemAvailable'), kb('MemTotal')]
  return available === undefined || total === undefined ? undefined : { availableKb: Number(available), totalKb: Number(total) }
}

/** /proc/<pid>/task/<tid>/children: space-separated pids. */
export const parseChildren = (text: string) => text.split(/\s+/).filter(word => word !== '').map(Number)

/** Boot time in seconds since the epoch, from /proc/stat. */
export const parseBtime = (text: string) => Number(/^btime (\d+)/m.exec(text)?.[1] ?? NaN)

/**
 * `grep -asH '' <files>` output back into files: every line comes as `<path>:<line>`, so a
 * file of several lines is joined again. /proc paths hold no `:`; an empty file has no lines.
 */
export const parseGrepOutput = (text: string): Map<string, string> => {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const files = new Map<string, string[]>()
  lines
    .filter(line => line.includes(':'))
    .forEach(line => {
      const cut = line.indexOf(':')
      const path = line.slice(0, cut)
      files.set(path, [...(files.get(path) ?? []), line.slice(cut + 1)])
    })
  return new Map([...files].map(([path, parts]) => [path, parts.join('\n')]))
}

/** The 1 and 5 minute load averages, from /proc/loadavg. */
export const parseLoadavg = (text: string) => {
  const [load1, load5] = text.trim().split(/\s+/).map(Number)
  return load1 === undefined || load5 === undefined || !Number.isFinite(load1) || !Number.isFinite(load5) ? undefined : { load1, load5 }
}

/** How many logical CPUs /proc/cpuinfo lists. */
export const parseCpuCount = (text: string) => text.split('\n').filter(line => /^processor\s*:/.test(line)).length

export type CpuTimes = { busy: number; total: number }

/** The machine's CPU ticks so far, from /proc/stat's `cpu` line: idle and iowait idle, the rest busy. */
export const parseCpuTimes = (text: string): CpuTimes | undefined => {
  const fields = /^cpu\s+(.*)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number)
  if (fields === undefined || fields.length < 5 || !fields.every(Number.isFinite)) return undefined
  const total = fields.slice(0, 8).reduce((sum, n) => sum + n, 0)
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0)
  return { busy: total - idle, total }
}

/** The whole machine's CPU use between two readings, in % of all cores; undefined without both. */
export const systemCpuPct = (prev: CpuTimes | undefined, now: CpuTimes) => {
  if (prev === undefined || now.total <= prev.total) return undefined
  return Math.round(((now.busy - prev.busy) * 100) / (now.total - prev.total))
}
