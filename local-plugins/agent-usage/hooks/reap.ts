import { procKey } from './attribute'
import type { Stat } from './proc'
import { agentName, LIVE, statusOf, usageJson } from './report'
import type { AgentRef, JsonInput } from './report'
import { CLAUDE, formatBytes, MAIN, OTHER } from './view'

const MB = 1024 * 1024

/** A process agent_reap may signal: its pid, the `pid:starttime` it was sampled with, and what to report of it. */
export type ReapTarget = { pid: number; key: string; cmd: string; pssMb: number }

export type Skip = { pid: number; reason: string }

export type Selection = { agent: string; error: string } | { agent: string; id: string; targets: ReapTarget[]; skipped: Skip[] }

export type ReapOptions = { agent?: string; dryRun: boolean }

/** The tool's arguments: `agent` only when a non-empty string, `dryRun` only when true. */
export const reapOptions = (raw: unknown): ReapOptions => {
  if (typeof raw !== 'object' || raw === null) return { dryRun: false }
  const args = raw as Record<string, unknown>
  const agent = typeof args.agent === 'string' && args.agent !== '' ? { agent: args.agent } : {}
  return { ...agent, dryRun: args.dryRun === true }
}

const REFUSED: Readonly<Record<string, string>> = {
  [MAIN]: "refusing main: the main conversation's processes are never reaped",
  [CLAUDE]: 'refusing claude itself',
  [OTHER]: 'refusing "no record" processes: no agent is known to own them',
}

const ENDED_REASONS: readonly string[] = ['agent stopped', 'agent gone']

/**
 * What agent_reap may kill for `asked` (a name or id): exactly the processes agent_usage lists
 * under `unattributed` for that agent with reason "agent stopped" or "agent gone", never claude
 * itself or init. Any agent seen counts: in a row, the listing, the names kept or the tokens. Refuses main,
 * claude, the untracked row, a live agent, a name never seen or an ambiguous one.
 */
export const selectTargets = (input: JsonInput, asked: string, claudePid: number): Selection => {
  const refusal = REFUSED[asked]
  if (refusal !== undefined) return { agent: asked, error: refusal }
  // Every agent the mod has seen: one stopped with nothing left has no row and may be listed no more.
  const seen = [...input.usages.map(u => u.key), ...input.agents.map(a => a.id), ...Object.keys(input.names), ...Object.keys(input.tokens)]
  const keys = [...new Set(seen.filter(key => REFUSED[key] === undefined))]
  const matches = keys.filter(key => key === asked || agentName(key, input) === asked)
  const [id] = matches
  if (id === undefined) return { agent: asked, error: `no agent "${asked}"` }
  if (matches.length > 1) return { agent: asked, error: `"${asked}" names ${matches.length} agents (${matches.join(', ')}): pass an id` }
  const name = agentName(id, input)
  const status = statusOf(id, input.agents)
  if (status !== 'stopped' && status !== 'gone') return { agent: name, error: `${name} is ${status}: only a stopped or gone agent's leftovers are reaped` }
  const sampled = input.usages.find(u => u.key === id)?.procs ?? []
  const listed = usageJson(input).unattributed.procs.filter(p => p.id === id && ENDED_REASONS.includes(p.reason))
  const unsafe = (pid: number) => (pid === claudePid ? 'claude itself' : pid <= 1 ? 'init' : undefined)
  const skipped = listed.flatMap(p => {
    const reason = unsafe(p.pid)
    return reason === undefined ? [] : [{ pid: p.pid, reason }]
  })
  const targets = listed
    .filter(p => unsafe(p.pid) === undefined)
    .flatMap(p => {
      const key = sampled.find(s => s.pid === p.pid)?.procKey
      return key === undefined ? [] : [{ pid: p.pid, key, cmd: p.cmd, pssMb: p.pssMb }]
    })
  return { agent: name, id, targets, skipped }
}

