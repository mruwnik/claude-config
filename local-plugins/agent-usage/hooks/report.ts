import { tokensByModel } from './usage'
import type { AgentUsage, Level, Point, ProcUsage, TokenCount } from './usage'
import { CLAUDE, formatBytes, MAIN, OTHER } from './view'

const MB = 1024 * 1024
const MAX_PROCS = 10
const CMD_WIDTH = 80
/** Back above floor + margin by this much before the notice re-arms, so a value at the line sends one. */
export const REARM_MB = 256

/** What the mod needs of `$.agent.list()`'s entries. */
export type AgentRef = { readonly id: string; readonly status: string; readonly name?: string; readonly description: string }

/** Statuses whose loop still runs; any other listed status has ended. */
export const LIVE: readonly string[] = ['pending', 'running', 'waiting', 'idle']

/** An agent's status as the tool reports it: its own while live, `stopped` once ended, `gone` once no longer listed. */
export const statusOf = (key: string, agents: readonly AgentRef[]) => {
  if (key === MAIN) return 'running'
  const found = agents.find(a => a.id === key)
  if (found === undefined) return 'gone'
  return LIVE.includes(found.status) ? found.status : 'stopped'
}

export type JsonInput = {
  at: number
  mem: { availableKb: number; totalKb: number } | undefined
  floorMb: number | null
  /** Every row the sample measured: agents, `main`, claude itself and its untracked children. */
  usages: readonly AgentUsage[]
  agents: readonly AgentRef[]
  names: Readonly<Record<string, string>>
  history: Readonly<Record<string, readonly Point[]>>
  maxima: Readonly<Record<string, Level>>
  /** When each agent's processes were first seen, ms. */
  firstSeen: Readonly<Record<string, number>>
  load: Load | undefined
  /** Tokens per loop (`main` or a subagent's id) since the session began, counted from each turn's usage. */
  tokens: Readonly<Record<string, TokenCount>>
}

/** The machine's load: the 1 and 5 minute averages, its logical CPUs, and its CPU use over the last sample (% of all cores). */
export type Load = { load1: number; load5: number; cores: number; cpuPct?: number }

type ProcJson = { pid: number; pssMb: number; rssMb: number; cpuPct: number; cmd: string; ageS: number }

type UnattributedProc = ProcJson & { reason: 'agent stopped' | 'agent gone' | 'no record'; agent?: string; id?: string }

export type AgentJson = {
  agent: string
  id: string | null
  status: string
  pssMb: number
  rssMb: number
  cpuPct: number
  peak1mPssMb: number
  maxPssMb: number
  since: string | null
  procCount: number
  procs: ProcJson[]
}

export type UsageJson = {
  at: string
  memAvailableMb: number | null
  memTotalMb: number | null
  floorMb: number | null
  load: Load | null
  totals: { agentsPssMb: number; claudePssMb: number; unattributedPssMb: number }
  agents: AgentJson[]
  unattributed: { pssMb: number; procs: UnattributedProc[] }
}

const mb = (bytes: number) => Math.round(bytes / MB)

const sumMb = (list: readonly { pss: number }[]) => mb(list.reduce((total, x) => total + x.pss, 0))

const oneLine = (command: string) => command.replace(/\s+/g, ' ').trim().slice(0, CMD_WIDTH)

const procJson = (p: ProcUsage, at: number): ProcJson => ({
  pid: p.pid,
  pssMb: mb(p.pss),
  rssMb: mb(p.rss),
  cpuPct: Math.round(p.cpu),
  cmd: oneLine(p.command),
  ageS: Math.max(0, Math.round((at - p.startedMs) / 1000)),
})

/** An agent's name as the tool reports it: main, its name, its description, else its id. */
export const agentName = (key: string, input: JsonInput) => {
  if (key === MAIN) return 'main'
  const listed = input.agents.find(a => a.id === key)
  return input.names[key] ?? listed?.name ?? listed?.description ?? key
}

const agentJson = (u: AgentUsage, input: JsonInput): AgentJson => {
  const peak = Math.max(u.pss, ...(input.history[u.key] ?? []).map(p => p.pss))
  const first = input.firstSeen[u.key]
  return {
    agent: agentName(u.key, input),
    id: u.key === MAIN ? null : u.key,
    status: statusOf(u.key, input.agents),
    pssMb: mb(u.pss),
    rssMb: mb(u.rss),
    cpuPct: Math.round(u.cpu),
    peak1mPssMb: mb(peak),
    maxPssMb: mb(Math.max(u.pss, input.maxima[u.key]?.pss ?? 0)),
    since: first === undefined ? null : new Date(first).toISOString(),
    procCount: u.procs.length,
    procs: [...u.procs].sort((a, b) => b.pss - a.pss).slice(0, MAX_PROCS).map(p => procJson(p, input.at)),
  }
}

const isAgentRow = (u: AgentUsage) => u.key !== CLAUDE && u.key !== OTHER

