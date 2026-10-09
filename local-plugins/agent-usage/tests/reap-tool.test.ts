import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { COMMAND, startSession, usageText, world } from './world'
import type { Fake } from './world'

const REAP = 'mcp__agent-usage__agent_reap'

const fixer = (status: string) => ({ id: 'a1', name: 'fixer-1', description: 'fix', type: 'general-purpose', status })

/** A subagent's background command (shell 200, node 201 of 3 GB) left behind once it stopped, sampled once. */
const leftovers = async ($: Engine, on: Parameters<typeof world>[0], status = 'completed', os: 'Linux' | 'Darwin' = 'Linux') => {
  const agents = [fixer(status)]
  const w = world(on, { agents, os })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true, agentId: 'a1' } as never)
  await w.clock.advance(5000)
  return { ...w, agents }
}

/** Calls agent_reap and lets the clock run through its waits. */
const reap = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, args: Record<string, unknown>) => {
  const pending = $.tool.call({ tool: REAP, ...args } as never)
  await clock.advance(5000)
  return JSON.parse(String((await pending).result)) as unknown
}

test('agent_reap is registered beside agent_usage with its one-line description', async ($, on) => {
  const { tools } = world(on)
  await startSession($)
  expect(tools).toEqual([
    'Default: available memory, load, memory/CPU per agent. Pass procs/unattributed/history for detail.',
    'Kill leftover processes of a stopped agent (only processes agent_usage lists as unattributed for it). Goes through Bash.',
  ])
})

for (const os of ['Linux', 'Darwin'] as const) {
  test(`${os}: agent_reap sends TERM through the Bash tool to a stopped agent's leftovers, and reports them killed`, async ($, on) => {
    const { clock, kills } = await leftovers($, on, 'completed', os)
    expect(await reap($, clock, { agent: 'fixer-1' })).toEqual({
      agent: 'fixer-1',
      killed: [
        { pid: 201, cmd: 'node big.js', pssMb: 3072 },
        { pid: 200, cmd: expect.stringMatching(/^\/bin\/bash -c /), pssMb: 4 },
      ],
      survived: [],
      skipped: [],
    })
    expect(kills).toEqual(['kill -TERM 201 200'])
  })
}

test('agent_reap sends KILL, again through Bash, only to what outlived TERM', async ($, on) => {
  const { clock, kills, reaping } = await leftovers($, on)
  reaping.stubborn.add(201)
  const result = (await reap($, clock, { agent: 'a1' })) as { killed: { pid: number }[]; survived: unknown[] }
  expect(kills).toEqual(['kill -TERM 201 200', 'kill -KILL 201'])
  expect([result.killed.map(k => k.pid), result.survived]).toEqual([[201, 200], []])
})

test('agent_reap reports what outlived KILL as survived', async ($, on) => {
  const { clock, kills, reaping } = await leftovers($, on)
  reaping.stubborn.add(201)
  reaping.unkillable.add(201)
  const result = (await reap($, clock, { agent: 'fixer-1' })) as { killed: { pid: number }[]; survived: { pid: number }[] }
  expect(kills).toEqual(['kill -TERM 201 200', 'kill -KILL 201'])
  expect([result.killed.map(k => k.pid), result.survived.map(s => s.pid)]).toEqual([[200], [201]])
})

test('agent_reap dryRun says what it would kill and sends nothing', async ($, on) => {
  const { clock, kills } = await leftovers($, on)
  expect(await reap($, clock, { agent: 'fixer-1', dryRun: true })).toEqual({
    agent: 'fixer-1',
    dryRun: true,
    wouldKill: [
      { pid: 201, cmd: 'node big.js', pssMb: 3072 },
      { pid: 200, cmd: expect.stringMatching(/^\/bin\/bash -c /), pssMb: 4 },
    ],
    skipped: [],
  })
  expect(kills).toEqual([])
})

const REFUSALS = [
  ['a live agent', 'running', 'fixer-1', "fixer-1 is running: only a stopped or gone agent's leftovers are reaped"],
  ['main', 'completed', 'main', "refusing main: the main conversation's processes are never reaped"],
  ['claude', 'completed', 'claude', 'refusing claude itself'],
] as const

for (const [name, status, agent, error] of REFUSALS) {
  test(`agent_reap refuses ${name} and sends nothing`, async ($, on) => {
    const { clock, kills } = await leftovers($, on, status)
    expect(await reap($, clock, { agent })).toEqual({ agent, error })
    expect(kills).toEqual([])
  })
}

