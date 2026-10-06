import { expect, test } from 'claude-code/testing'

import { alertStep, footerColumn, formatBytes, statusLine, thresholdsFrom, usageTable } from '../hooks/view'
import type { TableRow } from '../hooks/view'

const MB = 1024 * 1024
const GB = 1024 * MB
const LIMITS = { memBytes: 2 * GB, cpuPercent: 150 }

const usage = (key: string, pss: number, cpu: number) => ({ key, pss, rss: pss, cpu, procs: [] })

const BYTES = [
  [0, '0M'],
  [300 * 1024, '0.3M'],
  [512 * MB, '512M'],
  [1023.6 * MB, '1.0G'],
  [3.14 * GB, '3.1G'],
  [12.5 * GB, '13G'],
] as const

for (const [bytes, text] of BYTES) {
  test(`formatBytes ${bytes}`, () => {
    expect(formatBytes(bytes)).toBe(text)
  })
}

const STEPS = [
  ['under both: nothing', [], [usage('a1', GB, 50)], [], []],
  ['memory over: enters once', [], [usage('a1', 3 * GB, 10)], ['a1'], ['a1']],
  ['CPU over: enters', [], [usage('a1', GB, 240)], ['a1'], ['a1']],
  ['still over: not entered again', ['a1'], [usage('a1', 3 * GB, 10)], ['a1'], []],
  ['just under the line: stays (no flapping)', ['a1'], [usage('a1', 1.9 * GB, 140)], ['a1'], []],
  ['well under: leaves', ['a1'], [usage('a1', GB, 100)], [], []],
  ['gone: leaves', ['a1'], [], [], []],
  ['a second one enters beside the first', ['a1'], [usage('a1', 3 * GB, 0), usage('a2', 0, 400)], ['a1', 'a2'], ['a2']],
] as const

for (const [name, alerting, usages, expected, entered] of STEPS) {
  test(`alertStep: ${name}`, () => {
    expect(alertStep(alerting, usages, LIMITS)).toEqual({ alerting: expected, entered })
  })
}

test('alertStep: one that left and comes back over enters again', () => {
  const left = alertStep(['a1'], [usage('a1', 0, 0)], LIMITS)
  expect(alertStep(left.alerting, [usage('a1', 3 * GB, 0)], LIMITS).entered).toEqual(['a1'])
})

const names: Record<string, string> = { a1: 'integration-12', a2: 'docs' }
const nameOf = (key: string) => names[key] ?? key

test('statusLine names each agent over a threshold', () => {
  const usages = [usage('a1', 3.1 * GB, 240), usage('a2', 400 * MB, 160), usage('a3', 0, 0)]
  expect(statusLine(['a1', 'a2'], usages, nameOf)).toBe('⚠ integration-12 3.1G 240%cpu · docs 400M 160%cpu')
})

test('statusLine is undefined (cleared) when nothing is over', () => {
  expect(statusLine([], [usage('a1', GB, 10)], nameOf)).toBeUndefined()
})

const OPTIONS = [
  ['the defaults', {}, { memBytes: 2 * GB, cpuPercent: 150, intervalMs: 5000, footer: 'always', floorMb: 0, marginMb: 1024, snapshotPath: '', footerMin: { pss: 500 * MB, cpu: 30 }, reapOnStop: false }],
  ['set values', { memoryThresholdGB: 0.5, cpuThresholdPercent: 90, intervalSeconds: 2, memoryFloorMB: 4096, pressureMarginMB: 512, snapshotPath: '/tmp/u.json', footerMinMemoryMB: 0, footerMinCpuPercent: 5, reapOnStop: true }, { memBytes: 0.5 * GB, cpuPercent: 90, intervalMs: 2000, footer: 'always', floorMb: 4096, marginMb: 512, snapshotPath: '/tmp/u.json', footerMin: { pss: 0, cpu: 5 }, reapOnStop: true }],
  ['nonsense falls back', { memoryThresholdGB: -1, cpuThresholdPercent: 'x', intervalSeconds: 0, memoryFloorMB: -5, pressureMarginMB: 'big', snapshotPath: 3, footerMinMemoryMB: -1, footerMinCpuPercent: 'x', reapOnStop: 'yes' }, { memBytes: 2 * GB, cpuPercent: 150, intervalMs: 5000, footer: 'always', floorMb: 0, marginMb: 1024, snapshotPath: '', footerMin: { pss: 500 * MB, cpu: 30 }, reapOnStop: false }],
] as const

for (const [name, options, expected] of OPTIONS) {
  test(`thresholdsFrom: ${name}`, () => {
    expect(thresholdsFrom(options)).toEqual(expected)
  })
}

const row = (name: string, kind: TableRow['kind'], pss: number, cpu: number, procs: TableRow['procs'] = []): TableRow => ({
  name,
  kind,
  now: { pss, cpu },
  peak: { pss: pss * 2, cpu: cpu * 2 },
  max: { pss: pss * 3, cpu: cpu * 3 },
  procs,
})

