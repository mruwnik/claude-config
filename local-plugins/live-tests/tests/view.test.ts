import { expect, test } from 'claude-code/testing'

import type { RunRecord } from '../types'
import { formatDuration } from '../hooks/duration'
import { cellWidth, finishedLimitFrom, footerLines, footerRuns, footerText, parseView, displayOrder, runLabel, splitTrailing, startReply, withNewRun } from '../hooks/view'

const VIEWS = [
  ['footer', 'footer'],
  [' band ', 'band'],
  ['band-right', 'band-right'],
  ['PANE', 'pane'],
  ['', undefined],
  ['sideways', undefined],
] as const

for (const [args, view] of VIEWS) {
  test(`parseView ${JSON.stringify(args)}`, () => {
    expect(parseView(args)).toBe(view)
  })
}

const DURATIONS = [
  [0, '0s'],
  [7_400, '7s'],
  [65_000, '1m 05s'],
  [3_725_000, '1h 02m 05s'],
  [3_600_000, '1h 00m 00s'],
] as const

for (const [ms, text] of DURATIONS) {
  test(`formatDuration ${ms}`, () => {
    expect(formatDuration(ms)).toBe(text)
  })
}

const run = (fields: Partial<RunRecord>): RunRecord => ({
  id: 'r',
  root: '/p',
  suite: 'unit',
  labels: ['unit'],
  logs: [],
  events: [],
  isFullRun: true,
  startedAt: 0,
  taskId: null,
  summary: null,
  baseline: null,
  outcome: 'running',
  stepIndex: 0,
  planned: 0,
  counts: { passed: 0, failed: 0, error: 0, skipped: 0 },
  progress: null,
  recentFailures: [],
  now: 12_000,
  agentId: null,
  agentName: null,
  ...fields,
})

const FOOTERS = [
  [run({}), '▶ unit starting… 12s'],
  [run({ planned: 380, counts: { passed: 139, failed: 2, error: 1, skipped: 0 } }), '▶ unit 142/380 37%  3 ✗ 12s'],
  [run({ taskId: 'b1', counts: { passed: 5, failed: 0, error: 0, skipped: 0 }, progress: { done: 1, total: 4, unit: 'files' } }), '▶ unit (bg) 5 tests 1/4 files 12s'],
  [run({ labels: ['build', 'cljs', 'js'], stepIndex: 1 }), '▶ unit 2/3 cljs starting… 12s'],
  [run({ outcome: 'passed', counts: { passed: 69, failed: 0, error: 0, skipped: 0 } }), '✓ unit 69 ✓ 12s'],
  [run({ outcome: 'failed', counts: { passed: 22, failed: 2, error: 1, skipped: 1 } }), '✗ unit 22 ✓  3 ✗  1 ⊘ 12s'],
] as const

for (const [record, text] of FOOTERS) {
  test(`footerText ${text}`, () => {
    expect(footerText(record)).toBe(text)
  })
}

test('footerLines gives each run its own line, labelled by the agent that started it', () => {
  const runs = [
    run({ id: 'a', suite: 'demo-slow' }),
    run({ id: 'b', suite: 'demo-slow', agentId: 'a1', agentName: 'worker-1', taskId: 'b2' }),
    run({ id: 'c', suite: 'demo-slow', agentId: 'a2', agentName: 'worker-2', outcome: 'failed' }),
    run({ id: 'd', suite: 'demo-slow', agentId: 'a3' }),
  ]
  expect(footerLines(runs).map(({ id, text }) => ({ id, text }))).toEqual([
    { id: 'a', text: '▶ demo-slow                  starting…  12s' },
    { id: 'b', text: '▶ demo-slow [worker-1] (bg)  starting…  12s' },
    { id: 'c', text: '✗ demo-slow [worker-2]       no tests   12s' },
    { id: 'd', text: '▶ demo-slow [subagent]       starting…  12s' },
  ])
})

test('footerLines aligns a block of runs into name, status and duration columns', () => {
  const runs = [
    run({ id: 'a', suite: 'golden', agentId: 'f', agentName: 'fixer-cec4ec9b', outcome: 'passed', counts: { passed: 35, failed: 0, error: 0, skipped: 0 }, now: 23_000 }),
    run({ id: 'b', suite: 'engine-full', agentId: 'i', agentName: 'integration-12', taskId: 'b1', planned: 869, counts: { passed: 535, failed: 0, error: 0, skipped: 0 }, now: 195_000 }),
    run({ id: 'c', suite: 'compile-check', agentId: 'i', agentName: 'integration-12', outcome: 'passed', now: 5_000 }),
  ]
  expect(footerLines(runs).map(line => line.text)).toEqual([
    '✓ golden [fixer-cec4ec9b]            35 ✓            23s',
    '▶ engine-full [integration-12] (bg)  535/869 61%  3m 15s',
    '✓ compile-check [integration-12]     no tests         5s',
  ])
})

