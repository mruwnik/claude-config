import { expect, test } from 'claude-code/testing'

import { pressureStep, pressureText, snapshotText, statusOf, toolJson, toolOptions, usageJson } from '../hooks/report'
import type { JsonInput } from '../hooks/report'
import type { AgentUsage, ProcUsage } from '../hooks/usage'

const MB = 1024 * 1024
const AT = Date.UTC(2026, 9, 6, 12, 0, 0)

const proc = (pid: number, pssMb: number, command: string, ageS = 10, cpu = 0): ProcUsage => ({ pid, procKey: `${pid}:${ageS}`, command, pss: pssMb * MB, rss: pssMb * 2 * MB, cpu, startedMs: AT - ageS * 1000 })

const usage = (key: string, procs: readonly ProcUsage[]): AgentUsage => ({
  key,
  pss: procs.reduce((sum, p) => sum + p.pss, 0),
  rss: procs.reduce((sum, p) => sum + p.rss, 0),
  cpu: procs.reduce((sum, p) => sum + p.cpu, 0),
  procs: [...procs],
})

const agent = (id: string, status: string, name?: string) => ({ id, status, description: `task ${id}`, ...(name === undefined ? {} : { name }) })

const STATUSES = [
  ['main is always running', 'main', [], 'running'],
  ['a listed running agent', 'a1', [agent('a1', 'running')], 'running'],
  ['an idle teammate is live', 'a1', [agent('a1', 'idle')], 'idle'],
  ['completed is stopped', 'a1', [agent('a1', 'completed')], 'stopped'],
  ['killed is stopped', 'a1', [agent('a1', 'killed')], 'stopped'],
  ['no longer listed is gone', 'a1', [agent('a2', 'running')], 'gone'],
] as const

for (const [name, key, agents, expected] of STATUSES) {
  test(`statusOf: ${name}`, () => {
    expect(statusOf(key, agents)).toBe(expected)
  })
}

const input = (fields: Partial<JsonInput>): JsonInput => ({
  at: AT,
  mem: { availableKb: 6_000 * 1024, totalKb: 32_000 * 1024 },
  floorMb: null,
  usages: [],
  agents: [],
  names: {},
  history: {},
  maxima: {},
  firstSeen: {},
  load: undefined,
  tokens: {},
  ...fields,
})

test('usageJson: live agents biggest first, by name with id beside it; claude in totals', () => {
  const json = usageJson(
    input({
      usages: [
        usage('claude', [proc(100, 500, 'claude')]),
        usage('main', [proc(200, 1, 'bash -c ls')]),
        usage('a1', [proc(300, 3000, 'java -cp shadow-cljs.jar clojure.main -m shadow.cljs.devtools.cli watch app', 120, 45), proc(301, 300, 'node npx shadow-cljs watch app', 125)]),
      ],
      agents: [agent('a1', 'running', 'integration-12')],
      names: { a1: 'integration-12' },
      history: { a1: [{ t: AT - 1000, pss: 3500 * MB, cpu: 50 }] },
      maxima: { a1: { pss: 4000 * MB, cpu: 90 } },
      firstSeen: { a1: AT - 130_000, main: AT - 5_000 },
      floorMb: 4096,
    }),
  )
  expect(json).toEqual({
    at: '2026-10-06T12:00:00.000Z',
    memAvailableMb: 6000,
    memTotalMb: 32000,
    floorMb: 4096,
    load: null,
    totals: { agentsPssMb: 3301, claudePssMb: 500, unattributedPssMb: 0 },
    agents: [
      {
        agent: 'integration-12',
        id: 'a1',
        status: 'running',
        pssMb: 3300,
        rssMb: 6600,
        cpuPct: 45,
        peak1mPssMb: 3500,
        maxPssMb: 4000,
        since: '2026-10-06T11:57:50.000Z',
        procCount: 2,
        procs: [
          { pid: 300, pssMb: 3000, rssMb: 6000, cpuPct: 45, cmd: 'java -cp shadow-cljs.jar clojure.main -m shadow.cljs.devtools.cli watch app', ageS: 120 },
          { pid: 301, pssMb: 300, rssMb: 600, cpuPct: 0, cmd: 'node npx shadow-cljs watch app', ageS: 125 },
        ],
      },
      {
        agent: 'main',
        id: null,
        status: 'running',
        pssMb: 1,
        rssMb: 2,
        cpuPct: 0,
        peak1mPssMb: 1,
        maxPssMb: 1,
        since: '2026-10-06T11:59:55.000Z',
        procCount: 1,
        procs: [{ pid: 200, pssMb: 1, rssMb: 2, cpuPct: 0, cmd: 'bash -c ls', ageS: 10 }],
      },
    ],
    unattributed: { pssMb: 0, procs: [] },
  })
})

