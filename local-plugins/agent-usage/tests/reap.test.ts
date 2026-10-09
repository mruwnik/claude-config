import { expect, test } from 'claude-code/testing'

import { bashFailure, dryRunResult, endedSince, killCommand, nothingLeftResult, reapNotice, reapOptions, reapResult, recheck, selectTargets } from '../hooks/reap'
import type { ReapTarget } from '../hooks/reap'
import type { JsonInput } from '../hooks/report'
import type { AgentUsage, ProcUsage } from '../hooks/usage'

const MB = 1024 * 1024
const AT = Date.UTC(2026, 9, 6, 12, 0, 0)
const CLAUDE_PID = 100

const proc = (pid: number, pssMb: number, command: string, start = pid * 10): ProcUsage => ({ pid, procKey: `${pid}:${start}`, command, pss: pssMb * MB, rss: pssMb * MB, cpu: 0, startedMs: AT - 1000 })

const usage = (key: string, procs: readonly ProcUsage[]): AgentUsage => ({ key, pss: procs.reduce((sum, p) => sum + p.pss, 0), rss: 0, cpu: 0, procs: [...procs] })

const agent = (id: string, status: string, name: string) => ({ id, status, name, description: `task ${id}` })

/** A stopped agent with a big leftover, a gone one, a live one, main, claude itself and an untracked MCP server. */
const world = (): JsonInput => ({
  at: AT,
  mem: undefined,
  floorMb: null,
  usages: [
    usage('claude', [proc(CLAUDE_PID, 500, 'claude')]),
    usage('main', [proc(200, 1, 'bash -c ls')]),
    usage('a1', [proc(300, 3400, 'java shadow-cljs watch app'), proc(301, 300, 'node npx shadow-cljs')]),
    usage('a2', [proc(400, 20, 'bash -c "while true; do bun test; done"')]),
    usage('a3', [proc(500, 10, 'sleep 100')]),
    usage('other', [proc(600, 50, 'node mcp.js')]),
  ],
  agents: [agent('a1', 'completed', 'fixer-1'), agent('a3', 'running', 'live-one'), agent('a4', 'killed', 'twin'), agent('a5', 'completed', 'twin')],
  names: { a1: 'fixer-1', a2: 'old-loop', a3: 'live-one', a4: 'twin', a5: 'twin', a6: 'ghost' },
  history: {},
  maxima: {},
  firstSeen: {},
  load: undefined,
  tokens: { main: { tokens: 1, cacheReadTokens: 0, byModel: {} }, a7: { tokens: 5, cacheReadTokens: 0, byModel: {} } },
})

const target = (pid: number, pssMb: number, cmd: string, start = pid * 10): ReapTarget => ({ pid, key: `${pid}:${start}`, cmd, pssMb })

const SELECTED = [
  ['a stopped agent by name: its unattributed processes, biggest first', 'fixer-1', { agent: 'fixer-1', id: 'a1', targets: [target(300, 3400, 'java shadow-cljs watch app'), target(301, 300, 'node npx shadow-cljs')], skipped: [] }],
  ['a stopped agent by id', 'a1', { agent: 'fixer-1', id: 'a1', targets: [target(300, 3400, 'java shadow-cljs watch app'), target(301, 300, 'node npx shadow-cljs')], skipped: [] }],
  ['a gone agent (no longer listed)', 'old-loop', { agent: 'old-loop', id: 'a2', targets: [target(400, 20, 'bash -c "while true; do bun test; done"')], skipped: [] }],
  ['a stopped agent with nothing left', 'a5', { agent: 'twin', id: 'a5', targets: [], skipped: [] }],
  ['an agent seen once (its name kept), no longer listed, nothing left: by name', 'ghost', { agent: 'ghost', id: 'a6', targets: [], skipped: [] }],
  ['an agent seen once, no longer listed, nothing left: by id', 'a6', { agent: 'ghost', id: 'a6', targets: [], skipped: [] }],
  ['an agent known only by its tokens', 'a7', { agent: 'a7', id: 'a7', targets: [], skipped: [] }],
] as const

for (const [name, asked, expected] of SELECTED) {
  test(`selectTargets: ${name}`, () => {
    expect(selectTargets(world(), asked, CLAUDE_PID)).toEqual(expected)
  })
}

const REFUSED = [
  ['a live agent', 'live-one', { agent: 'live-one', error: 'live-one is running: only a stopped or gone agent\'s leftovers are reaped' }],
  ['main', 'main', { agent: 'main', error: 'refusing main: the main conversation\'s processes are never reaped' }],
  ['claude itself', 'claude', { agent: 'claude', error: 'refusing claude itself' }],
  ['the untracked (no record) row', 'other', { agent: 'other', error: 'refusing "no record" processes: no agent is known to own them' }],
  ['an unknown agent', 'nobody', { agent: 'nobody', error: 'no agent "nobody"' }],
  ['a name two agents share', 'twin', { agent: 'twin', error: '"twin" names 2 agents (a4, a5): pass an id' }],
] as const

for (const [name, asked, expected] of REFUSED) {
  test(`selectTargets refuses ${name}`, () => {
    expect(selectTargets(world(), asked, CLAUDE_PID)).toEqual(expected)
  })
}

test('selectTargets never takes claude itself or init, even listed under a stopped agent', () => {
  const odd = { ...world(), usages: [usage('a1', [proc(CLAUDE_PID, 500, 'claude'), proc(1, 1, '/sbin/init'), proc(300, 3400, 'java')])] }
  expect(selectTargets(odd, 'a1', CLAUDE_PID)).toEqual({
    agent: 'fixer-1',
    id: 'a1',
    targets: [target(300, 3400, 'java')],
    skipped: [{ pid: CLAUDE_PID, reason: 'claude itself' }, { pid: 1, reason: 'init' }],
  })
})

