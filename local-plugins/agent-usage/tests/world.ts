import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export const BOOT_S = 1_700_000_000
export const BOOT_MS = BOOT_S * 1000
/** The test starts 100 s after boot: starttime 10000 ticks. */
export const START_MS = BOOT_MS + 100_000
export const CLAUDE = 100

export const COMMAND = "node big.js --name 'x'"

export type Fake = { ppid: number; comm: string; startTicks: number; ticks?: number; argv?: readonly string[]; pssKb?: number; children?: readonly number[]; environ?: string }

export const statText = (pid: number, p: Fake) => {
  const fields = Array.from({ length: 50 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(p.ppid)
  fields[11] = String(p.ticks ?? 0)
  fields[19] = String(p.startTicks)
  return `${pid} (${p.comm}) ${fields.join(' ')}\n`
}

export const toolBash = (command: string) => ['/bin/bash', '-c', `source s.sh && eval '${command.replaceAll("'", `'"'"'`)}' && pwd -P >| /tmp/claude-ab-cwd`]

/** A machine with init, claude (pid 100) and an MCP server under it; the Bash call adds its shell and a big node under that. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** As `ps -o lstart` prints it under TZ=UTC0: whole seconds. */
const lstart = (ms: number) => {
  const d = new Date(ms)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}

/** As `ps -o time` prints it: minutes, then seconds to the hundredth. */
const cpuTime = (ticks: number) => `${Math.floor(ticks / 6000)}:${((ticks % 6000) / 100).toFixed(2).padStart(5, '0')}`

/** As macOS ps prints arguments: joined by spaces, newline and tab as octal escapes. */
const visArgs = (argv: readonly string[]) => argv.join(' ').replaceAll('\n', '\\012').replaceAll('\t', '\\011')

export const world = (on: On, { isFsBlind = false, os = 'Linux' as 'Linux' | 'Darwin', agents = [] as readonly unknown[] } = {}) => {
  const procs = new Map<number, Fake>([
    [1, { ppid: 0, comm: 'systemd', startTicks: 1, argv: ['/sbin/init'] }],
    [CLAUDE, { ppid: 1, comm: 'claude', startTicks: 5000, argv: ['claude'], pssKb: 500 * 1024, children: [300] }],
    [300, { ppid: CLAUDE, comm: 'node', startTicks: 5100, argv: ['node', 'mcp.js'], pssKb: 50 * 1024 }],
  ])
  const mem = { availableMb: 16_000 }
  // The machine's CPU ticks so far (user, then idle), which the test moves on to set its CPU use.
  const machine = { busy: 1000, idle: 9000 }
  const files = () => {
    const entries: [string, string][] = [
      ['/proc/stat', `cpu  ${machine.busy} 0 0 ${machine.idle} 0 0 0 0 0 0\nbtime ${BOOT_S}\n`],
      ['/proc/loadavg', '7.49 6.05 4.80 4/2038 4174348\n'],
      ['/proc/cpuinfo', 'processor\t: 0\nmodel name\t: x\n\nprocessor\t: 1\nmodel name\t: x\n\nprocessor\t: 2\n\nprocessor\t: 3\n'],
      ['/proc/meminfo', `MemTotal:       ${32_000 * 1024} kB\nMemFree:  1 kB\nMemAvailable:   ${mem.availableMb * 1024} kB\n`],
    ]
    procs.forEach((p, pid) => {
      entries.push([`/proc/${pid}/stat`, statText(pid, p)])
      entries.push([`/proc/${pid}/cmdline`, (p.argv ?? []).map(a => `${a}\0`).join('')])
      entries.push([`/proc/${pid}/smaps_rollup`, `0-1 ---p 0 00:00 0 [rollup]\nRss: 1 kB\nPss: ${p.pssKb ?? 0} kB\n`])
      entries.push([`/proc/${pid}/task/${pid}/children`, (p.children ?? []).join(' ')])
      entries.push([`/proc/${pid}/environ`, p.environ ?? 'PATH=/bin\0'])
    })
    entries.push(['/proc/self/stat', statText(CLAUDE, procs.get(CLAUDE) as Fake)])
    return new Map(entries)
  }
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: START_MS })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const tools: string[] = []
  on('tool.register', (_$, e) => {
    tools.push(e.description)
    return { value: { tool: `mcp__agent-usage__${e.name}` } }
  })
  const written = new Map<string, string>()
  on('fs.write', (_$, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  const appended: string[] = []
  on('session.append', (_$, e, next) => {
    appended.push(e.message.content.map(b => (b.type === 'text' ? String(b.text) : '')).join(''))
    return next(e)
  })
  on('agent.list', () => ({ value: agents as never }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const namesIn = (dir: string) => {
    const prefix = `${dir}/`
    return [...new Set([...files().keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? ''))]
  }
  // A blind $.fs reads procfs files as their reported size: empty. macOS has no /proc at all.
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const text = os === 'Darwin' ? undefined : files().get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: isFsBlind ? '' : text }
  })
  on('fs.list', (_$, e) => ({ value: namesIn(e.path).map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  // grep -asH -e '' -- <files> and find <dirs> -mindepth 1 -maxdepth 1 -printf '%p\n', as the fallback runs them; grep's own /proc/self is a child of claude.
  const runs: string[][] = []
  const reads: string[] = []
  const sysctl = (name: string) =>
    ({
      'kern.boottime': `{ sec = ${BOOT_S}, usec = 0 } Tue Nov 14 22:13:20 2023`,
      'hw.ncpu': '4',
      'vm.loadavg': '{ 7.49 6.05 4.80 }',
      'hw.memsize': String(32_000 * 1024 * 1024),
      'kern.memorystatus_level': String(Math.round((mem.availableMb * 100) / 32_000)),
    })[name] ?? ''
  /** `ps [-E] -ww -o <cols> (-A | -p <pids>)`, as the macOS handler runs it, from the same processes. */
  const ps = (args: readonly string[]) => {
    const cols = (args[args.indexOf('-o') + 1] ?? '').split(',').map(col => col.replace('=', ''))
    const pids = args.includes('-A') ? [...procs.keys()] : (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number).filter(pid => procs.has(pid))
    const env = (p: Fake) => (args.includes('-E') ? (p.environ ?? 'PATH=/bin\0').split('\0').filter(v => v !== '') : [])
    const col = (pid: number, p: Fake, name: string) =>
      ({
        pid: String(pid).padStart(5),
        ppid: String(p.ppid).padStart(5),
        time: cpuTime(p.ticks ?? 0).padStart(10),
        rss: String(p.pssKb ?? 0).padStart(8),
        lstart: lstart(BOOT_MS + (p.startTicks * 1000) / 100),
        ucomm: p.comm,
        args: visArgs(p.argv ?? []),
        command: visArgs([...(p.argv ?? []), ...env(p)]),
      })[name] ?? ''
    return pids.map(pid => cols.map(name => col(pid, procs.get(pid) as Fake, name)).join(' ')).join('\n')
  }
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    const [tool, ...args] = e.argv
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout: stdout === '' ? '' : `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (tool === 'uname') return answer(os)
    if (os === 'Darwin') {
      if (tool === 'sh') return answer(String(CLAUDE))
      if (tool === 'sysctl') return answer(args.filter(arg => arg !== '-n').map(sysctl).join('\n'))
      if (tool === 'ps') return answer(ps(args))
      return answer('', 1)
    }
    const grepped = (path: string) => (path === '/proc/self/stat' ? statText(999, { ppid: CLAUDE, comm: 'grep', startTicks: 20_000 }) : files().get(path))
    const lines =
      tool === 'grep'
        ? args.slice(args.indexOf('--') + 1).flatMap(path => (grepped(path) ?? '').split('\n').filter(line => line !== '').map(line => `${path}:${line}`))
        : args.slice(0, args.indexOf('-mindepth')).flatMap(dir => namesIn(dir).map(name => `${dir}/${name}`))
    return answer(lines.join('\n'))
  })
  // `kill -TERM|-KILL <pids>`, as agent_reap sends it through Bash: recorded, never run. TERM ends all
  // but the stubborn, KILL all but the unkillable; `answer: 'deny'` refuses it as the permission check would.
  const kills: string[] = []
  const reaping = { stubborn: new Set<number>(), unkillable: new Set<number>(), answer: 'ok' as 'ok' | 'deny' | 'error' }
  const kill = (command: string) => {
    kills.push(command)
    if (reaping.answer === 'deny') return { deny: 'denied by the test' }
    if (reaping.answer === 'error') return { result: { stdout: '', stderr: '' }, isError: true, text: 'The user rejected it' }
    const [, signal = '', list = ''] = /^kill -(TERM|KILL) ([\d ]+)$/.exec(command) ?? []
    const spared = signal === 'TERM' ? reaping.stubborn : reaping.unkillable
    list.split(' ').map(Number).filter(pid => !spared.has(pid)).forEach(pid => {
      procs.delete(pid)
      procs.forEach((p, parent) => procs.set(parent, { ...p, children: (p.children ?? []).filter(child => child !== pid) }))
    })
    return { result: { stdout: '', stderr: '', interrupted: false } }
  }
  // As Bash leaves a command running in the background: its shell under claude, the command under that.
  const calls: unknown[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    if (e.command.startsWith('kill ')) return kill(e.command) as never
    calls.push(e)
    procs.set(CLAUDE, { ...(procs.get(CLAUDE) as Fake), children: [300, 200] })
    procs.set(200, { ppid: CLAUDE, comm: 'bash', startTicks: 10_000, argv: toolBash(e.command), pssKb: 4 * 1024, children: [201] })
    procs.set(201, { ppid: 200, comm: 'node', startTicks: 10_001, argv: ['node', 'big.js'], pssKb: 3 * 1024 * 1024 })
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }
  })
  return { procs, statuses, toasts, clock, calls, runs, mem, machine, tools, written, appended, kills, reaping, reads }
}

export const startSession = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

export const usageText = async ($: Engine) => {
  const { text } = await $.command.run({ command: 'agent-usage', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  return text ?? ''
}