test('footerLines pads by terminal width, so a wide agent name counts its cells', () => {
  const runs = [run({ id: 'a', agentId: 'x', agentName: '漢字' }), run({ id: 'b', agentId: 'y', agentName: 'abcd' })]
  expect(footerLines(runs).map(line => line.text)).toEqual(['▶ unit [漢字]  starting…  12s', '▶ unit [abcd]  starting…  12s'])
})

for (const [record, text] of FOOTERS) {
  test(`footerLines leaves a lone run as its footerText: ${text}`, () => {
    expect(footerLines([record]).map(({ id, text }) => ({ id, text }))).toEqual([{ id: 'r', text }])
  })
}

const WIDTHS = [
  ['abc', 3],
  ['✓ ▶ ✗ ⏵', 7],
  ['⊘', 1],
  ['漢字', 4],
  ['🚀', 2],
  ['e\u0301', 1],
  ['', 0],
] as const

for (const [text, width] of WIDTHS) {
  test(`cellWidth ${JSON.stringify(text)}`, () => {
    expect(cellWidth(text)).toBe(width)
  })
}

test('displayOrder puts running runs first, then sorts by suite and agent, main conversation first', () => {
  const runs = [
    run({ id: 'p-unit-w2', outcome: 'passed', agentId: 'a2', agentName: 'worker-2' }),
    run({ id: 'f-alpha', suite: 'alpha', outcome: 'failed' }),
    run({ id: 'r-zeta', suite: 'zeta' }),
    run({ id: 'p-unit-main', outcome: 'passed' }),
    run({ id: 'r-beta-w1', suite: 'beta', agentId: 'a1', agentName: 'worker-1' }),
    run({ id: 'p-unit-w1', outcome: 'passed', agentId: 'a1', agentName: 'worker-1' }),
    run({ id: 'r-beta-main', suite: 'beta' }),
  ]
  expect(displayOrder(runs).map(r => r.id)).toEqual(['r-beta-main', 'r-beta-w1', 'r-zeta', 'f-alpha', 'p-unit-main', 'p-unit-w1', 'p-unit-w2'])
})

test('displayOrder leaves the stored list as it was', () => {
  const runs = [run({ id: 'b', suite: 'b' }), run({ id: 'a', suite: 'a' })]
  displayOrder(runs)
  expect(runs.map(r => r.id)).toEqual(['b', 'a'])
})

const MIXED = [
  run({ id: 'p-old', outcome: 'passed', now: 1_000 }),
  run({ id: 'r-a', suite: 'a', now: 500 }),
  run({ id: 'f-new', outcome: 'failed', now: 9_000 }),
  run({ id: 'p-mid', suite: 'alpha', outcome: 'passed', now: 5_000 }),
  run({ id: 'r-b', suite: 'b', now: 100 }),
  run({ id: 'f-older', outcome: 'failed', now: 3_000 }),
]

const FOOTER_RUNS = [
  [0, ['r-a', 'r-b']],
  [1, ['r-a', 'f-new', 'r-b']],
  [3, ['r-a', 'f-new', 'p-mid', 'r-b', 'f-older']],
  [10, ['p-old', 'r-a', 'f-new', 'p-mid', 'r-b', 'f-older']],
] as const

for (const [limit, ids] of FOOTER_RUNS) {
  test(`footerRuns keeps every running run and the ${limit} latest finished, in stored order`, () => {
    expect(footerRuns(MIXED, limit).map(r => r.id)).toEqual(ids)
  })
}

test('footerRuns falls back to the start time of a finished run with no end time', () => {
  const runs = [
    run({ id: 'ended', outcome: 'passed', startedAt: 0, now: 4_000 }),
    { ...run({ id: 'no-end', outcome: 'passed', startedAt: 6_000 }), now: undefined } as unknown as RunRecord,
    run({ id: 'early', outcome: 'failed', startedAt: 0, now: 2_000 }),
  ]
  expect(footerRuns(runs, 2).map(r => r.id)).toEqual(['ended', 'no-end'])
})