/**
 * What the agent_usage tool answers and the snapshot file holds. Live agents (and main) are
 * `agents`, biggest first; processes of an agent that stopped or is gone, and claude's children no
 * Bash record owns, are `unattributed` with a reason: where leaks hide. `filter` (a name or id)
 * keeps one agent; totals and unattributed stay whole.
 */
export const usageJson = (input: JsonInput, filter?: string): UsageJson => {
  const agentRows = input.usages.filter(isAgentRow)
  const live = agentRows.filter(u => ['stopped', 'gone'].every(s => s !== statusOf(u.key, input.agents)))
  const ended = agentRows.filter(u => !live.includes(u))
  const unattributed: UnattributedProc[] = [
    ...ended.flatMap(u => {
      const reason = statusOf(u.key, input.agents) === 'stopped' ? ('agent stopped' as const) : ('agent gone' as const)
      return u.procs.map(p => ({ ...procJson(p, input.at), reason, agent: agentName(u.key, input), id: u.key }))
    }),
    ...input.usages.filter(u => u.key === OTHER).flatMap(u => u.procs.map(p => ({ ...procJson(p, input.at), reason: 'no record' as const }))),
  ].sort((a, b) => b.pssMb - a.pssMb)
  const unattributedRows = [...ended, ...input.usages.filter(u => u.key === OTHER)]
  const agents = [...live].sort((a, b) => b.pss - a.pss).map(u => agentJson(u, input))
  return {
    at: new Date(input.at).toISOString(),
    memAvailableMb: input.mem === undefined ? null : Math.round(input.mem.availableKb / 1024),
    memTotalMb: input.mem === undefined ? null : Math.round(input.mem.totalKb / 1024),
    floorMb: input.floorMb,
    load: input.load ?? null,
    totals: { agentsPssMb: sumMb(live), claudePssMb: sumMb(input.usages.filter(u => u.key === CLAUDE)), unattributedPssMb: sumMb(unattributedRows) },
    agents: filter === undefined ? agents : agents.filter(a => a.agent === filter || a.id === filter),
    unattributed: { pssMb: sumMb(unattributedRows), procs: unattributed },
  }
}

/** The snapshot file's text: the JSON on one line, newline-terminated. */
export const snapshotText = (json: UsageJson) => `${JSON.stringify(json)}\n`

/** One notice per drop below floor + margin; re-armed only once back above it by REARM_MB. Floor 0 is off. */
export const pressureStep = (state: { armed: boolean }, availMb: number, floorMb: number, marginMb: number) => {
  if (floorMb <= 0) return { armed: true, fire: false }
  if (state.armed && availMb < floorMb + marginMb) return { armed: false, fire: true }
  if (!state.armed && availMb > floorMb + marginMb + REARM_MB) return { armed: true, fire: false }
  return { armed: state.armed, fire: false }
}

const fromMb = (value: number) => formatBytes(value * MB)

/** The notice for the main conversation: what is available, the top three agents and the unattributed total. */
export const pressureText = (json: UsageJson, marginMb: number) => {
  const top = json.agents.slice(0, 3).map(a => `${a.agent} ${fromMb(a.pssMb)}`)
  const body =
    `Memory is low: ${fromMb(json.memAvailableMb ?? 0)} available, under the floor ${fromMb(json.floorMb ?? 0)} + margin ${fromMb(marginMb)}. ` +
    `Biggest agents: ${top.length === 0 ? 'none' : top.join(', ')}. Unattributed: ${fromMb(json.unattributed.pssMb)}. ` +
    'Call agent_usage for the per-process list; TaskStop stops an agent by name.'
  return `<agent-usage-notice>\n${body}\n</agent-usage-notice>`
}

/** What a call of the agent_usage tool asks for beyond the compact default. */
export type ToolOptions = {
  agent?: string
  procs?: boolean
  limit?: number
  unattributed?: boolean
  history?: boolean
  rss?: boolean
  detail?: 'full'
}

const FLAGS = ['procs', 'unattributed', 'history', 'rss'] as const

/** The tool's arguments, each kept only when it is what the schema says; anything else is the default. */
export const toolOptions = (raw: unknown): ToolOptions => {
  if (typeof raw !== 'object' || raw === null) return {}
  const args = raw as Record<string, unknown>
  const flags = Object.fromEntries(FLAGS.filter(flag => args[flag] === true).map(flag => [flag, true]))
  const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? { limit: args.limit } : {}
  const agent = typeof args.agent === 'string' && args.agent !== '' ? { agent: args.agent } : {}
  const detail = args.detail === 'full' ? { detail: 'full' as const } : {}
  return { ...agent, ...flags, ...limit, ...detail }
}

const DEFAULT_LIMIT = 5
const SHORT_CMD = 60

/** The object without its zero, null and undefined fields: the compact answer says only what is there. */
const present = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== 0 && v !== null && v !== undefined)) as Partial<T>