test('agent_reap without an agent refuses', async ($, on) => {
  const { clock, kills } = await leftovers($, on)
  expect(await reap($, clock, {})).toEqual({ error: 'agent is required (a name or id)' })
  expect(kills).toEqual([])
})

const DENIALS = [
  ['a deny', 'deny', 'kill -TERM went through Bash and failed: denied by the test'],
  ['an errored call that killed nothing', 'error', 'kill -TERM went through Bash and failed: The user rejected it'],
] as const

for (const [name, answer, error] of DENIALS) {
  test(`agent_reap stops at ${name} of TERM: no KILL follows`, async ($, on) => {
    const { clock, kills, reaping } = await leftovers($, on)
    reaping.answer = answer
    expect(await reap($, clock, { agent: 'fixer-1' })).toEqual({ agent: 'fixer-1', error, skipped: [] })
    expect(kills).toEqual(['kill -TERM 201 200'])
  })
}

test('reapOnStop off (the default): an agent that stops is left alone', async ($, on) => {
  const { clock, kills, agents } = await leftovers($, on, 'running')
  agents[0] = fixer('completed')
  await clock.advance(60_000)
  expect(kills).toEqual([])
})

test('reapOnStop: once an agent goes from live to stopped, its leftovers are reaped after 30 s, through Bash', { options: { reapOnStop: true } }, async ($, on) => {
  const { clock, kills, agents } = await leftovers($, on, 'running')
  agents[0] = fixer('completed')
  await clock.advance(5000)
  await clock.advance(25_000)
  expect(kills).toEqual([])
  await clock.advance(10_000)
  expect(kills).toEqual(['kill -TERM 201 200'])
  expect(await usageText($)).toMatch(/\nReap on stop: on, 30s after an agent stops; 1 reaped\. Last: Reaped 2 leftover processes of stopped agent fixer-1/)
})

test('reapOnStop: an agent live again within the grace is not reaped', { options: { reapOnStop: true } }, async ($, on) => {
  const { clock, kills, agents } = await leftovers($, on, 'running')
  agents[0] = fixer('completed')
  await clock.advance(5000)
  agents[0] = fixer('running')
  await clock.advance(40_000)
  expect(kills).toEqual([])
})

test("agent_reap kills a stopped agent's leftover test run, known by LIVE_TESTS_AGENT_ID in its environ", async ($, on) => {
  const { clock, kills, procs } = world(on, { agents: [fixer('completed')] })
  procs.set(100, { ...(procs.get(100) as Fake), children: [300, 310] })
  procs.set(310, { ppid: 100, comm: 'bun', startTicks: 10_500, argv: ['bun', 'test'], pssKb: 1024 * 1024, environ: 'LIVE_TESTS_AGENT_ID=a1\0' })
  await startSession($)
  await clock.advance(5000)
  expect(await reap($, clock, { agent: 'fixer-1' })).toEqual({ agent: 'fixer-1', killed: [{ pid: 310, cmd: 'bun test', pssMb: 1024 }], survived: [], skipped: [] })
  expect(kills).toEqual(['kill -TERM 310'])
})

const REPRO_ID = 'a47ac945c714018d0'
const reproAgent = (status: string) => ({ id: REPRO_ID, description: 'Reap test: leave processes behind', type: 'general-purpose', status })

/**
 * The live repro: a subagent's run_tests, run by live-tests through $.tool.call in the main loop (so
 * its Bash record is main's), whose step subshell exports LIVE_TESTS_AGENT_ID: shell 200 and subshell
 * 201 unlabelled, pytest 202 and its worker 203 labelled, tee 204 unlabelled. The agent is live, then stopped.
 */
const reproRun = async ($: Engine, on: Parameters<typeof world>[0]) => {
  const agents = [reproAgent('running')]
  const w = world(on, { agents })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true } as never)
  const env = `PATH=/bin\0LIVE_TESTS_AGENT_ID=${REPRO_ID}\0LIVE_TESTS_RUN=t1\0`
  w.procs.set(201, { ppid: 200, comm: 'bash', startTicks: 10_001, argv: ['/bin/bash', '-c', 'step'], pssKb: 2 * 1024, children: [202, 204] })
  w.procs.set(202, { ppid: 201, comm: 'pytest', startTicks: 10_002, argv: ['python', '-m', 'pytest'], pssKb: 32 * 1024, children: [203], environ: env })
  w.procs.set(203, { ppid: 202, comm: 'python', startTicks: 10_003, argv: ['python', 'worker.py'], pssKb: 8 * 1024, environ: env })
  w.procs.set(204, { ppid: 201, comm: 'tee', startTicks: 10_002, argv: ['tee', 'log'], pssKb: 1024 })
  await w.clock.advance(5000)
  return { ...w, agents }
}

