import { expect, test } from 'claude-code/testing'

import { measure, peakOf, ticksOf, withMaxima, withPoints, withTurn } from '../hooks/usage'
import type { ProcRow } from '../hooks/usage'

const HZ = 100
const MB = 1024 * 1024

const row = (key: string, pid: number, pss: number, ticks: number, startedMs = 0, command = `cmd ${pid}`): ProcRow => ({
  key,
  pid,
  procKey: `${pid}:${startedMs}`,
  command,
  pss,
  rss: pss * 2,
  ticks,
  startedMs,
})

test('memory is the sum of PSS per agent; the first sample has no CPU yet', () => {
  const usages = measure([row('a1', 1, 100 * MB, 50), row('a1', 2, 20 * MB, 10), row('main', 3, 5 * MB, 1)], undefined, 10_000, HZ)
  expect(usages.map(u => [u.key, u.pss, u.rss, u.cpu])).toEqual([
    ['a1', 120 * MB, 240 * MB, 0],
    ['main', 5 * MB, 10 * MB, 0],
  ])
})

const CPU = [
  // ticks are 1/100 s: 500 ticks over 5 s is one full core
  ['one core', [row('a1', 1, 0, 1500)], { '1:0': 1000 }, 100],
  ['two processes add up', [row('a1', 1, 0, 1500), row('a1', 2, 0, 1250)], { '1:0': 1000, '2:0': 1000 }, 150],
  ['a process started since the last sample counts all its time', [row('a1', 1, 0, 250, 7_000)], {}, 50],
  ['a process older than the last sample but unseen counts nothing', [row('a1', 1, 0, 250, 1_000)], {}, 0],
] as const

for (const [name, rows, prevTicks, expected] of CPU) {
  test(`cpu: ${name}`, () => {
    const prev = { t: 5_000, ticks: new Map(Object.entries(prevTicks)) }
    expect(Math.round(measure(rows, prev, 10_000, HZ)[0]?.cpu ?? NaN)).toBe(expected)
  })
}

test("an agent's processes are listed biggest first, each with its own CPU", () => {
  const prev = { t: 5_000, ticks: new Map([['1:0', 0], ['2:0', 0]]) }
  const [usage] = measure([row('a1', 1, 10 * MB, 100), row('a1', 2, 90 * MB, 500)], prev, 10_000, HZ)
  expect(usage?.procs).toEqual([
    { pid: 2, procKey: '2:0', command: 'cmd 2', pss: 90 * MB, rss: 180 * MB, cpu: 100, startedMs: 0 },
    { pid: 1, procKey: '1:0', command: 'cmd 1', pss: 10 * MB, rss: 20 * MB, cpu: 20, startedMs: 0 },
  ])
})

test('ticksOf keeps each process by pid:starttime for the next delta', () => {
  expect(ticksOf([row('a1', 1, 0, 7, 3), row('main', 2, 0, 9, 4)])).toEqual(new Map([['1:3', 7], ['2:4', 9]]))
})

test('withPoints keeps the last minute per agent and drops agents with nothing in it', () => {
  const history = { a1: [{ t: 0, pss: 5, cpu: 1 }, { t: 30_000, pss: 9, cpu: 2 }], gone: [{ t: 1_000, pss: 1, cpu: 1 }] }
  const usages = [{ key: 'a1', pss: 7, rss: 7, cpu: 3, procs: [] }]
  expect(withPoints(history, usages, 65_000, 60_000)).toEqual({
    a1: [{ t: 30_000, pss: 9, cpu: 2 }, { t: 65_000, pss: 7, cpu: 3 }],
  })
})

test('peakOf takes memory and CPU peaks on their own', () => {
  expect(peakOf([{ t: 0, pss: 9, cpu: 2 }, { t: 1, pss: 3, cpu: 80 }])).toEqual({ pss: 9, cpu: 80 })
  expect(peakOf([])).toEqual({ pss: 0, cpu: 0 })
})

test('withMaxima keeps the session high-water marks', () => {
  const maxima = { a1: { pss: 10, cpu: 300 } }
  const usages = [{ key: 'a1', pss: 50, rss: 50, cpu: 20, procs: [] }, { key: 'a2', pss: 1, rss: 1, cpu: 2, procs: [] }]
  expect(withMaxima(maxima, usages)).toEqual({ a1: { pss: 50, cpu: 300 }, a2: { pss: 1, cpu: 2 } })
})

const TURN = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, model: 'claude-opus-5-5' }

const TURNS = [
  [
    'a first turn: input, cache writes and output are tokens, cache reads apart; the model is kept with its tokens',
    {},
    'a1',
    TURN,
    { a1: { tokens: 510, cacheReadTokens: 5000, model: 'claude-opus-5-5', byModel: { 'claude-opus-5-5': 510 } } },
  ],
  [
    'a later turn adds to the count and to its model',
    { a1: { tokens: 1, cacheReadTokens: 2, model: 'claude-opus-5-5', byModel: { 'claude-opus-5-5': 1 } } },
    'a1',
    TURN,
    { a1: { tokens: 511, cacheReadTokens: 5002, model: 'claude-opus-5-5', byModel: { 'claude-opus-5-5': 511 } } },
  ],
  [
    'a turn on another model: the last model is that one, each model keeps its own tokens',
    { a1: { tokens: 510, cacheReadTokens: 5000, model: 'claude-opus-5-5', byModel: { 'claude-opus-5-5': 510 } } },
    'a1',
    { ...TURN, model: 'claude-haiku-5' },
    { a1: { tokens: 1020, cacheReadTokens: 10_000, model: 'claude-haiku-5', byModel: { 'claude-opus-5-5': 510, 'claude-haiku-5': 510 } } },
  ],
  [
    'another loop keeps its own',
    { main: { tokens: 7, cacheReadTokens: 0, model: 'm', byModel: { m: 7 } } },
    'a1',
    TURN,
    { main: { tokens: 7, cacheReadTokens: 0, model: 'm', byModel: { m: 7 } }, a1: { tokens: 510, cacheReadTokens: 5000, model: 'claude-opus-5-5', byModel: { 'claude-opus-5-5': 510 } } },
  ],
] as const

for (const [name, counts, key, turn, expected] of TURNS) {
  test(`withTurn: ${name}`, () => {
    expect(withTurn(counts, key, turn)).toEqual(expected)
  })
}