const shortProc = (p: ProcUsage, at: number, rss: boolean) => ({
  pid: p.pid,
  ...present({ pssMb: mb(p.pss), rssMb: rss ? mb(p.rss) : 0, cpuPct: Math.round(p.cpu) }),
  cmd: p.command.replace(/\s+/g, ' ').trim().slice(0, SHORT_CMD),
  ...present({ ageS: Math.max(0, Math.round((at - p.startedMs) / 1000)) }),
})

type Row = { key: string; usage: AgentUsage | undefined }

/** An agent's tokens per model, only once it has used more than one. */
const modelsOf = (count: TokenCount | undefined) => {
  const byModel = count?.byModel ?? {}
  return Object.keys(byModel).length > 1 ? { models: byModel } : {}
}

/**
 * What the agent_usage tool answers: by default a line of memory, load, each live agent's
 * memory, CPU and tokens, and the tokens of main and the session; zero fields are left out, and
 * so is an agent with nothing left. `procs`, `unattributed`, `history` and `rss` add detail,
 * `detail: "full"` is the snapshot's shape.
 */
export const toolJson = (input: JsonInput, options: ToolOptions) => {
  if (options.detail === 'full') return usageJson(input, options.agent)
  const full = usageJson(input)
  const limit = options.limit ?? DEFAULT_LIMIT
  const rss = options.rss === true
  const measured = input.usages.filter(isAgentRow).filter(u => ['stopped', 'gone'].every(s => s !== statusOf(u.key, input.agents)))
  const idle = input.agents.filter(a => LIVE.includes(a.status) && !measured.some(u => u.key === a.id))
  const rows: Row[] = [...[...measured].sort((a, b) => b.pss - a.pss).map(u => ({ key: u.key, usage: u })), ...idle.map(a => ({ key: a.id, usage: undefined }))]
  const agentRow = ({ key, usage }: Row) => {
    const entry = full.agents.find(a => (a.id ?? MAIN) === key)
    const history = options.history === true ? { peak1mPssMb: entry?.peak1mPssMb, maxPssMb: entry?.maxPssMb, since: entry?.since, status: statusOf(key, input.agents) } : {}
    const procs = options.procs === true && usage !== undefined ? { procs: [...usage.procs].sort((a, b) => b.pss - a.pss).slice(0, limit).map(p => shortProc(p, input.at, rss)) } : {}
    return {
      agent: agentName(key, input),
      ...present({
        pssMb: mb(usage?.pss ?? 0),
        rssMb: rss ? mb(usage?.rss ?? 0) : 0,
        cpuPct: Math.round(usage?.cpu ?? 0),
        tokens: input.tokens[key]?.tokens,
        cacheReadTokens: input.tokens[key]?.cacheReadTokens,
        model: input.tokens[key]?.model,
        ...history,
      }),
      ...modelsOf(input.tokens[key]),
      ...procs,
    }
  }
  const counts = Object.values(input.tokens)
  const sessionTokens = present({
    main: input.tokens[MAIN]?.tokens,
    session: counts.reduce((sum, c) => sum + c.tokens, 0),
    sessionCacheRead: counts.reduce((sum, c) => sum + c.cacheReadTokens, 0),
  })
  const byModel = tokensByModel(counts)
  const claude = input.usages.find(u => u.key === CLAUDE)
  const unattributedProcs = full.unattributed.procs.slice(0, Math.max(limit, DEFAULT_LIMIT)).map(p => ({
    pid: p.pid,
    ...present({ pssMb: p.pssMb, rssMb: rss ? p.rssMb : 0, cpuPct: p.cpuPct }),
    cmd: p.cmd.slice(0, SHORT_CMD),
    ...present({ ageS: p.ageS }),
    reason: p.reason,
    ...(p.agent === undefined ? {} : { agent: p.agent }),
  }))
  const isAsked = (row: Row) => options.agent === undefined || row.key === options.agent || agentName(row.key, input) === options.agent
  // A row with nothing beside its name says nothing: left out.
  const agents = rows.filter(isAsked).map(agentRow).filter(row => Object.keys(row).length > 1)
  return {
    at: full.at,
    ...present({ memAvailableMb: full.memAvailableMb, memTotalMb: full.memTotalMb }),
    ...(input.load === undefined ? {} : { load: present(input.load) }),
    agents,
    claude: present({ pssMb: mb(claude?.pss ?? 0), rssMb: rss ? mb(claude?.rss ?? 0) : 0, cpuPct: Math.round(claude?.cpu ?? 0) }),
    unattributed: { ...present({ pssMb: full.unattributed.pssMb, count: full.unattributed.procs.length }), ...(options.unattributed === true ? { procs: unattributedProcs } : {}) },
    ...(Object.keys(sessionTokens).length === 0 ? {} : { tokens: { ...sessionTokens, ...(Object.keys(byModel).length === 0 ? {} : { byModel }) } }),
  }
}
