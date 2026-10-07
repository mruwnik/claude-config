import { expect, test } from 'claude-code/testing'

import type { RunRecord } from '../types'
import { backoffMs, isContended, isShownChange, skipContended, withPolls } from '../hooks/contention'

const EXHAUSTED = 'update: the value was written by another every time it was read, up to the bound on tries; nothing was written'

const run = (id: string, fields: Partial<RunRecord> = {}): RunRecord => ({
  id,
  root: '/proj',
  suite: 'unit',
  labels: ['unit'],
  logs: ['/l'],
  events: ['/e'],
  isFullRun: true,
  startedAt: 0,
  agentId: null,
  agentName: null,
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
  ...fields,
})

const CONTENDED: readonly (readonly [string, unknown, boolean])[] = [
  ['the exhausted update', new Error(EXHAUSTED), true],
  ['another error', new Error('ENOENT /x'), false],
  ['a thrown string of the same text', EXHAUSTED, false],
]

for (const [name, error, expected] of CONTENDED) {
  test(`isContended: ${name}`, () => {
    expect(isContended(error)).toBe(expected)
  })
}

const BACKOFFS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0, 0.999, 24],
  [3, 0.5, 100],
  [6, 0.999, 1_598],
  [20, 0.999, 1_998],
  [20, 0.5, 1_000],
]

for (const [attempt, random, expected] of BACKOFFS) {
  test(`backoffMs: attempt ${attempt} at random ${random} waits ${expected}ms`, () => {
    expect(backoffMs(attempt, random)).toBe(expected)
  })
}

test('withPolls applies each poll to its run and leaves the rest as they stand', () => {
  const list = [run('a'), run('b'), run('c')]
  const polls = new Map([['b', (r: RunRecord) => ({ ...r, planned: 9 })]])
  expect(withPolls(list, polls).map(r => r.planned)).toEqual([0, 9, 0])
  expect(withPolls(list, polls)[0]).toBe(list[0])
})

test('withPolls skips a poll whose run left the list meanwhile', () => {
  const polls = new Map([['gone', (r: RunRecord) => ({ ...r, planned: 9 })]])
  expect(withPolls([run('a')], polls)).toEqual([run('a')])
})

const SHOWN: readonly (readonly [string, Partial<RunRecord>, Partial<RunRecord>, boolean])[] = [
  ['nothing new', {}, {}, false],
  ['the clock inside the second it shows', { now: 1_000 }, { now: 1_400 }, false],
  ['the clock into the next second', { now: 1_400 }, { now: 1_600 }, true],
  ['a count', {}, { counts: { passed: 1, failed: 0, error: 0, skipped: 0 } }, true],
  ['a pid check', {}, { pidCheckedAt: 5_000 }, true],
]

for (const [name, before, after, expected] of SHOWN) {
  test(`isShownChange: ${name}`, () => {
    expect(isShownChange([run('a', before)], [run('a', after)])).toBe(expected)
  })
}

test('skipContended answers undefined for an exhausted update', async () => {
  expect(await skipContended(Promise.reject(new Error(EXHAUSTED)))).toBeUndefined()
})

test('skipContended lets any other failure through', async () => {
  await expect(skipContended(Promise.reject(new Error('ENOENT /x')))).rejects.toThrow('ENOENT /x')
})