test('usageJson: processes of stopped and gone agents, and claude children no record owns, are unattributed with a reason', () => {
  const json = usageJson(
    input({
      usages: [
        usage('a1', [proc(300, 3300, 'java shadow-cljs')]),
        usage('a2', [proc(400, 200, 'node server.js')]),
        usage('other', [proc(500, 50, 'node mcp.js')]),
        usage('a3', [proc(600, 10, 'sleep 100')]),
      ],
      agents: [agent('a1', 'completed', 'fixer-1'), agent('a3', 'running', 'live-one')],
      names: { a1: 'fixer-1', a2: 'old-agent' },
    }),
  )
  expect(json.agents.map(a => a.agent)).toEqual(['live-one'])
  expect(json.totals).toEqual({ agentsPssMb: 10, claudePssMb: 0, unattributedPssMb: 3550 })
  expect(json.unattributed).toEqual({
    pssMb: 3550,
    procs: [
      { pid: 300, pssMb: 3300, rssMb: 6600, cpuPct: 0, cmd: 'java shadow-cljs', ageS: 10, reason: 'agent stopped', agent: 'fixer-1', id: 'a1' },
      { pid: 400, pssMb: 200, rssMb: 400, cpuPct: 0, cmd: 'node server.js', ageS: 10, reason: 'agent gone', agent: 'old-agent', id: 'a2' },
      { pid: 500, pssMb: 50, rssMb: 100, cpuPct: 0, cmd: 'node mcp.js', ageS: 10, reason: 'no record' },
    ],
  })
})

test('usageJson: the agent filter keeps that agent alone, by name or id; totals and unattributed stay whole', () => {
  const full = input({
    usages: [usage('a1', [proc(1, 10, 'x')]), usage('a2', [proc(2, 20, 'y')]), usage('other', [proc(3, 300, 'z')])],
    agents: [agent('a1', 'running', 'one'), agent('a2', 'running', 'two')],
    names: { a1: 'one', a2: 'two' },
  })
  expect(usageJson(full, 'one').agents.map(a => a.id)).toEqual(['a1'])
  expect(usageJson(full, 'a2').agents.map(a => a.id)).toEqual(['a2'])
  expect(usageJson(full, 'one').totals).toEqual(usageJson(full).totals)
  expect(usageJson(full, 'nobody').agents).toEqual([])
})

test('usageJson: a long command is cut to 80 characters on one line; at most 10 processes per agent', () => {
  const many = Array.from({ length: 12 }, (_, i) => proc(i + 1, 12 - i, i === 0 ? `node\n${'x'.repeat(100)}` : 'p'))
  const [only] = usageJson(input({ usages: [usage('main', many)] })).agents
  expect(only?.procCount).toBe(12)
  expect(only?.procs).toHaveLength(10)
  expect(only?.procs[0]?.cmd).toBe(`node ${'x'.repeat(75)}`)
})

test('usageJson: no meminfo reads as null', () => {
  const json = usageJson(input({ mem: undefined }))
  expect([json.memAvailableMb, json.memTotalMb, json.floorMb]).toEqual([null, null, null])
})

test('snapshotText is the JSON, one line, newline-terminated', () => {
  const json = usageJson(input({ usages: [usage('main', [proc(1, 1, 'x')])] }))
  const text = snapshotText(json)
  expect(text.endsWith('}\n')).toBe(true)
  expect(text.trimEnd().includes('\n')).toBe(false)
  expect(JSON.parse(text)).toEqual(json)
})

const FLOOR = 4096
const MARGIN = 1024

const PRESSURE = [
  ['off with no floor', { armed: true }, 100, 0, { armed: true, fire: false }],
  ['plenty available: nothing', { armed: true }, 8000, FLOOR, { armed: true, fire: false }],
  ['below floor + margin: fires once', { armed: true }, 5000, FLOOR, { armed: false, fire: true }],
  ['still below: no second notice', { armed: false }, 4500, FLOOR, { armed: false, fire: false }],
  ['back above floor + margin, under the extra 256: stays disarmed', { armed: false }, 5300, FLOOR, { armed: false, fire: false }],
  ['above floor + margin + 256: re-arms', { armed: false }, 5500, FLOOR, { armed: true, fire: false }],
] as const

for (const [name, state, availMb, floorMb, expected] of PRESSURE) {
  test(`pressureStep: ${name}`, () => {
    expect(pressureStep(state, availMb, floorMb, MARGIN)).toEqual(expected)
  })
}

