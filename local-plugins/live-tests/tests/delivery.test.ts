import { expect, test } from 'claude-code/testing'

import { agentNameOf, deliveryFor, withAgentNames } from '../hooks/delivery'

const agent = (id: string, status: string, name?: string) => ({ id, status, name, description: `task ${id}` })

const DELIVERIES = [
  ['main conversation run', null, [agent('a1', 'running')], { to: 'main' }],
  ['running subagent', 'a1', [agent('a1', 'running', 'worker-2')], { to: 'agent', agentId: 'a1' }],
  ['idle teammate still takes messages', 'a1', [agent('a1', 'idle')], { to: 'agent', agentId: 'a1' }],
  ['waiting subagent', 'a1', [agent('a1', 'waiting')], { to: 'agent', agentId: 'a1' }],
  ['pending subagent', 'a1', [agent('a1', 'pending')], { to: 'agent', agentId: 'a1' }],
  ['completed subagent: nobody', 'a1', [agent('a1', 'completed')], { to: 'nobody' }],
  ['failed subagent: nobody', 'a1', [agent('a1', 'failed')], { to: 'nobody' }],
  ['killed subagent: nobody', 'a1', [agent('a1', 'killed')], { to: 'nobody' }],
  ['subagent no longer listed: nobody', 'a1', [agent('a2', 'running')], { to: 'nobody' }],
] as const

for (const [name, agentId, agents, expected] of DELIVERIES) {
  test(`deliveryFor: ${name}`, () => {
    expect(deliveryFor(agentId, agents)).toEqual(expected)
  })
}

const NAMES = [
  ['its name', 'a1', [agent('a1', 'running', 'worker-2')], 'worker-2'],
  ['the Agent call description without a name', 'a1', [agent('a1', 'running')], 'task a1'],
  ['null for the main conversation', null, [agent('a1', 'running')], null],
  ['null when not listed', 'a9', [agent('a1', 'running')], null],
] as const

for (const [name, agentId, agents, expected] of NAMES) {
  test(`agentNameOf: ${name}`, () => {
    expect(agentNameOf(agentId, agents)).toBe(expected)
  })
}

test('withAgentNames fills in names that were not known when a run started', () => {
  const runs = [
    { id: 'r1', agentId: null, agentName: null },
    { id: 'r2', agentId: 'a1', agentName: null },
    { id: 'r3', agentId: 'a2', agentName: 'kept' },
    { id: 'r4', agentId: 'a9', agentName: null },
  ]
  expect(withAgentNames(runs, [agent('a1', 'running', 'worker-1'), agent('a2', 'running', 'other')])).toEqual([
    { id: 'r1', agentId: null, agentName: null },
    { id: 'r2', agentId: 'a1', agentName: 'worker-1' },
    { id: 'r3', agentId: 'a2', agentName: 'kept' },
    { id: 'r4', agentId: 'a9', agentName: null },
  ])
})
