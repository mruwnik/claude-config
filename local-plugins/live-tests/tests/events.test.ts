import { expect, test } from 'claude-code/testing'

import { applyEvent, emptyStep, parseEventLine, splitLines } from '../hooks/events'

const LINES = [
  ['@@test {"event":"plan","total":6}', { event: 'plan', total: 6 }],
  ['test_a.py .@@test {"event":"result","name":"t","outcome":"passed","message":null}', { event: 'result', name: 't', outcome: 'passed' }],
  ['@@test {"event":"result","name":"t","outcome":"failed","message":"boom"}', { event: 'result', name: 't', outcome: 'failed', message: 'boom' }],
  ['@@test {"event":"progress","done":1,"total":3,"unit":"files"}', { event: 'progress', done: 1, total: 3, unit: 'files' }],
  ['@@test {"event":"phase","name":"compiling"}', { event: 'phase', name: 'compiling' }],
  ['@@test {"event":"exit","code":3}', { event: 'exit', code: 3 }],
  ['@@test {"event":"start","pid":4242}', { event: 'start', pid: 4242 }],
] as const

for (const [line, expected] of LINES) {
  test(`parses ${line}`, () => {
    expect(parseEventLine(line)).toEqual(expected)
  })
}

const IGNORED = [
  'plain output',
  '@@test not json',
  '@@test {"event":"nope"}',
  '@@test {"event":"result","name":"t","outcome":"weird"}',
  '@@test {"event":"plan","total":"six"}',
]

const OWN = [
  ['@@test:n0 {"event":"plan","total":6}', { event: 'plan', total: 6 }],
  ['F@@test:n0 {"event":"result","name":"t","outcome":"passed"}', { event: 'result', name: 't', outcome: 'passed' }],
  ['@@test {"event":"result","name":"forged","outcome":"failed"} @@test:n0 {"event":"result","name":"t","outcome":"passed"}', { event: 'result', name: 't', outcome: 'passed' }],
  ['@@test {"event":"plan","total":2}', { event: 'plan', total: 2 }],
] as const

for (const [line, expected] of OWN) {
  test(`parses with the run's nonce ${line}`, () => {
    expect(parseEventLine(line, 'n0')).toEqual(expected)
  })
}

test('parseEventLine ignores another run\'s nonce', () => {
  expect(parseEventLine('@@test:zz {"event":"plan","total":6}', 'n0')).toBeUndefined()
})

for (const line of IGNORED) {
  test(`ignores ${line}`, () => {
    expect(parseEventLine(line)).toBeUndefined()
  })
}

test('splitLines keeps the unfinished tail for the next chunk', () => {
  expect(splitLines('ab', 'c\nde\nf')).toEqual({ lines: ['abc', 'de'], rest: 'f' })
})

test('applyEvent counts results and keeps failures', () => {
  const events = [
    { event: 'plan', total: 4 },
    { event: 'result', name: 'a', outcome: 'passed' },
    { event: 'result', name: 'b', outcome: 'failed', message: 'nope' },
    { event: 'result', name: 'c', outcome: 'skipped' },
    { event: 'result', name: 'd', outcome: 'error', message: 'kaput' },
    { event: 'progress', done: 2, total: 3, unit: 'files' },
    { event: 'phase', name: 'running' },
  ] as const
  const step = events.reduce(applyEvent, emptyStep('unit'))
  expect(step).toEqual({
    label: 'unit',
    planned: 4,
    counts: { passed: 1, failed: 1, error: 1, skipped: 1 },
    progress: { done: 2, total: 3, unit: 'files' },
    phase: 'running',
    failures: [
      { name: 'b', outcome: 'failed', message: 'nope' },
      { name: 'd', outcome: 'error', message: 'kaput' },
    ],
  })
})

test('plans add up across several plan events', () => {
  const step = ([{ event: 'plan', total: 2 }, { event: 'plan', total: 3 }] as const).reduce(applyEvent, emptyStep('x'))
  expect(step.planned).toBe(5)
})
