import { expect, test } from 'claude-code/testing'

import type { RunRecord } from '../types'
import { clashReply, findClash, prunable, runStem } from '../hooks/clash'
import type { Concurrency } from '../hooks/clash'

const run = (fields: Partial<RunRecord>): RunRecord => ({
  id: 'r',
  root: '/p',
  suite: 'engine',
  labels: ['engine'],
  logs: ['/p/.claude/live-tests/engine-0-abc123-1.log'],
  events: ['/p/.claude/live-tests/engine-0-abc123-1.events'],
  isFullRun: false,
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
  now: 0,
  agentId: null,
  agentName: null,
  args: ['-k', 'breathe'],
  ...fields,
})

const WANT = { root: '/p', suite: 'engine', args: ['-k', 'breathe'] }

const CLASHES: readonly (readonly [string, Concurrency, RunRecord, readonly string[], string | undefined])[] = [
  ['args: the same args clash', 'args', run({ id: 'a' }), [], 'a'],
  ['args: other args run alongside', 'args', run({ id: 'a', args: ['-k', 'walk'] }), [], undefined],
  ['args: no args and some args run alongside', 'args', run({ id: 'a', args: [] }), [], undefined],
  ['args: a finished run does not clash', 'args', run({ id: 'a', outcome: 'failed' }), [], undefined],
  ['args: another folder does not clash', 'args', run({ id: 'a', root: '/wt' }), [], undefined],
  ['args: another suite does not clash', 'args', run({ id: 'a', suite: 'world' }), [], undefined],
  ['args: a run whose process is gone does not clash', 'args', run({ id: 'a' }), ['a'], undefined],
  ['exclusive: any running run of the suite clashes', 'exclusive', run({ id: 'a', args: ['-k', 'walk'] }), [], 'a'],
  ['any: even the same args run alongside', 'any', run({ id: 'a' }), [], undefined],
]

for (const [name, concurrency, held, dead, clash] of CLASHES) {
  test(`findClash ${name}`, () => {
    expect(findClash([held], WANT, concurrency, dead)?.id).toBe(clash)
  })
}

const HOLDER = run({
  agentId: 'f2',
  agentName: 'fixer-2',
  taskId: 'bg4',
  planned: 34,
  counts: { passed: 2, failed: 1, error: 0, skipped: 0 },
})

const LOOSEN =
  'To let such runs overlap, set the suite\'s "concurrency" in .claude/tests.json: "args" (the default) refuses only a run with the same args, "any" never refuses.'

const REPLIES: readonly (readonly [string, RunRecord, string | null, string])[] = [
  [
    'another agent’s background run',
    HOLDER,
    null,
    'Suite engine with args ["-k","breathe"] is already running for [fixer-2] (background task bg4, started 3m 10s ago; results so far: 2 passed, 1 failed; log /p/.claude/live-tests/engine-0-abc123-1.log). ' +
      "It belongs to [fixer-2], so don't stop it: wait for its summary or ask that agent. Don't run it through Bash instead: the person loses the live view. " +
      LOOSEN,
  ],
  [
    'the main conversation’s foreground run',
    run({ args: [] }),
    'f2',
    'Suite engine is already running for the main conversation (in the foreground, started 3m 10s ago; results so far: no tests; log /p/.claude/live-tests/engine-0-abc123-1.log). ' +
      "It belongs to the main conversation, so don't stop it: wait for its summary or ask that agent. Don't run it through Bash instead: the person loses the live view. " +
      LOOSEN,
  ],
  [
    'the caller’s own run',
    HOLDER,
    'f2',
    'Suite engine with args ["-k","breathe"] is already running for you (background task bg4, started 3m 10s ago; results so far: 2 passed, 1 failed; log /p/.claude/live-tests/engine-0-abc123-1.log). ' +
      "It is your own run: wait for its summary. Don't run it through Bash instead: the person loses the live view. " +
      LOOSEN,
  ],
]

for (const [name, holder, callerAgentId, reply] of REPLIES) {
  test(`clashReply: ${name}`, () => {
    expect(clashReply({ holder, callerAgentId, now: 190_000 })).toBe(reply)
  })
}

test('clashReply calls a subagent with no listed name a subagent', () => {
  expect(clashReply({ holder: run({ agentId: 'x' }), callerAgentId: null, now: 0 })).toMatch(/^Suite engine with args \["-k","breathe"\] is already running for a subagent \(/)
})

const STEMS = [
  ['engine', 1_700_000_000_000, 'toolu_01AbCdEf', 'engine-1700000000000-1AbCdEf'],
  ['e2e', 5, 'x-y', 'e2e-5-xy'],
] as const

for (const [suite, startedAt, id, stem] of STEMS) {
  test(`runStem ${stem}`, () => {
    expect(runStem(suite, startedAt, id)).toBe(stem)
  })
}

test('prunable keeps the newest runs of the suite and any still running, and leaves other files alone', () => {
  const stems = Array.from({ length: 12 }, (_, i) => `engine-${100 + i}-a${i}`)
  const names = [
    ...stems.flatMap(stem => [`${stem}-1.log`, `${stem}-1.events`, `${stem}-2.log`]),
    'engine-1.log',
    'engine-full-100-zz-1.log',
    '.gitignore',
  ]
  expect(prunable(names, 'engine', ['engine-100-a0'], 10)).toEqual(['engine-101-a1-1.log', 'engine-101-a1-1.events', 'engine-101-a1-2.log'])
})
