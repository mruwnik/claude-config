import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { UsageJson } from '../hooks/report'
import { COMMAND, startSession, usageText, world } from './world'
import type { Fake } from './world'

const usageNow = async ($: Engine, args: Record<string, unknown> = {}) => {
  const called = await $.tool.call({ tool: 'mcp__agent-usage__agent_usage', ...args } as never)
  return JSON.parse(String(called.result)) as UsageJson
}

test('agent_usage by default answers one short line: memory, load with the machine CPU, each agent, claude, the unattributed total', async ($, on) => {
  const { clock, machine } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  // A quarter of the machine busy over the next interval.
  machine.busy += 250
  machine.idle += 750
  await clock.advance(5000)
  const called = await $.tool.call({ tool: 'mcp__agent-usage__agent_usage' } as never)
  const text = String(called.result)
  expect(text.includes('\n')).toBe(false)
  expect(JSON.parse(text)).toEqual({
    at: expect.any(String),
    memAvailableMb: 16_000,
    memTotalMb: 32_000,
    load: { load1: 7.49, load5: 6.05, cores: 4, cpuPct: 25 },
    agents: [{ agent: 'main', pssMb: 3076 }],
    claude: { pssMb: 500 },
    unattributed: { pssMb: 50, count: 1 },
  })
})

test('agent_usage procs and unattributed add the lists, through the tool arguments', async ($, on) => {
  const { clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  const called = await $.tool.call({ tool: 'mcp__agent-usage__agent_usage', procs: true, limit: 1, unattributed: true } as never)
  const json = JSON.parse(String(called.result)) as { agents: { procs: { pid: number }[] }[]; unattributed: { procs: { pid: number; reason: string }[] } }
  expect(json.agents[0]?.procs.map(p => p.pid)).toEqual([201])
  expect(json.unattributed.procs.map(p => [p.pid, p.reason])).toEqual([[300, 'no record']])
})

test("agent_usage detail full: the command's agent with its processes, claude in totals, claude's other children unattributed", async ($, on) => {
  const { clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  const json = await usageNow($, { detail: 'full' })
  expect([json.memAvailableMb, json.memTotalMb, json.floorMb]).toEqual([16_000, 32_000, null])
  expect(json.totals).toEqual({ agentsPssMb: 3076, claudePssMb: 500, unattributedPssMb: 50 })
  expect(json.agents.map(a => [a.agent, a.id, a.status, a.pssMb, a.procCount])).toEqual([['main', null, 'running', 3076, 2]])
  expect(json.agents[0]?.procs.map(p => [p.pid, p.pssMb, p.cmd])).toEqual([
    [201, 3072, 'node big.js'],
    [200, 4, expect.stringMatching(/^\/bin\/bash -c source s\.sh && eval /)],
  ])
  expect(json.unattributed.procs.map(p => [p.pid, p.reason, p.cmd])).toEqual([[300, 'no record', 'node mcp.js']])
})

test("a stopped subagent's processes move to unattributed, named, with the reason", async ($, on) => {
  const { clock } = world(on, { agents: [{ id: 'a1', name: 'fixer-1', description: 'fix', type: 'general-purpose', status: 'completed' }] })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true, agentId: 'a1' } as never)
  await clock.advance(5000)
  const json = await usageNow($, { detail: 'full' })
  expect(json.agents).toEqual([])
  expect(json.unattributed.procs.map(p => [p.pid, p.reason, p.agent])).toEqual([
    [201, 'agent stopped', 'fixer-1'],
    [300, 'no record', undefined],
    [200, 'agent stopped', 'fixer-1'],
  ])
  expect(json.totals.unattributedPssMb).toBe(3126)
})