test('footerRuns leaves the stored list as it was', () => {
  footerRuns(MIXED, 1)
  expect(MIXED.map(r => r.id)).toEqual(['p-old', 'r-a', 'f-new', 'p-mid', 'r-b', 'f-older'])
})

test('displayOrder still orders what footerRuns keeps', () => {
  expect(displayOrder(footerRuns(MIXED, 3)).map(r => r.id)).toEqual(['r-a', 'r-b', 'p-mid', 'f-new', 'f-older'])
})

const LIMITS = [
  [{}, 3],
  [{ footerFinishedRuns: 5 }, 5],
  [{ footerFinishedRuns: 0 }, 0],
  [{ footerFinishedRuns: 2.7 }, 2],
  [{ footerFinishedRuns: -1 }, 3],
  [{ footerFinishedRuns: '4' }, 3],
] as const

for (const [options, limit] of LIMITS) {
  test(`finishedLimitFrom ${JSON.stringify(options)}`, () => {
    expect(finishedLimitFrom(options)).toBe(limit)
  })
}

const LABELS = [
  [run({}), 'unit'],
  [run({ agentId: 'a1', agentName: 'worker-2' }), 'unit [worker-2]'],
  [run({ agentId: 'a1' }), 'unit [subagent]'],
  [run({ agentId: 'a1', agentName: 'fixer-2', args: ['-k', 'breathe-test'] }), 'unit [fixer-2] -k breathe-test'],
  [run({ args: ['tests/very/long/path/test_x.py::test_y'] }), 'unit tests/very/long/path/te…'],
] as const

for (const [record, label] of LABELS) {
  test(`runLabel ${label}`, () => {
    expect(runLabel(record)).toBe(label)
  })
}

test('footerText names the subagent of a lone run', () => {
  expect(footerText(run({ agentId: 'a1', agentName: 'w1' }))).toBe('▶ unit [w1] starting… 12s')
})

const REPLIES = [
  [{ suite: 'unit', taskId: 'b1', isAsked: true, isSubagent: false, logPath: '/l.log' }, 'Suite unit started as background task b1. Its summary will be attached to the completion notification; stop it with TaskStop if needed. Progress is in /l.log, not the task output.'],
  [{ suite: 'unit', taskId: 'b1', isAsked: true, isSubagent: true, logPath: '/l.log' }, 'Suite unit started as background task b1. Its summary will be sent to you as a message when the run ends; stop it with TaskStop if needed. Progress is in /l.log, not the task output.'],
  [{ suite: 'unit', taskId: 'b1', isAsked: false, isSubagent: true, logPath: '/l.log' }, 'Suite unit took longer than the Bash timeout and was moved to the background as task b1; it keeps running. Its summary will be sent to you as a message when the run ends; stop it with TaskStop if needed. Progress is in /l.log, not the task output.'],
] as const

for (const [fields, reply] of REPLIES) {
  test(`startReply ${JSON.stringify(fields)}`, () => {
    expect(startReply(fields)).toBe(reply)
  })
}

test('withNewRun replaces only the same agent’s finished run of the same suite and folder', () => {
  const list = [
    run({ id: 'mine-old', agentId: 'a1', outcome: 'failed' }),
    run({ id: 'other-agent', agentId: 'a2', outcome: 'failed' }),
    run({ id: 'main', agentId: null, outcome: 'passed' }),
    run({ id: 'other-suite', agentId: 'a1', suite: 'e2e', outcome: 'passed' }),
    run({ id: 'other-root', agentId: 'a1', root: '/wt', outcome: 'passed' }),
    run({ id: 'still-running', agentId: 'a1', root: '/wt', suite: 'e2e' }),
  ]
  const ids = withNewRun(list, run({ id: 'new', agentId: 'a1' })).map(r => r.id)
  expect(ids).toEqual(['other-agent', 'main', 'other-suite', 'other-root', 'still-running', 'new'])
})

test('withNewRun keys a rerun on its args too, so one agent may keep runs of the suite with other args', () => {
  const list = [run({ id: 'walk', agentId: 'a1', outcome: 'failed', args: ['-k', 'walk'] }), run({ id: 'breathe', agentId: 'a1', outcome: 'failed', args: ['-k', 'breathe'] })]
  expect(withNewRun(list, run({ id: 'new', agentId: 'a1', args: ['-k', 'breathe'] })).map(r => r.id)).toEqual(['walk', 'new'])
})

test('withNewRun from main replaces main’s finished run, not a subagent’s', () => {
  const list = [run({ id: 'main-old', outcome: 'failed' }), run({ id: 'sub', agentId: 'a1', outcome: 'failed' })]
  expect(withNewRun(list, run({ id: 'new' })).map(r => r.id)).toEqual(['sub', 'new'])
})