const unattributedOf = async ($: Engine) => {
  const called = await $.tool.call({ tool: 'mcp__agent-usage__agent_usage', unattributed: true } as never)
  return JSON.parse(String(called.result)) as { agents: { agent: string }[]; unattributed: { procs?: { pid: number; reason: string; agent?: string }[] } }
}

test('repro: a stopped agent\'s env-labelled test run, under a main Bash record, moves to unattributed "agent stopped"', async ($, on) => {
  const { clock, agents } = await reproRun($, on)
  expect((await unattributedOf($)).agents.map(a => a.agent)).toEqual(['Reap test: leave processes behind', 'main'])
  agents[0] = reproAgent('killed')
  await clock.advance(5000)
  const json = await unattributedOf($)
  expect([json.agents.map(a => a.agent), (json.unattributed.procs ?? []).filter(p => p.reason === 'agent stopped').map(p => [p.pid, p.agent])]).toEqual([
    ['main'],
    [
      [202, 'Reap test: leave processes behind'],
      [203, 'Reap test: leave processes behind'],
    ],
  ])
})

test("repro: agent_reap dryRun lists a stopped agent's env-labelled test run under a main Bash record", async ($, on) => {
  const { clock, agents, kills } = await reproRun($, on)
  agents[0] = reproAgent('killed')
  const result = (await reap($, clock, { agent: REPRO_ID, dryRun: true })) as { wouldKill: { pid: number }[] }
  expect(result.wouldKill.map(k => k.pid)).toEqual([202, 203])
  expect(kills).toEqual([])
})

const NOTE = 'nothing left to reap'

const REPRO_NAME = 'Reap test: leave processes behind'

test('repro timing: the run ended before the reap (the live case): the reap says nothing is left', async ($, on) => {
  const { clock, agents, kills, procs } = await reproRun($, on)
  agents[0] = reproAgent('killed')
  await clock.advance(5000)
  ;[202, 203, 204].forEach(pid => procs.delete(pid))
  procs.set(201, { ...(procs.get(201) as Fake), children: [] })
  expect([await reap($, clock, { agent: REPRO_ID, dryRun: true }), await reap($, clock, { agent: REPRO_ID })]).toEqual([
    { agent: REPRO_NAME, dryRun: true, wouldKill: [], note: NOTE },
    { agent: REPRO_NAME, killed: [], note: NOTE },
  ])
  expect(kills).toEqual([])
})

test('agent_reap of an agent seen once, no longer listed, with nothing left: nothing left, by name and by id', async ($, on) => {
  const agents = [fixer('running')]
  const { clock, kills } = world(on, { agents })
  await startSession($)
  await clock.advance(5000)
  agents.length = 0
  expect([await reap($, clock, { agent: 'fixer-1' }), await reap($, clock, { agent: 'a1', dryRun: true })]).toEqual([
    { agent: 'fixer-1', killed: [], note: NOTE },
    { agent: 'fixer-1', dryRun: true, wouldKill: [], note: NOTE },
  ])
  expect(kills).toEqual([])
})

test('agent_reap of a stopped agent still listed, with nothing left: nothing left', async ($, on) => {
  const { clock, kills } = world(on, { agents: [fixer('killed')] })
  await startSession($)
  await clock.advance(5000)
  expect(await reap($, clock, { agent: 'fixer-1' })).toEqual({ agent: 'fixer-1', killed: [], note: NOTE })
  expect(kills).toEqual([])
})

test('agent_reap of an agent known only by its tokens: nothing left', async ($, on) => {
  const { clock, kills } = world(on)
  await startSession($)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a9', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } })
  await clock.advance(5000)
  expect(await reap($, clock, { agent: 'a9' })).toEqual({ agent: 'a9', killed: [], note: NOTE })
  expect(kills).toEqual([])
})

test('agent_reap of a name never seen: no agent', async ($, on) => {
  const { clock, kills } = world(on, { agents: [fixer('killed')] })
  await startSession($)
  await clock.advance(5000)
  expect(await reap($, clock, { agent: 'nobody' })).toEqual({ agent: 'nobody', error: 'no agent "nobody"' })
  expect(kills).toEqual([])
})