/** Which targets are still the very process sampled (same pid and starttime); the rest skipped, gone or reused. */
export const recheck = (targets: readonly ReapTarget[], stats: ReadonlyMap<number, Stat>) => {
  const verdict = (t: ReapTarget) => {
    const stat = stats.get(t.pid)
    if (stat === undefined) return 'already gone'
    return procKey(stat) === t.key ? undefined : 'pid reused'
  }
  const judged = targets.map(t => ({ t, reason: verdict(t) }))
  return {
    alive: judged.filter(j => j.reason === undefined).map(j => j.t),
    skipped: judged.flatMap(j => (j.reason === undefined ? [] : [{ pid: j.t.pid, reason: j.reason }])),
  }
}

/** The command sent through the Bash tool; pids are numbers, so nothing else can ride along. None for no one. */
export const killCommand = (signal: 'TERM' | 'KILL', targets: readonly ReapTarget[]) =>
  targets.length === 0 ? undefined : `kill -${signal} ${targets.map(t => t.pid).join(' ')}`

/** Why a Bash call failed: a deny (the permission check, a hook) or an errored result; undefined when it ran. */
export const bashFailure = (result: { deny?: string; isError?: boolean; text?: string }) => {
  if (result.deny !== undefined) return result.deny
  return result.isError === true ? (result.text ?? 'the Bash call failed') : undefined
}

const shown = (t: ReapTarget) => ({ pid: t.pid, cmd: t.cmd, pssMb: t.pssMb })

export type ReapResult = { agent: string; killed: ReturnType<typeof shown>[]; survived: ReturnType<typeof shown>[]; skipped: Skip[] }

/** What agent_reap answers: of those sent a signal, the ones gone now are killed, the rest survived. */
export const reapResult = (agent: string, sent: readonly ReapTarget[], survivors: readonly ReapTarget[], skipped: readonly Skip[]): ReapResult => ({
  agent,
  killed: sent.filter(t => !survivors.some(s => s.pid === t.pid)).map(shown),
  survived: survivors.map(shown),
  skipped: [...skipped],
})

export const NOTHING_LEFT = 'nothing left to reap'

/** What agent_reap answers for a known stopped or gone agent with no leftovers: nothing to kill, and why; `skipped` only when some are. */
export const nothingLeftResult = (agent: string, isDryRun: boolean, skipped: readonly Skip[]) => ({
  agent,
  ...(isDryRun ? { dryRun: true, wouldKill: [] } : { killed: [] }),
  note: NOTHING_LEFT,
  ...(skipped.length === 0 ? {} : { skipped: [...skipped] }),
})

export const dryRunResult = (agent: string, targets: readonly ReapTarget[], skipped: readonly Skip[]) => ({ agent, dryRun: true, wouldKill: targets.map(shown), skipped: [...skipped] })

/** The agents live in the last listing that are stopped or no longer listed in this one. */
export const endedSince = (prev: readonly AgentRef[], now: readonly AgentRef[]) =>
  prev.filter(a => LIVE.includes(a.status) && ['stopped', 'gone'].includes(statusOf(a.id, now))).map(a => a.id)

const NOTICE_CMD = 40

/** The notice for the main conversation after reapOnStop killed something; none when it killed nothing. */
export const reapNotice = (result: ReapResult) => {
  const n = result.killed.length
  if (n === 0) return undefined
  const list = result.killed.map(k => `pid ${k.pid} ${k.cmd.slice(0, NOTICE_CMD)} ${formatBytes(k.pssMb * MB)}`).join(', ')
  const left = result.survived.length === 0 ? '' : ` Still alive: ${result.survived.map(s => `pid ${s.pid}`).join(', ')}.`
  return `<agent-usage-notice>\nReaped ${n} leftover process${n === 1 ? '' : 'es'} of stopped agent ${result.agent} (reapOnStop): ${list}.${left}\n</agent-usage-notice>`
}