const joined = (segments: readonly { text: string }[]) => segments.map(s => s.text).join('')

const SEGMENTS = [
  ['a running line: only the failure count is red', run({ planned: 380, counts: { passed: 139, failed: 2, error: 1, skipped: 0 } }), [
    { text: '▶ unit 142/380 37%  ' },
    { text: '3 ✗', tone: 'error' },
    { text: ' 12s' },
  ]],
  ['a running line with no failures: all plain', run({}), [{ text: '▶ unit starting… 12s' }]],
  ['a passed line: the ✓ mark and the passed count are green', run({ outcome: 'passed', counts: { passed: 69, failed: 0, error: 0, skipped: 0 } }), [
    { text: '✓', tone: 'success' },
    { text: ' unit ' },
    { text: '69 ✓', tone: 'success' },
    { text: ' 12s' },
  ]],
  ['a failed line: errors count in with ✗, red; passed green; skipped dim', run({ outcome: 'failed', counts: { passed: 22, failed: 2, error: 1, skipped: 1 } }), [
    { text: '✗', tone: 'error' },
    { text: ' unit ' },
    { text: '22 ✓', tone: 'success' },
    { text: '  ' },
    { text: '3 ✗', tone: 'error' },
    { text: '  1 ⊘ 12s' },
  ]],
  ['zero counts are left out', run({ outcome: 'failed', counts: { passed: 0, failed: 4, error: 0, skipped: 0 } }), [{ text: '✗', tone: 'error' }, { text: ' unit ' }, { text: '4 ✗', tone: 'error' }, { text: ' 12s' }]],
  ['a failed line with no tests: the ✗ alone is red', run({ outcome: 'failed' }), [{ text: '✗', tone: 'error' }, { text: ' unit no tests 12s' }]],
] as const

for (const [name, record, expected] of SEGMENTS) {
  test(`footerLines segments: ${name}`, () => {
    expect(footerLines([record])[0]?.segments).toEqual(expected)
  })
}

test('footerLines segments keep the padding of the aligned text, worked out on the plain text', () => {
  const runs = [
    run({ id: 'a', suite: 'golden', outcome: 'failed', counts: { passed: 1, failed: 1, error: 0, skipped: 0 } }),
    run({ id: 'b', suite: 'engine-full', agentId: 'i', agentName: '漢字', planned: 9, counts: { passed: 3, failed: 2, error: 0, skipped: 0 } }),
  ]
  const lines = footerLines(runs)
  expect(lines.map(line => joined(line.segments))).toEqual(lines.map(line => line.text))
  expect(lines.map(line => line.text)).toEqual(['✗ golden              1 ✓  1 ✗      12s', '▶ engine-full [漢字]  5/9 55%  2 ✗  12s'])
  expect(lines[0]?.segments).toEqual([
    { text: '✗', tone: 'error' },
    { text: ' golden              ' },
    { text: '1 ✓', tone: 'success' },
    { text: '  ' },
    { text: '1 ✗', tone: 'error' },
    { text: '      12s' },
  ])
  expect(lines[1]?.segments).toEqual([{ text: '▶ engine-full [漢字]  5/9 55%  ' }, { text: '2 ✗', tone: 'error' }, { text: '  12s' }])
})

const text = (t: string) => ({ type: 'Text' as const, children: [t] })
const trailing = (name: string) => ({ type: 'Box' as const, props: { key: `trailing:${name}` }, children: [text(name)] })

const SPLITS = [
  ['a plain tree: kept whole', text('focus'), { kept: text('focus'), trailing: [] }],
  ['a row with a trailing column: the column comes out', { type: 'Box' as const, props: { flexDirection: 'row' }, children: [text('focus'), trailing('agent-usage')] }, {
    kept: { type: 'Box', props: { flexDirection: 'row' }, children: [text('focus')] },
    trailing: [trailing('agent-usage')],
  }],
  ['a trailing tree on its own', trailing('x'), { kept: undefined, trailing: [trailing('x')] }],
  ['a keyed Box that is not trailing stays', { type: 'Box' as const, props: { key: 'mine' }, children: [text('a')] }, { kept: { type: 'Box', props: { key: 'mine' }, children: [text('a')] }, trailing: [] }],
] as const

for (const [name, tree, expected] of SPLITS) {
  test(`splitTrailing: ${name}`, () => {
    expect(splitTrailing(tree)).toEqual(expected)
  })
}