test('agent_usage with agent filters to that one', async ($, on) => {
  const { clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  expect((await usageNow($, { agent: 'main' })).agents.map(a => a.agent)).toEqual(['main'])
  expect((await usageNow($, { agent: 'nobody' })).agents).toEqual([])
  expect((await usageNow($, { agent: 'main', detail: 'full' })).agents.map(a => a.agent)).toEqual(['main'])
})

test('with snapshotPath set, each sample rewrites the file with the same JSON the tool gives', { options: { snapshotPath: '/run/user/1000/agent-usage.json' } }, async ($, on) => {
  const { clock, written } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  const text = written.get('/run/user/1000/agent-usage.json') ?? ''
  expect(text.endsWith('\n')).toBe(true)
  expect(JSON.parse(text)).toEqual(await usageNow($, { detail: 'full' }))
})

test('without snapshotPath nothing is written', async ($, on) => {
  const { clock, written } = world(on)
  await startSession($)
  await clock.advance(5000)
  expect([...written.keys()]).toEqual([])
})

// The kit does not pass a mod's own $.session.append through the test's hooks, so the notice is
// seen through what the mod keeps of it, which /agent-usage shows: armed or sent, the count, the last text.
const noticeLine = async ($: Engine) => (await usageText($)).split('\n').find(line => line.startsWith('Low-memory notice:'))

test(
  'under floor + margin: one notice; none while still low; re-armed once memory is back; never a toast',
  { options: { memoryFloorMB: 4096, pressureMarginMB: 1024 } },
  async ($, on) => {
    const { clock, mem, toasts } = world(on)
    await startSession($)
    await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
    await clock.advance(5000)
    expect(await noticeLine($)).toBe('Low-memory notice: armed, fires under 5.0G available; 0 sent.')

    mem.availableMb = 5000
    await clock.advance(5000)
    await clock.advance(5000)
    expect(await noticeLine($)).toBe(
      'Low-memory notice: 1 sent, re-arms above 5.3G available. Last: Memory is low: 4.9G available, under the floor 4.0G + margin 1.0G. ' +
        'Biggest agents: main 3.0G. Unattributed: 50M. Call agent_usage for the per-process list; TaskStop stops an agent by name.',
    )

    mem.availableMb = 5300
    await clock.advance(5000)
    expect(await noticeLine($)).toMatch(/^Low-memory notice: 1 sent, re-arms above/)
    mem.availableMb = 6000
    await clock.advance(5000)
    expect(await noticeLine($)).toBe('Low-memory notice: armed, fires under 5.0G available; 1 sent.')
    mem.availableMb = 4000
    await clock.advance(5000)
    expect(await noticeLine($)).toMatch(/^Low-memory notice: 2 sent, re-arms above 5\.3G available\. Last: Memory is low: 3\.9G available/)
    expect(toasts).toEqual([])
  },
)

test('with no floor set, low memory sends nothing and says it is off', async ($, on) => {
  const { clock, mem, toasts } = world(on)
  await startSession($)
  mem.availableMb = 100
  await clock.advance(5000)
  expect(await noticeLine($)).toBe('Low-memory notice: off (memoryFloorMB is 0).')
  expect(toasts).toEqual([])
})

const turnDone = ($: Engine, agentId: string | undefined, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId === undefined ? {} : { agentId }), usage })

test('agent_usage counts tokens per loop and model from each finished turn, and totals them for main and the session', async ($, on) => {
  const { clock } = world(on, { agents: [{ id: 'a1', status: 'running', name: 'worker', description: 'w' }] })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  await turnDone($, undefined, { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' })
  await turnDone($, 'a1', { input_tokens: 5, output_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 80, model: 'claude-opus-5-5' })
  await turnDone($, 'a1', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5' })
  const json = JSON.parse(String((await $.tool.call({ tool: 'mcp__agent-usage__agent_usage' } as never)).result)) as { agents: unknown[]; tokens: unknown }
  expect(json.agents).toEqual([
    { agent: 'main', pssMb: 3076, tokens: 100, cacheReadTokens: 1000, model: 'claude-opus-5-5' },
    { agent: 'worker', tokens: 102, model: 'claude-haiku-5', models: { 'claude-opus-5-5': 100, 'claude-haiku-5': 2 } },
  ])
  expect(json.tokens).toEqual({ main: 100, session: 202, sessionCacheRead: 1000, byModel: { 'claude-opus-5-5': 200, 'claude-haiku-5': 2 } })
})

/** A live-tests run claude started itself (pid 310, 2 GB, under claude), with this environ. */
const testRun = (procs: ReturnType<typeof world>['procs'], environ: string) => {
  procs.set(100, { ...(procs.get(100) as Fake), children: [300, 310] })
  procs.set(310, { ppid: 100, comm: 'bun', startTicks: 10_500, argv: ['bun', 'test'], pssKb: 2 * 1024 * 1024, environ })
}

const RUN_ENVIRONS = [
  ['LIVE_TESTS_AGENT_ID moves the run to its agent', 'PATH=/bin\0LIVE_TESTS_AGENT_ID=a1\0LIVE_TESTS_AGENT_NAME=worker\0', [{ agent: 'worker', pssMb: 2048 }], { pssMb: 50, count: 1 }],
  ['no variable: it stays untracked', 'PATH=/bin\0', [], { pssMb: 2098, count: 2 }],
  ['a malformed environ is ignored', 'LIVE_TESTS_AGENT_ID=\0LIVE_TESTS_AGENT_ID', [], { pssMb: 2098, count: 2 }],
] as const

for (const [name, environ, agents, unattributed] of RUN_ENVIRONS) {
  test(`environ: ${name}`, async ($, on) => {
    const { clock, procs } = world(on, { agents: [{ id: 'a1', status: 'running', name: 'worker', description: 'w' }] })
    testRun(procs, environ)
    await startSession($)
    await clock.advance(5000)
    const json = JSON.parse(String((await $.tool.call({ tool: 'mcp__agent-usage__agent_usage' } as never)).result)) as { agents: unknown[]; unattributed: unknown }
    expect([json.agents, json.unattributed]).toEqual([agents, unattributed])
  })
}

test('environ is read once per process, not every sample', async ($, on) => {
  const { clock, procs, reads } = world(on)
  testRun(procs, 'PATH=/bin\0')
  await startSession($)
  await clock.advance(5000)
  await clock.advance(5000)
  await clock.advance(5000)
  expect(reads.filter(path => path === '/proc/310/environ')).toEqual(['/proc/310/environ'])
})