test('usageTable: agents biggest first, shared rows last, top processes under each', () => {
  const procs = [
    { pid: 11, command: 'npm test\n  --watch', pss: 3 * GB, cpu: 200 },
    { pid: 12, command: 'node worker.js', pss: 100 * MB, cpu: 40 },
    { pid: 13, command: 'sh', pss: MB, cpu: 0 },
    { pid: 14, command: 'cat', pss: 0, cpu: 0 },
  ]
  const text = usageTable([row('claude (all loops)', 'shared', 800 * MB, 12), row('docs', 'agent', 10 * MB, 0), row('integration-12', 'agent', 3.1 * GB, 240, procs)])
  expect(text).toBe(
    [
      'agent               mem   1m peak  max   cpu   1m peak  max',
      'integration-12      3.1G  6.2G     9.3G  240%  480%     720%',
      '    pid 11  3.0G  200%  npm test --watch',
      '    pid 12  100M  40%   node worker.js',
      '    pid 13  1.0M  0%    sh',
      'docs                10M   20M      30M   0%    0%       0%',
      'claude (all loops)  800M  1.6G     2.3G  12%   24%      36%',
    ].join('\n'),
  )
})

test('usageTable cuts a long command', () => {
  const long = { pid: 1, command: 'x'.repeat(200), pss: 0, cpu: 0 }
  const line = usageTable([row('a', 'agent', 0, 0, [long])]).split('\n')[2] ?? ''
  expect(line).toBe(`    pid 1  0M  0%  ${'x'.repeat(79)}…`)
})

const FOOTER_NAMES: Record<string, string> = { a1: 'integration-12', a2: '日本語' }
/** No floor: every row with anything at all is shown, for the layout tests. */
const ALL = { pss: 0, cpu: 0 }
/** The default floor: over 500M or over 30% CPU. */
const MIN = { pss: 500 * MB, cpu: 30 }

test('footerColumn: agents biggest first, then claude; padded columns', () => {
  const usages = [usage('claude', 549 * MB, 5), usage('main', 0.6 * MB, 0), usage('a1', 1.2 * GB, 45)]
  expect(footerColumn(usages, [], FOOTER_NAMES, ALL)).toEqual([
    { key: 'a1', text: 'integration-12  1.2G  45%', isOver: false },
    { key: 'main', text: 'main            0.6M   0%', isOver: false },
    { key: 'claude', text: 'claude          549M   5%', isOver: false },
  ])
})

const FLOOR = [
  ['an agent under both: hidden', [usage('a1', 500 * MB, 30), usage('a2', 600 * MB, 0)], MIN, ['日本語  600M  0%']],
  ['an agent over the memory floor: shown', [usage('a1', 501 * MB, 0)], MIN, ['integration-12  501M  0%']],
  ['an agent over the CPU floor: shown', [usage('a1', MB, 31)], MIN, ['integration-12  1.0M  31%']],
  ['claude under both: hidden', [usage('claude', 400 * MB, 5), usage('main', 600 * MB, 0)], MIN, ['main  600M  0%']],
  ['claude over one: shown', [usage('claude', 549 * MB, 5)], MIN, ['claude  549M  5%']],
  ['untracked under both: hidden', [usage('other', 300 * MB, 20), usage('main', 600 * MB, 0)], MIN, ['main  600M  0%']],
  ['untracked over one: shown', [usage('other', MB, 40)], MIN, ['untracked  1.0M  40%']],
  ['nothing over: no lines at all', [usage('main', MB, 1), usage('claude', 400 * MB, 5), usage('other', 50 * MB, 2)], MIN, []],
  ['configured floors', [usage('a1', 150 * MB, 0), usage('a2', 50 * MB, 6), usage('main', 50 * MB, 4)], { pss: 100 * MB, cpu: 5 }, ['integration-12  150M  0%', '日本語           50M  6%']],
] as const

for (const [name, usages, min, expected] of FLOOR) {
  test(`footerColumn floor: ${name}`, () => {
    expect(footerColumn(usages, [], FOOTER_NAMES, min).map(line => line.text)).toEqual(expected)
  })
}

test('footerColumn floor: a row over a warning threshold keeps its ⚠ and shows, whatever the floor', () => {
  const lines = footerColumn([usage('a1', 3.1 * GB, 240), usage('main', MB, 0)], ['a1'], FOOTER_NAMES, { pss: 8 * GB, cpu: 400 })
  expect(lines).toEqual([{ key: 'a1', text: '⚠ integration-12  3.1G  240%', isOver: true }])
})

test('footerColumn: rows over a threshold get a ⚠ column, the rest a space', () => {
  const lines = footerColumn([usage('a1', 3.1 * GB, 240), usage('main', MB, 0)], ['a1'], FOOTER_NAMES, ALL)
  expect(lines).toEqual([
    { key: 'a1', text: '⚠ integration-12  3.1G  240%', isOver: true },
    { key: 'main', text: '  main            1.0M    0%', isOver: false },
  ])
})

test('footerColumn: wide characters count two cells when padding', () => {
  const lines = footerColumn([usage('a2', 2 * MB, 1), usage('main', MB, 0)], [], FOOTER_NAMES, ALL)
  expect(lines.map(line => line.text)).toEqual(['日本語  2.0M  1%', 'main    1.0M  0%'])
})

test('footerColumn: an unnamed agent shows a short id', () => {
  expect(footerColumn([usage('a9f3c2e1d0b4', MB, 0)], [], {}, ALL).map(line => line.text)).toEqual(['a9f3c2e1  1.0M  0%'])
})

const FOOTERS = [
  ['default', {}, 'always'],
  ['alerts', { footer: 'alerts' }, 'alerts'],
  ['off', { footer: 'off' }, 'off'],
  ['nonsense', { footer: 'sideways' }, 'always'],
] as const

for (const [name, options, expected] of FOOTERS) {
  test(`thresholdsFrom footer: ${name}`, () => {
    expect(thresholdsFrom(options).footer).toBe(expected)
  })
}
