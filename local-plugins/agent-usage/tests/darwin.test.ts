import { expect, test } from 'claude-code/testing'

import { parseBoottime, parseCpuTime, parseLstart, parsePsArgs, parsePsEnvAgents, parsePsRss, parsePsStats, parseSysctlMachine } from '../hooks/darwin'

const BOOT_MS = Date.UTC(2026, 9, 1, 0, 0, 0)

const CPU_TIMES = [
  ['minutes and seconds', '0:00.01', 1],
  ['minutes past an hour', '302:08.56', 1_812_856],
  ['hours', '1:02:03.45', 372_345],
  ['days', '2-01:00:00.00', 17_640_000],
  ['nonsense', 'x', NaN],
] as const

for (const [name, text, ticks] of CPU_TIMES) {
  test(`parseCpuTime: ${name}`, () => {
    expect(parseCpuTime(text)).toEqual(ticks)
  })
}

const LSTARTS = [
  ['a one-digit day', 'Thu Oct  8 21:46:45 2026', Date.UTC(2026, 9, 8, 21, 46, 45)],
  ['a two-digit day', 'Fri Aug 28 15:39:09 2026', Date.UTC(2026, 7, 28, 15, 39, 9)],
  ['an unknown month', 'Thu Foo  8 21:46:45 2026', NaN],
] as const

for (const [name, text, ms] of LSTARTS) {
  test(`parseLstart: ${name}`, () => {
    expect(parseLstart(text)).toEqual(ms)
  })
}

test('parsePsStats: pid, ppid, cpu ticks, and start in ticks since boot at the middle of its second; comm may hold spaces, its column padding dropped', () => {
  const text = [
    '    1     0   302:08.56 Thu Oct  1 00:00:00 2026     launchd         ',
    '  221     1     0:01.50 Thu Oct  1 00:01:40 2026 Google Chrome Helper',
    'garbage',
    '',
  ].join('\n')
  expect(parsePsStats(text, BOOT_MS)).toEqual(
    new Map([
      [1, { pid: 1, comm: 'launchd', ppid: 0, sid: 0, utime: 1_812_856, stime: 0, start: 50 }],
      [221, { pid: 221, comm: 'Google Chrome Helper', ppid: 1, sid: 0, utime: 150, stime: 0, start: 10_050 }],
    ]),
  )
})

const ARGS = [
  ['split on single spaces, so joining restores it', '  42 node big.js  --x', ['node', 'big.js', '', '--x']],
  ['octal escapes decoded: newline and tab', "  42 bash -c eval 'a\\012b\\011c'", ['bash', '-c', 'eval', "'a\nb\tc'"]],
  ['a lone backslash kept', '  42 echo x\\y', ['echo', 'x\\y']],
] as const

for (const [name, text, argv] of ARGS) {
  test(`parsePsArgs: ${name}`, () => {
    expect(parsePsArgs(text)).toEqual(new Map([[42, argv]]))
  })
}

const ENVS = [
  ['the id after the args', '  7 node run.js PATH=/bin LIVE_TESTS_AGENT_ID=a-1_b HOME=/h', 'a-1_b'],
  ['the last one wins: the environment comes after the args', '  7 echo LIVE_TESTS_AGENT_ID=x LIVE_TESTS_AGENT_ID=y', 'y'],
  ['absent', '  7 node run.js PATH=/bin', undefined],
  ['not a plain id', '  7 node LIVE_TESTS_AGENT_ID=a/b', undefined],
] as const

for (const [name, text, agent] of ENVS) {
  test(`parsePsEnvAgents: ${name}`, () => {
    expect(parsePsEnvAgents(text)).toEqual(new Map([[7, agent]]))
  })
}

test('parsePsRss: kB to bytes, per pid', () => {
  expect(parsePsRss('  1   5584\n 22 4\n')).toEqual(new Map([[1, 5584 * 1024], [22, 4096]]))
})

test('parseBoottime: seconds and microseconds to ms', () => {
  expect(parseBoottime('{ sec = 1787924349, usec = 682773 } Fri Aug 28 15:39:09 2026')).toBe(1_787_924_349_682.773)
})

const MACHINES = [
  [
    'load, and available memory as the free percentage of the total',
    '{ 4.71 4.39 4.51 }\n17179869184\n41\n',
    { mem: { availableKb: Math.round(16 * 1024 * 1024 * 0.41), totalKb: 16 * 1024 * 1024 }, loadavg: { load1: 4.71, load5: 4.39 } },
  ],
  ['nothing readable', '', { mem: undefined, loadavg: undefined }],
] as const

for (const [name, text, expected] of MACHINES) {
  test(`parseSysctlMachine: ${name}`, () => {
    expect(parseSysctlMachine(text)).toEqual(expected)
  })
}
