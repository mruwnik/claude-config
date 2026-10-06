import type { BashRecord, Owner } from '../types'
import { evalCommand } from './proc'
import type { Stat } from './proc'

/** A process as sampled: its stat, and its argv where it was read. */
export type Proc = Stat & { argv?: readonly string[] }

export type Snapshot = {
  claudePid: number
  procs: ReadonlyMap<number, Proc>
  records: readonly BashRecord[]
  /** `pid:starttime` → owner, from earlier samples. */
  remembered: Readonly<Record<string, Owner>>
  bootMs: number
  hz: number
  /** Processes orphans are reparented to (init, the user's systemd); empty when the sample did not scan every process. */
  reapers: ReadonlySet<number>
  /** `pid:starttime` → the agent its environ names, null for none; read only for envCandidates. */
  envAgents?: ReadonlyMap<string, string | null>
}

export type Attribution = {
  owners: ReadonlyMap<number, Owner>
  remembered: Record<string, Owner>
  /** claude's descendants that no Bash record owns: MCP servers, language servers, a bash from before the mod loaded. */
  untracked: readonly number[]
}

/** Clock ticks and wall clock disagree by a little; a process may look started slightly before its record. */
export const SLACK_MS = 500

export const procKey = (proc: { pid: number; start: number }) => `${proc.pid}:${proc.start}`

export const startedMs = (proc: { start: number }, bootMs: number, hz: number) => bootMs + (proc.start / hz) * 1000

const childrenMap = (procs: ReadonlyMap<number, Proc>) => {
  const kids = new Map<number, number[]>()
  procs.forEach(proc => kids.set(proc.ppid, [...(kids.get(proc.ppid) ?? []), proc.pid]))
  return kids
}

const descendants = (root: number, kids: ReadonlyMap<number, readonly number[]>): number[] => [
  root,
  ...(kids.get(root) ?? []).flatMap(child => descendants(child, kids)),
]

/** The record a Bash tool shell running `command` belongs to: of those with that command, the latest started before it. */
export const pickRecord = (records: readonly BashRecord[], command: string, procStartedMs: number) => {
  const same = records.filter(r => r.command === command)
  const before = same.filter(r => r.startedAt <= procStartedMs + SLACK_MS)
  const latest = (list: readonly BashRecord[]) => list.reduce<BashRecord | undefined>((best, r) => (best === undefined || r.startedAt > best.startedAt ? r : best), undefined)
  return latest(before) ?? latest(same)
}

/** The one record a reparented process was likely started by: its every argument in the command, its start in the call's window. */
const heuristicRecord = (proc: Proc, records: readonly BashRecord[], procStartedMs: number) => {
  const argv = (proc.argv ?? []).map(arg => arg.trim()).filter(arg => arg !== '')
  if (argv.length === 0) return undefined
  const tokens = argv.length > 1 ? argv.slice(1) : argv
  const hits = records.filter(
    r =>
      r.startedAt - SLACK_MS <= procStartedMs &&
      procStartedMs <= (r.endedAt ?? Infinity) + SLACK_MS &&
      tokens.every(token => r.command.includes(token)),
  )
  return hits.length === 1 ? hits[0] : undefined
}

/** Processes whose environ may name their agent: in claude's tree or remembered, and owned by main or by no record. */
const envCandidatesOf = (snap: Snapshot, kids: ReadonlyMap<number, readonly number[]>, owners: ReadonlyMap<number, Owner>) => {
  const tree = descendants(snap.claudePid, kids).filter(pid => pid !== snap.claudePid)
  const rememberedPids = Object.keys(snap.remembered).flatMap(key => {
    const proc = snap.procs.get(Number(key.split(':')[0]))
    return proc !== undefined && procKey(proc) === key ? [proc.pid] : []
  })
  return [...new Set([...tree, ...rememberedPids])].filter(pid => pid !== snap.claudePid && (owners.get(pid)?.agentId ?? null) === null)
}

/** The processes whose environ the sampler should read, given what attribution made of them without it. */
export const envCandidates = (snap: Snapshot, found: Attribution) => envCandidatesOf(snap, childrenMap(snap.procs), found.owners)

/**
 * Who owns each sampled process. In order, the first answer kept: a Bash tool shell under
 * claude and its tree; a process remembered from an earlier sample (alive with the same
 * starttime) and its tree now; an orphan of a reaper that one record alone explains. Last, a
 * process of main's or of no record whose environ names an agent goes to that agent.
 */
export const attribute = (snap: Snapshot): Attribution => {
  const kids = childrenMap(snap.procs)
  const owners = new Map<number, Owner>()
  const claim = (root: number, owner: Owner, treeVia: Owner['via']) =>
    descendants(root, kids).forEach(pid => {
      if (!owners.has(pid)) owners.set(pid, pid === root ? owner : { ...owner, via: treeVia })
    })

  const direct = (kids.get(snap.claudePid) ?? []).map(pid => snap.procs.get(pid)).filter(p => p !== undefined)
  direct.forEach(proc => {
    const command = evalCommand(proc.argv ?? [])
    const rec = command === undefined ? undefined : pickRecord(snap.records, command, startedMs(proc, snap.bootMs, snap.hz))
    if (rec !== undefined) claim(proc.pid, { agentId: rec.agentId, command: rec.command, via: 'bash' }, 'tree')
  })

  Object.entries(snap.remembered).forEach(([key, owner]) => {
    const proc = snap.procs.get(Number(key.split(':')[0]))
    if (proc === undefined || procKey(proc) !== key) return
    claim(proc.pid, owner, owner.via === 'bash' ? 'tree' : owner.via)
  })

  ;[...snap.procs.values()]
    .filter(proc => snap.reapers.has(proc.ppid) && proc.pid !== snap.claudePid && !owners.has(proc.pid))
    .forEach(proc => {
      const rec = heuristicRecord(proc, snap.records, startedMs(proc, snap.bootMs, snap.hz))
      if (rec !== undefined) claim(proc.pid, { agentId: rec.agentId, command: rec.command, via: 'heuristic' }, 'heuristic')
    })

  // The engine runs plugins' tool calls in the main loop, so a subagent's run_tests looks like main's: its environ says whose.
  envCandidatesOf(snap, kids, owners).forEach(pid => {
    const proc = snap.procs.get(pid)
    const agentId = proc === undefined ? undefined : snap.envAgents?.get(procKey(proc))
    if (proc === undefined || typeof agentId !== 'string') return
    // Only the runner and what it starts carry the label (live-tests exports it inside the step's subshell): its tree
    // goes with it, never the unlabelled shells above it.
    descendants(pid, kids).forEach(d => {
      const owner = owners.get(d)
      if (d !== pid && owner !== undefined && owner.agentId !== null) return
      const argv = snap.procs.get(d)?.argv ?? []
      owners.set(d, { agentId, command: owner?.command ?? argv.join(' '), via: 'env' })
    })
  })

  const remembered = Object.fromEntries(
    [...owners].flatMap(([pid, owner]) => {
      const proc = snap.procs.get(pid)
      return proc === undefined ? [] : [[procKey(proc), owner] as const]
    }),
  )
  const untracked = descendants(snap.claudePid, kids).filter(pid => pid !== snap.claudePid && !owners.has(pid))
  return { owners, remembered, untracked }
}