test('pressureText names the top three agents and the unattributed total, and what to do', () => {
  const json = usageJson(
    input({
      mem: { availableKb: 4500 * 1024, totalKb: 32_000 * 1024 },
      floorMb: FLOOR,
      usages: [usage('a1', [proc(1, 3300, 'x')]), usage('a2', [proc(2, 1200, 'y')]), usage('main', [proc(3, 200, 'z')]), usage('a3', [proc(4, 5, 'w')]), usage('other', [proc(5, 800, 'v')])],
      agents: [agent('a1', 'running', 'integration-12'), agent('a2', 'running', 'docs'), agent('a3', 'running', 'tiny')],
      names: { a1: 'integration-12', a2: 'docs', a3: 'tiny' },
    }),
  )
  expect(pressureText(json, MARGIN)).toBe(
    '<agent-usage-notice>\n' +
      'Memory is low: 4.4G available, under the floor 4.0G + margin 1.0G. ' +
      'Biggest agents: integration-12 3.2G, docs 1.2G, main 200M. Unattributed: 800M. ' +
      'Call agent_usage for the per-process list; TaskStop stops an agent by name.\n' +
      '</agent-usage-notice>',
  )
})

const OPTION_CASES = [
  ['nothing asked: compact', {}, {}],
  ['the flags', { procs: true, unattributed: true, history: true, rss: true }, { procs: true, unattributed: true, history: true, rss: true }],
  ['an agent filter', { agent: 'fixer-1' }, { agent: 'fixer-1' }],
  ['a limit', { procs: true, limit: 3 }, { procs: true, limit: 3 }],
  ['full detail', { detail: 'full' }, { detail: 'full' }],
  ['nonsense is ignored', { procs: 'yes', limit: -2, detail: 'everything', agent: '' }, {}],
  ['not an object', 'x', {}],
] as const

for (const [name, raw, expected] of OPTION_CASES) {
  test(`toolOptions: ${name}`, () => {
    expect(toolOptions(raw)).toEqual(expected)
  })
}

const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5'

const LOAD = { load1: 7.49, load5: 6.05, cores: 16, cpuPct: 31 }

/** Three live agents (one with tokens but no processes, one with neither), main, claude, two unattributed processes, and tokens per loop. */
const busy = (): JsonInput =>
  input({
    load: LOAD,
    usages: [
      usage('claude', [proc(100, 549, 'claude', 600, 5)]),
      usage('main', [proc(200, 1, 'bash -c ls', 3)]),
      usage('a1', [
        proc(300, 3000, `java -cp shadow-cljs.jar clojure.main -m shadow.cljs.devtools.cli watch app ${'x'.repeat(40)}`, 120, 45),
        proc(301, 300, 'node npx shadow-cljs watch app', 125),
        proc(302, 2, 'sh -c x', 125),
      ]),
      usage('a2', [proc(400, 200, 'node old-server.js', 900)]),
      usage('other', [proc(500, 50, 'node mcp.js', 3000)]),
    ],
    agents: [agent('a1', 'running', 'integration-12'), agent('a3', 'idle', 'quiet-one'), agent('a4', 'idle', 'silent'), agent('a2', 'completed', 'fixer-1')],
    names: { a1: 'integration-12', a2: 'fixer-1', a3: 'quiet-one' },
    history: { a1: [{ t: AT - 1000, pss: 3500 * MB, cpu: 50 }] },
    maxima: { a1: { pss: 4000 * MB, cpu: 90 } },
    firstSeen: { a1: AT - 130_000 },
    tokens: {
      a1: { tokens: 1000, cacheReadTokens: 9000, model: OPUS, byModel: { [HAIKU]: 400, [OPUS]: 600 } },
      main: { tokens: 50, cacheReadTokens: 0, model: OPUS, byModel: { [OPUS]: 50 } },
      a3: { tokens: 20, cacheReadTokens: 0, model: HAIKU, byModel: { [HAIKU]: 20 } },
      a2: { tokens: 500, cacheReadTokens: 0, model: OPUS, byModel: { [OPUS]: 500 } },
    },
  })

test('toolJson by default: memory, load, each live agent by name with only its non-zero memory, CPU, tokens and model (models when more than one; none: left out), claude, the unattributed total, the tokens of main and the session by model', () => {
  expect(toolJson(busy(), {})).toEqual({
    at: '2026-10-06T12:00:00.000Z',
    memAvailableMb: 6000,
    memTotalMb: 32000,
    load: LOAD,
    agents: [
      { agent: 'integration-12', pssMb: 3302, cpuPct: 45, tokens: 1000, cacheReadTokens: 9000, model: OPUS, models: { [HAIKU]: 400, [OPUS]: 600 } },
      { agent: 'main', pssMb: 1, tokens: 50, model: OPUS },
      { agent: 'quiet-one', tokens: 20, model: HAIKU },
    ],
    claude: { pssMb: 549, cpuPct: 5 },
    unattributed: { pssMb: 250, count: 2 },
    tokens: { main: 50, session: 1570, sessionCacheRead: 9000, byModel: { [OPUS]: 1150, [HAIKU]: 420 } },
  })
})

