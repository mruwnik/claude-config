import { expect, test } from 'claude-code/testing'

import { evalCommand, parseArgv, parseBtime, parseChildren, parseCpuCount, parseCpuTimes, parseEnvAgent, parseGrepOutput, parseLoadavg, parseMeminfo, parsePss, parseRss, parseStat, systemCpuPct } from '../hooks/proc'

/** A /proc/<pid>/stat line with the fields the mod reads set, the rest zero. */
const statLine = (pid: number, comm: string, f: { ppid: number; sid?: number; utime?: number; stime?: number; start?: number }) => {
  const fields = Array.from({ length: 52 }, () => '0')
  const set = (n: number, v: number | string) => (fields[n - 1] = String(v))
  set(3, 'S')
  set(4, f.ppid)
  set(5, f.sid ?? 0)
  set(6, f.sid ?? 0)
  set(14, f.utime ?? 0)
  set(15, f.stime ?? 0)
  set(22, f.start ?? 0)
  return `${pid} (${comm}) ${fields.slice(2).join(' ')}\n`
}

const STATS = [
  ['a plain name', statLine(42, 'bash', { ppid: 7, sid: 40, utime: 120, stime: 30, start: 9000 }), { pid: 42, comm: 'bash', ppid: 7, sid: 40, utime: 120, stime: 30, start: 9000 }],
  ['a name with spaces and parens', statLine(9, 'tmux: server) (x', { ppid: 1, start: 5 }), { pid: 9, comm: 'tmux: server) (x', ppid: 1, sid: 0, utime: 0, stime: 0, start: 5 }],
] as const

for (const [name, text, expected] of STATS) {
  test(`parseStat: ${name}`, () => {
    expect(parseStat(text)).toMatchObject(expected)
  })
}

const BAD_STATS = ['', 'garbage', '12 (cut short) S 1 2'] as const

for (const text of BAD_STATS) {
  test(`parseStat rejects ${JSON.stringify(text)}`, () => {
    expect(parseStat(text)).toBeUndefined()
  })
}

const ARGVS = [
  ['NUL separated with a trailing NUL', '/bin/bash\0-c\0echo hi\0', ['/bin/bash', '-c', 'echo hi']],
  ['an empty argument kept', 'grep\0-asH\0\0/proc/1/stat\0', ['grep', '-asH', '', '/proc/1/stat']],
  ['a kernel thread', '', []],
] as const

for (const [name, text, expected] of ARGVS) {
  test(`parseArgv: ${name}`, () => {
    expect(parseArgv(text)).toEqual(expected)
  })
}

const PREFIX = "source /home/u/.claude/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true"

const script = (quoted: string, devNull: boolean) =>
  `${PREFIX} && eval '${quoted}'${devNull ? ' < /dev/null' : ''} && pwd -P >| /tmp/claude-1fc6-cwd`

const EVALS = [
  ['a plain command', ['/bin/bash', '-c', script('npm test', false)], 'npm test'],
  ['with < /dev/null', ['/bin/bash', '-c', script('npm test', true)], 'npm test'],
  ['single quotes unescaped', ['/bin/bash', '-c', script(`echo "it'"'"'s" | tr '"'"' '"'"' x`, false)], `echo "it's" | tr ' ' x`],
  ['several lines', ['/bin/bash', '-c', script('cat <<EOF\na\nEOF', false)], 'cat <<EOF\na\nEOF'],
  ['an eval inside the command', ['/bin/bash', '-c', script(`eval '"'"'x'"'"' && pwd -P >| y`, false)], `eval 'x' && pwd -P >| y`],
  ['wrapped by a sandbox launcher', ['bwrap', '--die-with-parent', '--', '/bin/bash', '-c', script('make', false)], 'make'],
] as const

for (const [name, argv, expected] of EVALS) {
  test(`evalCommand: ${name}`, () => {
    expect(evalCommand(argv)).toBe(expected)
  })
}

const NOT_EVALS = [
  ['an MCP server', ['node', '/x/server.js']],
  ['bash -c without the eval wrapper', ['/bin/bash', '-c', 'sleep 5']],
  ['nothing', []],
] as const

for (const [name, argv] of NOT_EVALS) {
  test(`evalCommand ignores ${name}`, () => {
    expect(evalCommand(argv)).toBeUndefined()
  })
}

const ROLLUP = `55afe2db8000-7ffc06bfa000 ---p 00000000 00:00 0                          [rollup]
Rss:                3720 kB
Pss:                 480 kB
Pss_Dirty:           440 kB
Pss_Anon:            440 kB
`

