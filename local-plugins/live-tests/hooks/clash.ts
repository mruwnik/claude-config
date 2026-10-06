import type { RunRecord } from '../types'
import { formatDuration } from './duration'
import { countsLine } from './summary'

export type Concurrency = 'args' | 'exclusive' | 'any'

export const CONCURRENCY_MODES: readonly Concurrency[] = ['args', 'exclusive', 'any']

/** How many finished runs of a suite keep their log and events files. */
export const KEPT_RUNS = 10

export const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((arg, i) => arg === b[i])

type Wanted = { root: string; suite: string; args: readonly string[] }

/** The running run a new one may not overlap, if any; runs whose process is gone never block. */
export const findClash = (list: readonly RunRecord[], want: Wanted, concurrency: Concurrency, dead: readonly string[]) => {
  if (concurrency === 'any') return undefined
  return list.find(
    r =>
      r.outcome === 'running' &&
      !dead.includes(r.id) &&
      r.root === want.root &&
      r.suite === want.suite &&
      (concurrency === 'exclusive' || sameArgs(r.args ?? [], want.args)),
  )
}

const holderName = (run: RunRecord) => {
  if (run.agentId === null) return 'the main conversation'
  return run.agentName === null ? 'a subagent' : `[${run.agentName}]`
}

type ReplyFields = { holder: RunRecord; callerAgentId: string | null; now: number }

/** Why a run was refused: whose run holds it and how far it is, and what to do instead of stopping it or using Bash. */
export const clashReply = ({ holder, callerAgentId, now }: ReplyFields) => {
  const args = holder.args ?? []
  const isOwn = holder.agentId === callerAgentId
  const who = isOwn ? 'you' : holderName(holder)
  const how = holder.taskId === null ? 'in the foreground' : `background task ${holder.taskId}`
  const log = holder.logs[holder.stepIndex] ?? holder.logs[0] ?? ''
  const state = `${how}, started ${formatDuration(now - holder.startedAt)} ago; results so far: ${countsLine(holder.counts)}; log ${log}`
  const what = isOwn ? 'It is your own run: wait for its summary.' : `It belongs to ${who}, so don't stop it: wait for its summary or ask that agent.`
  return [
    `Suite ${holder.suite}${args.length > 0 ? ` with args ${JSON.stringify(args)}` : ''} is already running for ${who} (${state}).`,
    what,
    "Don't run it through Bash instead: the person loses the live view.",
    'To let such runs overlap, set the suite\'s "concurrency" in .claude/tests.json: "args" (the default) refuses only a run with the same args, "any" never refuses.',
  ].join(' ')
}

/** A run's own file prefix, so overlapping runs of one suite never share a log or events file. */
export const runStem = (suite: string, startedAt: number, id: string) => `${suite}-${startedAt}-${id.replace(/[^A-Za-z0-9]/g, '').slice(-7)}`

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The suite's run files beyond the newest `keep` runs, sparing the runs named in `active`. */
export const prunable = (names: readonly string[], suite: string, active: readonly string[], keep = KEPT_RUNS) => {
  const pattern = new RegExp(`^(${escape(suite)}-(\\d+)-[A-Za-z0-9]+)-\\d+\\.(log|events)$`)
  const owned = names.flatMap(name => {
    const match = pattern.exec(name)
    return match === null ? [] : [{ name, stem: match[1] ?? '', startedAt: Number(match[2]) }]
  })
  const stems = [...new Map(owned.map(f => [f.stem, f.startedAt])).entries()].sort((a, b) => b[1] - a[1]).map(([stem]) => stem)
  const kept = new Set([...stems.slice(0, keep), ...active])
  return owned.filter(f => !kept.has(f.stem)).map(f => f.name)
}