test('toolJson by default is one short line', () => {
  const text = JSON.stringify(toolJson(busy(), {}))
  expect(text.includes('\n')).toBe(false)
  expect(text.length).toBeLessThan(1024)
})

test('toolJson procs: the top `limit` processes per agent (default 5), command cut to 60', () => {
  const json = toolJson(busy(), { procs: true, limit: 2 })
  expect(json.agents[0]).toEqual({
    agent: 'integration-12',
    pssMb: 3302,
    cpuPct: 45,
    tokens: 1000,
    cacheReadTokens: 9000,
    model: OPUS,
    models: { [HAIKU]: 400, [OPUS]: 600 },
    procs: [
      { pid: 300, pssMb: 3000, cpuPct: 45, cmd: 'java -cp shadow-cljs.jar clojure.main -m shadow.cljs.devtool', ageS: 120 },
      { pid: 301, pssMb: 300, cmd: 'node npx shadow-cljs watch app', ageS: 125 },
    ],
  })
  expect(toolJson(busy(), { procs: true }).agents[0]?.procs).toHaveLength(3)
  expect(json.agents[2]).toEqual({ agent: 'quiet-one', tokens: 20, model: HAIKU })
})

test('toolJson unattributed: lists them biggest first with reason and the agent that left them', () => {
  expect(toolJson(busy(), { unattributed: true }).unattributed).toEqual({
    pssMb: 250,
    count: 2,
    procs: [
      { pid: 400, pssMb: 200, cmd: 'node old-server.js', ageS: 900, reason: 'agent stopped', agent: 'fixer-1' },
      { pid: 500, pssMb: 50, cmd: 'node mcp.js', ageS: 3000, reason: 'no record' },
    ],
  })
})

test('toolJson history: peak, max, since and status per agent', () => {
  const [first, mainRow, quiet, silent] = toolJson(busy(), { history: true }).agents
  expect(first).toEqual({
    agent: 'integration-12',
    pssMb: 3302,
    cpuPct: 45,
    tokens: 1000,
    cacheReadTokens: 9000,
    model: OPUS,
    models: { [HAIKU]: 400, [OPUS]: 600 },
    peak1mPssMb: 3500,
    maxPssMb: 4000,
    since: '2026-10-06T11:57:50.000Z',
    status: 'running',
  })
  expect(mainRow).toEqual({ agent: 'main', pssMb: 1, tokens: 50, model: OPUS, peak1mPssMb: 1, maxPssMb: 1, status: 'running' })
  expect(quiet).toEqual({ agent: 'quiet-one', tokens: 20, model: HAIKU, status: 'idle' })
  expect(silent).toEqual({ agent: 'silent', status: 'idle' })
})

test('toolJson rss: rssMb beside pssMb, on agents, claude and processes', () => {
  const json = toolJson(busy(), { rss: true, procs: true, limit: 1 })
  expect(json.agents[0]).toMatchObject({ pssMb: 3302, rssMb: 6604 })
  expect(json.agents[0]?.procs?.[0]).toMatchObject({ pssMb: 3000, rssMb: 6000 })
  expect((json as { claude?: unknown }).claude).toEqual({ pssMb: 549, rssMb: 1098, cpuPct: 5 })
})

test('toolJson agent filter keeps that agent, by name or id', () => {
  expect(toolJson(busy(), { agent: 'quiet-one' }).agents).toEqual([{ agent: 'quiet-one', tokens: 20, model: HAIKU }])
  expect(toolJson(busy(), { agent: 'a1' }).agents.map(a => a.agent)).toEqual(['integration-12'])
})

test('toolJson detail full is the snapshot shape, filtered when asked', () => {
  expect(toolJson(busy(), { detail: 'full' })).toEqual(usageJson(busy()))
  expect(toolJson(busy(), { detail: 'full', agent: 'a1' })).toEqual(usageJson(busy(), 'a1'))
})

test('usageJson (the full shape) carries load too', () => {
  expect(usageJson(busy()).load).toEqual(LOAD)
  expect(usageJson(input({})).load).toBeNull()
})

test('toolJson by default leaves out a live agent with no memory, CPU or tokens', () => {
  expect(toolJson(busy(), { agent: 'silent' }).agents).toEqual([])
})

test('toolJson with no tokens counted leaves the session total out', () => {
  expect(toolJson(input({}), {})).toEqual({ at: '2026-10-06T12:00:00.000Z', memAvailableMb: 6000, memTotalMb: 32000, agents: [], claude: {}, unattributed: {} })
})
