import { expect, test } from 'claude-code/testing'

import type { BashRecord, Owner } from '../types'
import { attribute, envCandidates, pickRecord } from '../hooks/attribute'
import type { Proc } from '../hooks/attribute'

const BOOT_MS = 1_000_000
const HZ = 100
const CLAUDE = 100

/** Started `ms` after boot: a starttime of ms / 10 ticks. */
const proc = (pid: number, ppid: number, ms: number, argv?: readonly string[]): Proc => ({
  pid,
  comm: argv?.[0] ?? 'x',
  ppid,
  sid: 0,
  utime: 0,
  stime: 0,
  start: ms / 10,
  ...(argv === undefined ? {} : { argv }),
})

const toolBash = (command: string) => ['/bin/bash', '-c', `source s.sh && eval '${command.replaceAll("'", `'"'"'`)}' && pwd -P >| /tmp/claude-ab-cwd`]

const record = (id: string, agentId: string | null, command: string, startedAt: number, endedAt: number | null = null): BashRecord => ({
  id,
  agentId,
  command,
  startedAt: BOOT_MS + startedAt,
  endedAt: endedAt === null ? null : BOOT_MS + endedAt,
})

const snapshot = (procs: readonly Proc[], records: readonly BashRecord[], remembered: Record<string, Owner> = {}, reapers: readonly number[] = [], envAgents: ReadonlyMap<string, string | null> = new Map()) => ({
  envAgents,
  claudePid: CLAUDE,
  procs: new Map(procs.map(p => [p.pid, p])),
  records,
  remembered,
  bootMs: BOOT_MS,
  hz: HZ,
  reapers: new Set(reapers),
})

const ownersOf = (result: ReturnType<typeof attribute>) =>
  Object.fromEntries([...result.owners].map(([pid, owner]) => [pid, `${owner.agentId ?? 'main'}/${owner.via}`]))

test("a tool's bash and everything under it belong to the record's agent", () => {
  const result = attribute(
    snapshot(
      [proc(CLAUDE, 1, 0), proc(200, CLAUDE, 5000, toolBash("npm test -- -k 'a b'")), proc(201, 200, 5100), proc(202, 201, 5200)],
      [record('t1', 'a1', "npm test -- -k 'a b'", 4990)],
    ),
  )
  expect(ownersOf(result)).toEqual({ 200: 'a1/bash', 201: 'a1/tree', 202: 'a1/tree' })
  expect(Object.keys(result.remembered).sort()).toEqual(['200:500', '201:510', '202:520'])
})

test('the main conversation is agentId null', () => {
  const result = attribute(snapshot([proc(CLAUDE, 1, 0), proc(200, CLAUDE, 5000, toolBash('ls'))], [record('t1', null, 'ls', 4990)]))
  expect(ownersOf(result)).toEqual({ 200: 'main/bash' })
})

test("claude's other children (MCP servers, a bash with no record) and theirs are untracked", () => {
  const result = attribute(
    snapshot(
      [proc(CLAUDE, 1, 0), proc(300, CLAUDE, 10, ['node', 'mcp.js']), proc(301, 300, 20), proc(400, CLAUDE, 5000, toolBash('unknown'))],
      [record('t1', 'a1', 'ls', 4990)],
    ),
  )
  expect(ownersOf(result)).toEqual({})
  expect([...result.untracked].sort()).toEqual([300, 301, 400])
})

test('a process reparented away from its bash keeps its agent, and so do children it forks later', () => {
  const remembered: Record<string, Owner> = { '201:510': { agentId: 'a1', command: 'make serve', via: 'tree' } }
  const result = attribute(snapshot([proc(CLAUDE, 1, 0), proc(201, 1, 5100), proc(210, 201, 9000)], [record('t1', 'a1', 'make serve', 4990, 5300)], remembered))
  expect(ownersOf(result)).toEqual({ 201: 'a1/tree', 210: 'a1/tree' })
  expect(Object.keys(result.remembered).sort()).toEqual(['201:510', '210:900'])
})

test('a remembered pid reused by a new process is forgotten', () => {
  const remembered: Record<string, Owner> = { '201:510': { agentId: 'a1', command: 'make', via: 'tree' } }
  const result = attribute(snapshot([proc(CLAUDE, 1, 0), proc(201, 1, 80_000)], [], remembered))
  expect(ownersOf(result)).toEqual({})
  expect(result.remembered).toEqual({})
})

const SETSID = [
  ['one record whose command holds every argument, started in its window', [record('t1', 'a1', 'setsid python -m http.server 8000 &', 4990, 5300)], { 500: 'a1/heuristic', 501: 'a1/heuristic' }],
  ['two records match: unknown', [record('t1', 'a1', 'setsid python -m http.server 8000 &', 4990, 5300), record('t2', 'a2', 'nohup python -m http.server 8000', 4995, 5400)], {}],
  ['started after the window', [record('t1', 'a1', 'setsid python -m http.server 8000 &', 1000, 2000)], {}],
  ['an argument missing from the command', [record('t1', 'a1', 'setsid python -m http.server 9000 &', 4990, 5300)], {}],
  ['a background record is open ended', [record('t1', 'a1', 'setsid python -m http.server 8000 &', 1000)], { 500: 'a1/heuristic', 501: 'a1/heuristic' }],
] as const

for (const [name, records, expected] of SETSID) {
  test(`setsid heuristic: ${name}`, () => {
    const procs = [proc(CLAUDE, 1, 0), proc(50, 1, 10, ['systemd', '--user']), proc(500, 50, 5050, ['python', '-m', 'http.server', '8000']), proc(501, 500, 5060)]
    expect(ownersOf(attribute(snapshot(procs, records, {}, [1, 50])))).toEqual(expected)
  })
}

test('the setsid heuristic leaves alone a process that is already known', () => {
  const remembered: Record<string, Owner> = { '500:505': { agentId: 'a2', command: 'x', via: 'bash' } }
  const procs = [proc(CLAUDE, 1, 0), proc(50, 1, 10, ['systemd']), proc(500, 50, 5050, ['python', '-m', 'http.server', '8000'])]
  const records = [record('t1', 'a1', 'python -m http.server 8000', 4990, 5300)]
  expect(ownersOf(attribute(snapshot(procs, records, remembered, [50])))).toEqual({ 500: 'a2/bash' })
})

const PICKS = [
  ['the one with that command', [record('t1', 'a1', 'ls', 100), record('t2', 'a2', 'pwd', 200)], 'pwd', 210, 't2'],
  ['same command twice: the latest started before the process', [record('t1', 'a1', 'npm test', 100), record('t2', 'a2', 'npm test', 5000)], 'npm test', 150, 't1'],
  ['same command twice, process after both', [record('t1', 'a1', 'npm test', 100), record('t2', 'a2', 'npm test', 5000)], 'npm test', 5010, 't2'],
  ['clock skew: the process looks older than every record', [record('t1', 'a1', 'npm test', 900)], 'npm test', 100, 't1'],
  ['no such command', [record('t1', 'a1', 'ls', 100)], 'pwd', 210, undefined],
] as const

for (const [name, records, command, startedMs, expected] of PICKS) {
  test(`pickRecord: ${name}`, () => {
    expect(pickRecord(records, command, BOOT_MS + startedMs)?.id).toBe(expected)
  })
}

test('a server started through a wrapper (npx → node → java) counts toward the agent whose Bash started it', () => {
  const result = attribute(
    snapshot(
      [
        proc(CLAUDE, 1, 0),
        proc(200, CLAUDE, 5000, toolBash('npx shadow-cljs watch app')),
        proc(201, 200, 5100, ['npm', 'exec', 'shadow-cljs', 'watch', 'app']),
        proc(202, 201, 5200, ['node', '/x/shadow-cljs/cli/runner.js', 'watch', 'app']),
        proc(203, 202, 5300, ['java', '-cp', 'shadow-cljs.jar', 'clojure.main', '-m', 'shadow.cljs.devtools.cli', 'watch', 'app']),
      ],
      [record('t1', 'a1', 'npx shadow-cljs watch app', 4990)],
    ),
  )
  expect(ownersOf(result)).toEqual({ 200: 'a1/bash', 201: 'a1/tree', 202: 'a1/tree', 203: 'a1/tree' })
})

test('the wrapper exiting leaves the server its agent: the grandchild, reparented, is remembered', () => {
  const first = attribute(
    snapshot(
      [proc(CLAUDE, 1, 0), proc(200, CLAUDE, 5000, toolBash('npx shadow-cljs watch app &')), proc(201, 200, 5100, ['npm', 'exec']), proc(203, 201, 5300, ['java', 'shadow'])],
      [record('t1', 'a1', 'npx shadow-cljs watch app &', 4990, 5400)],
    ),
  )
  const later = attribute(snapshot([proc(CLAUDE, 1, 0), proc(203, 1, 5300, ['java', 'shadow'])], [record('t1', 'a1', 'npx shadow-cljs watch app &', 4990, 5400)], first.remembered))
  expect(ownersOf(later)).toEqual({ 203: 'a1/tree' })
})

/** claude; a Bash shell of main's (200) with a run under it (201); a live-tests run claude started itself (300); one outside claude's tree (400). */
const ENV_PROCS = [
  proc(CLAUDE, 1, 0),
  proc(200, CLAUDE, 5000, toolBash('ls')),
  proc(201, 200, 5100, ['bun', 'test']),
  proc(300, CLAUDE, 6000, ['bun', 'test', 'x']),
  proc(400, 1, 7000, ['bun', 'test', 'y']),
]
const ENV_RECORDS = [record('t1', null, 'ls', 4990)]

const ENV_CASES = [
  ["an agent id in environ moves main's process, and an untracked one, to that agent", new Map([['201:510', 'a1'], ['300:600', 'a1']]), { 200: 'main/bash', 201: 'a1/env', 300: 'a1/env' }, []],
  ['no variable (null): no change', new Map([['201:510', null], ['300:600', null]]), { 200: 'main/bash', 201: 'main/tree' }, [300]],
  ['a process outside claude\'s tree and not remembered is never moved', new Map([['400:700', 'a1']]), { 200: 'main/bash', 201: 'main/tree' }, [300]],
] as const

for (const [name, envAgents, owners, untracked] of ENV_CASES) {
  test(`environ: ${name}`, () => {
    const result = attribute(snapshot(ENV_PROCS, ENV_RECORDS, {}, [], envAgents))
    expect([ownersOf(result), result.untracked]).toEqual([owners, untracked])
  })
}

test('environ: an agent named in environ is remembered by pid:starttime, and stays after the process is reparented', () => {
  const first = attribute(snapshot(ENV_PROCS, ENV_RECORDS, {}, [], new Map([['300:600', 'a1']])))
  expect(first.remembered['300:600']).toEqual({ agentId: 'a1', command: 'bun test x', via: 'env' })
  const later = attribute(snapshot([proc(CLAUDE, 1, 0), { ...proc(300, 1, 6000, ['bun', 'test', 'x']) }], [], first.remembered))
  expect(ownersOf(later)).toEqual({ 300: 'a1/env' })
})

test("environ: a remembered main process outside claude's tree is checked too", () => {
  const remembered = { '400:700': { agentId: null, command: 'bun test y', via: 'heuristic' as const } }
  const result = attribute(snapshot([proc(CLAUDE, 1, 0), proc(400, 1, 7000, ['bun', 'test', 'y'])], [], remembered, [], new Map([['400:700', 'a2']])))
  expect(ownersOf(result)).toEqual({ 400: 'a2/env' })
})

test("envCandidates: claude's tree and remembered processes owned by main or by no record; not a subagent's, not claude, not strangers", () => {
  const remembered = { '400:700': { agentId: null, command: 'bun test y', via: 'heuristic' as const } }
  const procs = [...ENV_PROCS, proc(500, CLAUDE, 8000, toolBash('make')), proc(600, 1, 9000, ['stranger'])]
  const snap = snapshot(procs, [...ENV_RECORDS, record('t2', 'a9', 'make', 7990)], remembered)
  expect(envCandidates(snap, attribute(snap)).sort()).toEqual([200, 201, 300, 400])
})

test("environ: the labelled runner and its tree move, the suite's unlabelled shells above it stay", () => {
  // claude → suite bash (300, no label) → (echo start …) subshell (301, no label) → runner (302, label) → worker (303, label stripped)
  const procs = [proc(CLAUDE, 1, 0), proc(300, CLAUDE, 6000, ['bash', '-c', 'suite']), proc(301, 300, 6010, ['bash']), proc(302, 301, 6020, ['pytest']), proc(303, 302, 6030, ['python', 'worker'])]
  const envAgents = new Map([['300:600', null], ['301:601', null], ['302:602', 'a1'], ['303:603', null]])
  const result = attribute(snapshot(procs, [], {}, [], envAgents))
  expect([ownersOf(result), result.untracked]).toEqual([{ 302: 'a1/env', 303: 'a1/env' }, [300, 301]])
})