test("selectTargets never takes an untracked process, though it is listed under unattributed", () => {
  const picked = selectTargets(world(), 'a1', CLAUDE_PID)
  expect(JSON.stringify(picked).includes('mcp.js')).toBe(false)
})

const statOf = (pid: number, start: number) => new Map([[pid, { pid, comm: 'x', ppid: 1, sid: 0, utime: 0, stime: 0, start }]])

const RECHECKS = [
  ['still the same process: alive', statOf(300, 3000), { alive: [target(300, 3400, 'java', 3000)], skipped: [] }],
  ['no stat: already gone', new Map(), { alive: [], skipped: [{ pid: 300, reason: 'already gone' }] }],
  ['another starttime: the pid was reused', statOf(300, 3001), { alive: [], skipped: [{ pid: 300, reason: 'pid reused' }] }],
] as const

for (const [name, stats, expected] of RECHECKS) {
  test(`recheck: ${name}`, () => {
    expect(recheck([target(300, 3400, 'java', 3000)], stats)).toEqual(expected)
  })
}

const COMMANDS = [
  ['TERM first', 'TERM', [target(300, 1, 'a'), target(301, 1, 'b')], 'kill -TERM 300 301'],
  ['KILL to the survivors', 'KILL', [target(301, 1, 'b')], 'kill -KILL 301'],
  ['nobody left: no command', 'KILL', [], undefined],
] as const

for (const [name, signal, targets, expected] of COMMANDS) {
  test(`killCommand: ${name}`, () => {
    expect(killCommand(signal, targets)).toBe(expected)
  })
}

const FAILURES = [
  ['a deny', { deny: 'not allowed' }, 'not allowed'],
  ['an errored result', { result: 'x', isError: true, text: 'The user rejected it' }, 'The user rejected it'],
  ['an errored result without text', { result: 'x', isError: true }, 'the Bash call failed'],
  ['a plain result', { result: { stdout: '', stderr: '' }, text: '' }, undefined],
] as const

for (const [name, result, expected] of FAILURES) {
  test(`bashFailure: ${name}`, () => {
    expect(bashFailure(result)).toBe(expected)
  })
}

test('reapResult: killed are those sent a signal that are gone now; survived the rest', () => {
  const sent = [target(300, 3400, 'java'), target(301, 300, 'node')]
  expect(reapResult('fixer-1', sent, [target(301, 300, 'node')], [{ pid: 302, reason: 'pid reused' }])).toEqual({
    agent: 'fixer-1',
    killed: [{ pid: 300, cmd: 'java', pssMb: 3400 }],
    survived: [{ pid: 301, cmd: 'node', pssMb: 300 }],
    skipped: [{ pid: 302, reason: 'pid reused' }],
  })
})

test('dryRunResult says what would be killed', () => {
  expect(dryRunResult('fixer-1', [target(300, 3400, 'java')], [])).toEqual({ agent: 'fixer-1', dryRun: true, wouldKill: [{ pid: 300, cmd: 'java', pssMb: 3400 }], skipped: [] })
})

const OPTIONS = [
  ['an agent', { agent: 'fixer-1' }, { agent: 'fixer-1', dryRun: false }],
  ['a dry run', { agent: 'a1', dryRun: true }, { agent: 'a1', dryRun: true }],
  ['no agent', { dryRun: true }, { dryRun: true }],
  ['nonsense', { agent: 3, dryRun: 'yes' }, { dryRun: false }],
  ['not an object', 'x', { dryRun: false }],
] as const

for (const [name, raw, expected] of OPTIONS) {
  test(`reapOptions: ${name}`, () => {
    expect(reapOptions(raw)).toEqual(expected)
  })
}

const ENDED = [
  ['live to stopped', [agent('a1', 'running', 'x')], [agent('a1', 'completed', 'x')], ['a1']],
  ['live to gone', [agent('a1', 'idle', 'x')], [], ['a1']],
  ['still live', [agent('a1', 'running', 'x')], [agent('a1', 'idle', 'x')], []],
  ['stopped before: not again', [agent('a1', 'completed', 'x')], [], []],
  ['new and already stopped: never seen live', [], [agent('a1', 'completed', 'x')], []],
] as const

for (const [name, prev, now, expected] of ENDED) {
  test(`endedSince: ${name}`, () => {
    expect(endedSince(prev, now)).toEqual(expected)
  })
}

test('reapNotice lists what was killed, and says nothing when nothing was', () => {
  const result = reapResult('fixer-1', [target(300, 3400, 'java shadow-cljs'), target(301, 300, 'node')], [target(301, 300, 'node')], [])
  expect(reapNotice(result)).toBe(
    '<agent-usage-notice>\nReaped 1 leftover process of stopped agent fixer-1 (reapOnStop): pid 300 java shadow-cljs 3.3G. Still alive: pid 301.\n</agent-usage-notice>',
  )
  expect(reapNotice(reapResult('fixer-1', [], [], []))).toBeUndefined()
})

const NOTHING_LEFT = [
  ['a reap', false, [], { agent: 'fixer-1', killed: [], note: 'nothing left to reap' }],
  ['a dry run', true, [], { agent: 'fixer-1', dryRun: true, wouldKill: [], note: 'nothing left to reap' }],
  ['a reap whose targets all went before the recheck', false, [{ pid: 300, reason: 'already gone' }], { agent: 'fixer-1', killed: [], note: 'nothing left to reap', skipped: [{ pid: 300, reason: 'already gone' }] }],
] as const

for (const [name, isDryRun, skipped, expected] of NOTHING_LEFT) {
  test(`nothingLeftResult: ${name}`, () => {
    expect(nothingLeftResult('fixer-1', isDryRun, skipped)).toEqual(expected)
  })
}