const PSS = [
  ['a rollup', ROLLUP, 480 * 1024],
  ['an empty read (a kernel thread, or a process gone)', '', 0],
] as const

for (const [name, text, expected] of PSS) {
  test(`parsePss: ${name}`, () => {
    expect(parsePss(text)).toBe(expected)
  })
}

const CHILDREN = [
  ['several', '12 13 99 ', [12, 13, 99]],
  ['none', '', []],
] as const

for (const [name, text, expected] of CHILDREN) {
  test(`parseChildren: ${name}`, () => {
    expect(parseChildren(text)).toEqual(expected)
  })
}

test('parseBtime reads the boot time in seconds', () => {
  expect(parseBtime('cpu  1 2 3\nintr 5\nctxt 9\nbtime 1791300000\nprocesses 7\n')).toBe(1791300000)
})

test('parseGrepOutput splits grep -H output back into files, joining a file of several lines', () => {
  const out = '/proc/1/stat:1 (systemd) S 0\n/proc/2/cmdline:bash\0-c\0cat <<EOF\n/proc/2/cmdline:a\n/proc/2/cmdline:EOF\0\n'
  const files = parseGrepOutput(out)
  expect(files.get('/proc/1/stat')).toBe('1 (systemd) S 0')
  expect(files.get('/proc/2/cmdline')).toBe('bash\0-c\0cat <<EOF\na\nEOF\0')
  expect(files.has('/proc/3/stat')).toBe(false)
})

test('parseRss reads Rss from a rollup, 0 when absent', () => {
  expect([parseRss(ROLLUP), parseRss('')]).toEqual([3720 * 1024, 0])
})

test('parseMeminfo reads MemAvailable and MemTotal in kB, undefined without them', () => {
  expect(parseMeminfo('MemTotal:       32723652 kB\nMemFree:         1424568 kB\nMemAvailable:    6985960 kB\n')).toEqual({ availableKb: 6985960, totalKb: 32723652 })
  expect(parseMeminfo('')).toBeUndefined()
})

test('parseLoadavg reads the 1 and 5 minute loads', () => {
  expect(parseLoadavg('7.49 6.05 4.80 4/2038 4174348\n')).toEqual({ load1: 7.49, load5: 6.05 })
  expect(parseLoadavg('')).toBeUndefined()
})

test('parseCpuCount counts the processor entries of /proc/cpuinfo', () => {
  expect(parseCpuCount('processor\t: 0\nmodel name\t: x\n\nprocessor\t: 1\nmodel name\t: x\n')).toBe(2)
  expect(parseCpuCount('')).toBe(0)
})

const CPU_TIMES = [
  ['the cpu line: busy and total ticks, iowait counted idle', 'cpu  100 20 30 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n', { busy: 150, total: 1000 }],
  ['nothing to read', '', undefined],
] as const

for (const [name, text, expected] of CPU_TIMES) {
  test(`parseCpuTimes: ${name}`, () => {
    expect(parseCpuTimes(text)).toEqual(expected)
  })
}

const SYSTEM_CPU = [
  ['a quarter of the machine busy', { busy: 100, total: 1000 }, { busy: 350, total: 2000 }, 25],
  ['no previous sample', undefined, { busy: 350, total: 2000 }, undefined],
  ['no time passed', { busy: 1, total: 10 }, { busy: 1, total: 10 }, undefined],
] as const

for (const [name, prev, now, expected] of SYSTEM_CPU) {
  test(`systemCpuPct: ${name}`, () => {
    expect(systemCpuPct(prev, now)).toBe(expected)
  })
}

const ENVIRONS = [
  ['the agent id among the variables', 'PATH=/bin\0LIVE_TESTS_AGENT_ID=a1b2c3\0LIVE_TESTS_RUN=7\0', 'a1b2c3'],
  ['no such variable', 'PATH=/bin\0HOME=/home/dan\0', undefined],
  ['empty', '', undefined],
  ['an empty value', 'LIVE_TESTS_AGENT_ID=\0', undefined],
  ['a value that is no id', 'LIVE_TESTS_AGENT_ID=a1; rm -rf /\0', undefined],
  ['only a prefix of the name', 'XLIVE_TESTS_AGENT_ID=a1\0', undefined],
  ['garbage with no separators', '\u0001\u0002LIVE_TESTS_AGENT_ID', undefined],
] as const

for (const [name, text, expected] of ENVIRONS) {
  test(`parseEnvAgent: ${name}`, () => {
    expect(parseEnvAgent(text)).toBe(expected)
  })
}
