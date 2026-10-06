import { expect, test } from 'claude-code/testing'

import { CLAUDE, COMMAND, startSession, usageText, world } from './world'
import type { Fake } from './world'

test('the Bash call reaches the tool unchanged', async ($, on) => {
  const { calls } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, description: 'run it', timeout: 9000 })
  expect(calls).toEqual([{ tool: 'Bash', tool_use_id: expect.any(String), command: COMMAND, description: 'run it', timeout: 9000 }])
})

test("a background command's processes are the main conversation's; with footer alerts the status line warns while it is over, and no toast pops up", { options: { footer: 'alerts' } }, async ($, on) => {
  const { procs, statuses, toasts, clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  expect(statuses.at(-1)).toBe('⚠ main 3.0G 0%cpu')

  // 12 s of CPU in 5 s: 240% of one core.
  procs.set(201, { ...(procs.get(201) as Fake), ticks: 1200 })
  await clock.advance(5000)
  expect(statuses.at(-1)).toBe('⚠ main 3.0G 240%cpu')

  procs.set(201, { ...(procs.get(201) as Fake), pssKb: 1024, ticks: 1200 })
  await clock.advance(5000)
  expect(statuses.at(-1)).toBeUndefined()
  expect(toasts).toEqual([])

  const text = await usageText($)
  expect(text).toMatch(/^agent +mem +1m peak +max +cpu +1m peak +max\nmain +5\.0M +3\.0G +3\.0G +0% +240% +240%\n {4}pid 200 +4\.0M .*eval/)
  expect(text).toMatch(/\n {4}pid 201 +1\.0M +0% +node big\.js\n/)
  expect(text).toMatch(/\nclaude \(all loops\) +500M/)
  expect(text).toMatch(/\nclaude children \(MCP, untracked\) +50M .*\n {4}pid 300 +50M +0% +node mcp\.js/)
  expect(text).toMatch(/claude pid 100 \(claude\), reading \/proc through \$\.fs/)
})

test('a process the command left behind keeps its agent after its shell exits', async ($, on) => {
  const { procs, clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  procs.delete(200)
  procs.set(CLAUDE, { ...(procs.get(CLAUDE) as Fake), children: [300] })
  procs.set(201, { ...(procs.get(201) as Fake), ppid: 1 })
  await clock.advance(5000)
  expect(await usageText($)).toMatch(/\nmain +3\.0G .*\n {4}pid 201 /)
})

test('/agent-usage before any sample has run takes one', async ($, on) => {
  world(on)
  await startSession($)
  expect(await usageText($)).toMatch(/claude \(all loops\) +500M/)
})

const LIMITS = [
  ['a lower memory threshold warns sooner', { footer: 'alerts', memoryThresholdGB: 0.1 }, '⚠ claude (all loops) 500M 0%cpu · main 3.0G 0%cpu'],
  ['a higher one does not', { footer: 'alerts', memoryThresholdGB: 4 }, undefined],
] as const

for (const [name, options, expected] of LIMITS) {
  test(`userConfig: ${name}`, { options }, async ($, on) => {
    const { statuses, clock } = world(on)
    await startSession($)
    await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
    await clock.advance(5000)
    expect(statuses.at(-1)).toBe(expected)
  })
}

test('in the default footer mode, crossing a threshold marks the footer and pops up nothing', async ($, on) => {
  const { toasts, statuses, clock } = world(on)
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  await clock.advance(5000)
  expect(toasts).toEqual([])
  expect(statuses.filter(text => text !== undefined)).toEqual([])
})

test('when $.fs reads /proc empty, it is read through grep and find instead, and the table says so', async ($, on) => {
  const { clock, runs } = world(on, { isFsBlind: true })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true })
  await clock.advance(5000)
  const text = await usageText($)
  expect(text).toMatch(/\nmain +3\.0G .*\n {4}pid 201 +3\.0G +0% +node big\.js\n {4}pid 200 /)
  expect(text).toMatch(/claude pid 100 \(claude\), reading \/proc through grep\/find subprocesses \(\$\.fs\.read came back empty for \/proc\/self\/stat\)/)
  expect(new Set(runs.map(argv => argv[0]))).toEqual(new Set(['grep', 'find']))
})

test("a subagent's command is that agent's, under its name", async ($, on) => {
  const { clock } = world(on, { agents: [{ id: 'a1', name: 'integration-12', description: 'run tests', type: 'general-purpose', status: 'running' }] })
  await startSession($)
  await $.tool.call({ tool: 'Bash', command: COMMAND, run_in_background: true, agentId: 'a1' } as never)
  await clock.advance(5000)
  expect(await usageText($)).toMatch(/\nintegration-12 +3\.0G /)
})
