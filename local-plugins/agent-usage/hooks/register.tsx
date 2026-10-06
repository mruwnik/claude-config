import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { attribute, envCandidates, procKey, startedMs } from './attribute'
import type { Proc } from './attribute'
import { argvNeeded, readArgvs, readEnvirons, readPss, reapersOf, scanAll, walk } from './gather'
import type { Reader, Source } from './gather'
import { parseArgv, parseBtime, parseCpuCount, parseCpuTimes, parseEnvAgent, parseGrepOutput, parseLoadavg, parseMeminfo, parsePss, parseRss, parseStat, systemCpuPct } from './proc'
import type { CpuTimes } from './proc'
import { bashFailure, dryRunResult, endedSince, killCommand, nothingLeftResult, reapNotice, reapOptions, reapResult, recheck, selectTargets, statPath } from './reap'
import type { ReapTarget, Skip } from './reap'
import { pressureStep, pressureText, REARM_MB, snapshotText, toolJson, toolOptions, usageJson } from './report'
import type { AgentRef, JsonInput } from './report'
import type { Stat } from './proc'
import { measure, peakOf, ticksOf, withMaxima, withPoints, withTurn } from './usage'
import type { AgentUsage, Level, Point, PrevSample, ProcRow } from './usage'
import { alertStep, CLAUDE, footerColumn, formatBytes, MAIN, OTHER, SHARED, statusLine, thresholdsFrom, usageTable } from './view'
import type { Config, FooterLine, TableRow } from './view'

const records = atom({ plugin: 'agent-usage', key: 'records' } as const, [])
const remembered = atom({ plugin: 'agent-usage', key: 'remembered' } as const, {})
const footer = atom({ plugin: 'agent-usage', key: 'footer' } as const, [])
const tokens = atom({ plugin: 'agent-usage', key: 'tokens' } as const, {})

const COMMAND = 'agent-usage'
const TOOL = 'agent_usage'
const TOOL_ID = 'mcp__agent-usage__agent_usage'
const TOOL_DESCRIPTION = 'Default: available memory, load, memory/CPU per agent. Pass procs/unattributed/history for detail.'
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'Only this agent (name or id).' },
    procs: { type: 'boolean', description: 'Add each agent\'s top processes.' },
    limit: { type: 'integer', minimum: 1, description: 'Processes per agent with procs (default 5).' },
    unattributed: { type: 'boolean', description: 'List unattributed processes, with reason and agent.' },
    history: { type: 'boolean', description: 'Add peak, max, since and status per agent.' },
    rss: { type: 'boolean', description: 'Add rssMb beside pssMb.' },
    detail: { type: 'string', enum: ['full'], description: 'Everything, as the snapshot file has it.' },
  },
}
const REAP_TOOL = 'agent_reap'
const REAP_TOOL_ID = 'mcp__agent-usage__agent_reap'
const REAP_DESCRIPTION = 'Kill leftover processes of a stopped agent (only processes agent_usage lists as unattributed for it). Goes through Bash.'
const REAP_SCHEMA = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'The stopped or gone agent (name or id).' },
    dryRun: { type: 'boolean', description: 'Say what would be killed; kill nothing.' },
  },
  required: ['agent'],
}
/** How long TERM gets before KILL, and KILL before the last look. */
const TERM_WAIT_MS = 3000
const KILL_WAIT_MS = 500
/** With reapOnStop, how long after an agent stops its leftovers are reaped. */
const REAP_GRACE_MS = 30_000
/** Clock ticks per second: USER_HZ, 100 on every mainstream Linux build. */
const HZ = 100
const MAX_RECORDS = 500
const PEAK_WINDOW_MS = 60_000
/** Every this many samples, every process on the machine is read, for the reparent heuristic. */
const FULL_SCAN_EVERY = 6

type $ = EngineInterface

type Sampler = {
  source: Source | undefined
  error: string | undefined
  count: number
  /** argv by `pid:starttime`: read once per process. */
  argv: ReadonlyMap<string, readonly string[]>
  /** The agent each process's environ names (null: none), by `pid:starttime`: read once per process. */
  environ: ReadonlyMap<string, string | null>
  prev: PrevSample | undefined
  usages: readonly AgentUsage[]
  history: Readonly<Record<string, readonly Point[]>>
  maxima: Readonly<Record<string, Level>>
  alerting: readonly string[]
  status: string | undefined
  names: Readonly<Record<string, string>>
  agents: readonly AgentRef[]
  firstSeen: Readonly<Record<string, number>>
  /** What the tool and the snapshot are built from: the latest sample. */
  json: JsonInput | undefined
  /** The pressure notice is armed until it fires, and again once memory is back. */
  isArmed: boolean
  snapshotError: string | undefined
  /** The machine's CPU ticks at the last sample, for its CPU use over the next. */
  cpuTimes: CpuTimes | undefined
  /** How many low-memory notices were sent, and the last one's text. */
  notices: number
  lastNotice: string | undefined
}

const initialSampler = (): Sampler => ({
  source: undefined,
  error: undefined,
  count: 0,
  argv: new Map(),
  environ: new Map(),
  prev: undefined,
  usages: [],
  history: {},
  maxima: {},
  alerting: [],
  status: undefined,
  names: {},
  agents: [],
  firstSeen: {},
  json: undefined,
  isArmed: true,
  snapshotError: undefined,
  cpuTimes: undefined,
  notices: 0,
  lastNotice: undefined,
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const nameOf = (names: Readonly<Record<string, string>>) => (key: string) => {
  if (key === MAIN) return 'main'
  if (key === CLAUDE) return 'claude (all loops)'
  if (key === OTHER) return 'claude children (MCP, untracked)'
  return names[key] ?? `agent ${key.slice(0, 8)}`
}

/** The session's agents now; the names seen are kept, so an agent no longer listed keeps its name. */
const agentsNow = async ($: $, names: Readonly<Record<string, string>>) => {
  const agents: readonly AgentRef[] = await $.agent.list().catch(() => [])
  return { agents, names: { ...names, ...Object.fromEntries(agents.map(a => [a.id, a.name ?? a.description])) } }
}

/** Rewrites the snapshot file; `$.fs` has no rename, so it is a plain write. The error, if any, for /agent-usage. */
const writeSnapshot = async ($: $, path: string, text: string) =>
  $.fs.write(path, text).then(
    () => undefined,
    (error: unknown) => errorText(error),
  )

const KB = 1024

/** One notice per drop under the floor, a row for the main conversation (no popup); its text, kept for /agent-usage. */
const warnPressure = async ($: $, input: JsonInput) => {
  const text = pressureText(usageJson(input), config.marginMb)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  return text
}

const fsReader = ($: $): Reader => ({
  via: 'fs',
  read: async paths => {
    const read = await Promise.all(paths.map(path => $.fs.read(path).then(text => [path, text] as const, () => undefined)))
    return new Map(read.filter(entry => entry !== undefined))
  },
  list: async dirs => {
    const listed = await Promise.all(dirs.map(dir => $.fs.list(dir).then(entries => entries.map(e => e.name), () => [])))
    return new Map(dirs.map((dir, i) => [dir, listed[i] ?? []]))
  },
})

/** Arguments per subprocess, well under the kernel's limit. */
const CHUNK = 400

const chunks = <T,>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

/** The fallback when `$.fs` cannot read /proc: fixed argv, no shell; `grep` prints the files, `find` lists the directories. */
const processReader = ($: $): Reader => ({
  via: 'process',
  read: async paths => {
    const outs = await Promise.all(chunks(paths).map(part => $.process.run(['grep', '-asH', '-e', '', '--', ...part])))
    return new Map(outs.flatMap(out => [...parseGrepOutput(out.stdout)]))
  },
  list: async dirs => {
    const outs = await Promise.all(chunks(dirs).map(part => $.process.run(['find', ...part, '-mindepth', '1', '-maxdepth', '1', '-printf', '%p\\n'])))
    const paths = outs.flatMap(out => out.stdout.split('\n')).filter(line => line !== '')
    const nameIn = (dir: string) => paths.filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1))
    return new Map(dirs.map(dir => [dir, nameIn(dir)]))
  },
})

const SELF_STAT = '/proc/self/stat'

/**
 * Finds a way to read /proc and claude's pid. `$.fs` runs in claude's own process, so its
 * /proc/self is claude; procfs files report size 0, so an empty read means `$.fs` cannot
 * read them, and the fallback's /proc/self is grep, whose parent is claude.
 */
const probe = async ($: $): Promise<Source> => {
  const viaFs = await $.fs.read(SELF_STAT).catch((error: unknown) => new Error(errorText(error)))
  const fsStat = viaFs instanceof Error ? undefined : parseStat(viaFs)
  const withBoot = async (reader: Reader, pid: number, note: string): Promise<Source> => {
    const files = await reader.read([`/proc/${pid}/stat`, '/proc/stat', '/proc/cpuinfo'])
    const bootMs = parseBtime(files.get('/proc/stat') ?? '') * 1000
    if (!Number.isFinite(bootMs)) throw new Error('could not read the boot time from /proc/stat')
    const cores = parseCpuCount(files.get('/proc/cpuinfo') ?? '')
    return { reader, claudePid: pid, comm: parseStat(files.get(`/proc/${pid}/stat`) ?? '')?.comm ?? '?', bootMs, cores, note }
  }
  if (fsStat !== undefined) return withBoot(fsReader($), fsStat.pid, 'reading /proc through $.fs')
  const why = viaFs instanceof Error ? `$.fs.read failed: ${viaFs.message}` : `$.fs.read came back ${viaFs === '' ? 'empty' : 'unparseable'}`
  const reader = processReader($)
  const grepStat = parseStat((await reader.read([SELF_STAT])).get(SELF_STAT) ?? '')
  if (grepStat === undefined) throw new Error(`cannot read /proc: ${why}, and grep could not either`)
  return withBoot(reader, grepStat.ppid, `reading /proc through grep/find subprocesses (${why} for ${SELF_STAT})`)
}

/** The cache with the argv of these processes added, read for the ones it lacks. */
const withArgvs = async (source: Source, stats: ReadonlyMap<number, Stat>, pids: readonly number[], cache: ReadonlyMap<string, readonly string[]>) => {
  const missing = pids.filter(pid => {
    const stat = stats.get(pid)
    return stat !== undefined && !cache.has(procKey(stat))
  })
  const texts = await readArgvs(source.reader, missing)
  const added = missing.flatMap(pid => {
    const stat = stats.get(pid)
    return stat === undefined ? [] : [[procKey(stat), parseArgv(texts.get(pid) ?? '')] as const]
  })
  return new Map([...cache, ...added])
}

/** The cache with the agent named in these processes' environ added, read for the ones it lacks. */
const withEnvirons = async (source: Source, stats: ReadonlyMap<number, Stat>, pids: readonly number[], cache: ReadonlyMap<string, string | null>) => {
  const missing = pids.filter(pid => {
    const stat = stats.get(pid)
    return stat !== undefined && !cache.has(procKey(stat))
  })
  const texts = await readEnvirons(source.reader, missing)
  const added = missing.flatMap(pid => {
    const stat = stats.get(pid)
    return stat === undefined ? [] : [[procKey(stat), parseEnvAgent(texts.get(pid) ?? '') ?? null] as const]
  })
  return new Map([...cache, ...added])
}

const procsOf = (stats: ReadonlyMap<number, Stat>, argv: ReadonlyMap<string, readonly string[]>) =>
  new Map(
    [...stats].map(([pid, stat]): [number, Proc] => {
      const args = argv.get(procKey(stat))
      return [pid, args === undefined ? stat : { ...stat, argv: args }]
    }),
  )

/** One sample: find the processes, say whose each is, measure them, and update the warning line. */
const sampleOnce = async ($: $, sampler: Sampler, config: Config): Promise<Sampler> => {
  const source = sampler.source ?? (await probe($))
  const { reader, claudePid, bootMs } = source
  const known = await read($, remembered)
  const isFullScan = sampler.count % FULL_SCAN_EVERY === 0
  const rememberedPids = Object.keys(known).map(key => Number(key.split(':')[0]))
  const stats = isFullScan ? await scanAll(reader) : await walk(reader, [claudePid, ...rememberedPids])
  const reapers = isFullScan ? reapersOf(stats) : new Set<number>()
  // Read after the processes: a record is written before its shell starts, so every shell seen has one.
  const recs = await read($, records)

  const seen = await withArgvs(source, stats, argvNeeded(stats, claudePid, reapers, recs, bootMs, HZ), sampler.argv)
  const snap = { claudePid, procs: procsOf(stats, seen), records: recs, remembered: known, bootMs, hz: HZ, reapers }
  const environ = await withEnvirons(source, stats, envCandidates(snap, attribute(snap)), sampler.environ)
  const found = attribute({ ...snap, envAgents: environ })
  await update($, remembered, () => found.remembered)

  const keyed: (readonly [pid: number, key: string])[] = [
    [claudePid, CLAUDE],
    ...[...found.owners].map(([pid, owner]) => [pid, owner.agentId ?? MAIN] as const),
    ...found.untracked.map(pid => [pid, OTHER] as const),
  ]
  const pids = keyed.map(([pid]) => pid)
  const argv = await withArgvs(source, stats, pids, seen)
  const pss = await readPss(reader, pids)
  const t = await $.clock.now()
  const rows: ProcRow[] = keyed.flatMap(([pid, key]) => {
    const stat = stats.get(pid)
    if (stat === undefined) return []
    const args = argv.get(procKey(stat)) ?? []
    const row: ProcRow = {
      key,
      pid,
      procKey: procKey(stat),
      command: args.length > 0 ? args.join(' ') : `[${stat.comm}]`,
      pss: parsePss(pss.get(pid) ?? ''),
      rss: parseRss(pss.get(pid) ?? ''),
      ticks: stat.utime + stat.stime,
      startedMs: startedMs(stat, bootMs, HZ),
    }
    return [row]
  })
  const usages = measure(rows, sampler.prev, t, HZ)
  const { agents, names } = await agentsNow($, sampler.names)
  const machine = await reader.read(['/proc/meminfo', '/proc/loadavg', '/proc/stat'])
  const mem = parseMeminfo(machine.get('/proc/meminfo') ?? '')
  const cpuTimes = parseCpuTimes(machine.get('/proc/stat') ?? '')
  const loadavg = parseLoadavg(machine.get('/proc/loadavg') ?? '')
  const cpuPct = cpuTimes === undefined ? undefined : systemCpuPct(sampler.cpuTimes, cpuTimes)
  const load = loadavg === undefined ? undefined : { ...loadavg, cores: source.cores, ...(cpuPct === undefined ? {} : { cpuPct }) }
  const history = withPoints(sampler.history, usages, t, PEAK_WINDOW_MS)
  const maxima = withMaxima(sampler.maxima, usages)
  const firstSeen = { ...Object.fromEntries(usages.map(u => [u.key, t])), ...sampler.firstSeen }
  const counted = await read($, tokens)
  const json: JsonInput = { at: t, mem, floorMb: config.floorMb > 0 ? config.floorMb : null, usages, agents, names, history, maxima, firstSeen, load, tokens: counted }
  const snapshotError = config.snapshotPath === '' ? undefined : await writeSnapshot($, config.snapshotPath, snapshotText(usageJson(json)))
  const pressure = mem === undefined ? { armed: sampler.isArmed, fire: false } : pressureStep({ armed: sampler.isArmed }, mem.availableKb / KB, config.floorMb, config.marginMb)
  const notice = pressure.fire ? await warnPressure($, json) : undefined
  const step = alertStep(sampler.alerting, usages, config)
  const status = config.footer === 'alerts' ? statusLine(step.alerting, usages, nameOf(names)) : undefined
  if (status !== sampler.status) $.ui.status(status)
  const lines = config.footer === 'always' ? footerColumn(usages, step.alerting, names, config.footerMin) : []
  // Written only on a change: every write redraws the footer.
  if (!sameLines(lines, await read($, footer))) await update($, footer, () => lines)

  const sampledKeys = new Set([...stats.values()].map(procKey))
  return {
    ...sampler,
    source,
    error: undefined,
    count: sampler.count + 1,
    argv: new Map([...argv].filter(([key]) => sampledKeys.has(key))),
    environ: new Map([...environ].filter(([key]) => sampledKeys.has(key))),
    prev: { t, ticks: ticksOf(rows) },
    usages,
    history,
    maxima,
    alerting: step.alerting,
    status,
    names,
    agents,
    firstSeen,
    json,
    isArmed: pressure.armed,
    snapshotError,
    cpuTimes: cpuTimes ?? sampler.cpuTimes,
    notices: notice === undefined ? sampler.notices : sampler.notices + 1,
    lastNotice: notice ?? sampler.lastNotice,
  }
}

/** Signals the targets through the Bash tool, so the permission check and the sandbox apply as to any command. */
const bashKill = async ($: $, signal: 'TERM' | 'KILL', targets: readonly ReapTarget[]) => {
  const command = killCommand(signal, targets)
  if (command === undefined) return undefined
  const result = await $.tool.call({ tool: 'Bash', command, description: `agent_reap: ${signal} leftover processes of a stopped agent` }).catch((error: unknown) => ({ deny: errorText(error) }))
  return bashFailure(result)
}

/** The targets still the very processes sampled, read now. */
const stillThere = async (source: Source, targets: readonly ReapTarget[]) => recheck(targets, await source.reader.read(targets.map(t => statPath(t.pid))))

/**
 * agent_reap: a fresh sample, the stopped agent's unattributed processes, each rechecked by
 * pid:starttime; TERM through Bash, then after a wait KILL through Bash to those still there.
 */
const reap = async ($: $, asked: string, isDryRun: boolean) => {
  await tick($)
  const { json, source } = sampler
  if (json === undefined || source === undefined) return { agent: asked, error: sampler.error ?? 'no sample yet' }
  const picked = selectTargets(json, asked, source.claudePid)
  if ('error' in picked) return picked
  const before = await stillThere(source, picked.targets)
  const skipped: Skip[] = [...picked.skipped, ...before.skipped]
  if (before.alive.length === 0) return nothingLeftResult(picked.agent, isDryRun, skipped)
  if (isDryRun) return dryRunResult(picked.agent, before.alive, skipped)
  const termFailed = await bashKill($, 'TERM', before.alive)
  await $.clock.sleep(TERM_WAIT_MS)
  const afterTerm = (await stillThere(source, before.alive)).alive
  // A failed TERM that ended nothing (refused, say) is where it stops: no KILL is asked after a no.
  if (termFailed !== undefined && afterTerm.length === before.alive.length) return { agent: picked.agent, error: `kill -TERM went through Bash and failed: ${termFailed}`, skipped }
  if (afterTerm.length === 0) return reapResult(picked.agent, before.alive, [], skipped)
  const killFailed = await bashKill($, 'KILL', afterTerm)
  await $.clock.sleep(KILL_WAIT_MS)
  const survivors = (await stillThere(source, afterTerm)).alive
  const result = reapResult(picked.agent, before.alive, survivors, skipped)
  return killFailed === undefined ? result : { ...result, error: `kill -KILL went through Bash and failed: ${killFailed}` }
}

/** reapOnStop: how many reaps killed something, and the last one's notice. */
let autoReaps = { count: 0, last: undefined as string | undefined }

/** reapOnStop's reap of one agent after the grace: the same path as the tool, and one notice when it killed something. */
const autoReap = async ($: $, id: string) => {
  const result = await reap($, id, false)
  if (!('survived' in result)) return
  const notice = reapNotice(result)
  if (notice === undefined) return
  autoReaps = { count: autoReaps.count + 1, last: notice }
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: notice }] } }).catch(() => undefined)
}

const reapLine = () => {
  if (!config.reapOnStop) return 'Reap on stop: off (reapOnStop).'
  const last = autoReaps.last === undefined ? '' : ` Last: ${autoReaps.last.split('\n')[1] ?? ''}`
  return `Reap on stop: on, ${REAP_GRACE_MS / 1000}s after an agent stops; ${autoReaps.count} reaped.${last}`
}

const sameLines = (a: readonly FooterLine[], b: readonly FooterLine[]) =>
  a.length === b.length && a.every((line, i) => line.text === b[i]?.text && line.isOver === b[i]?.isOver)

const tableRows = (sampler: Sampler): TableRow[] =>
  sampler.usages.map(u => ({
    name: nameOf(sampler.names)(u.key),
    kind: SHARED.includes(u.key) ? 'shared' : 'agent',
    now: { pss: u.pss, cpu: u.cpu },
    peak: peakOf(sampler.history[u.key] ?? []),
    max: sampler.maxima[u.key] ?? { pss: u.pss, cpu: u.cpu },
    procs: u.procs,
  }))

const MB = 1024 * 1024

/** The low-memory notice's state: off, armed (and where it fires), or sent and where it re-arms, with the last text. */
const noticeLine = (sampler: Sampler) => {
  if (config.floorMb <= 0) return 'Low-memory notice: off (memoryFloorMB is 0).'
  const line = formatBytes((config.floorMb + config.marginMb) * MB)
  if (sampler.isArmed) return `Low-memory notice: armed, fires under ${line} available; ${sampler.notices} sent.`
  const last = (sampler.lastNotice ?? '').split('\n')[1] ?? ''
  return `Low-memory notice: ${sampler.notices} sent, re-arms above ${formatBytes((config.floorMb + config.marginMb + REARM_MB) * MB)} available. Last: ${last}`
}

const report = (sampler: Sampler, config: Config) => {
  const { source, error } = sampler
  if (source === undefined) return `agent-usage has no sample yet${error === undefined ? '' : `: ${error}`}`
  const notes = [
    `Memory is PSS (shared pages split between their users); CPU is % of one core over the last ${config.intervalMs / 1000}s; peaks are over the last minute.`,
    '"claude (all loops)" is the claude process itself: every agent\'s model loop runs there and cannot be split.',
    `Warns at ${formatBytes(config.memBytes)} or ${config.cpuPercent}% CPU per agent. claude pid ${source.claudePid} (${source.comm}), ${source.note}; ${sampler.count} samples.`,
    `Footer: ${config.footer}${config.footer === 'always' ? `, ${footerPlacement ?? 'not drawn yet'}` : ''}.`,
    noticeLine(sampler),
    reapLine(),
    ...(config.snapshotPath === '' ? [] : [`Snapshot: ${config.snapshotPath}${sampler.snapshotError === undefined ? '' : ` (last write failed: ${sampler.snapshotError})`}.`]),
    ...(error === undefined ? [] : [`The last sample failed: ${error}`]),
  ]
  return [usageTable(tableRows(sampler)), '', ...notes].join('\n')
}

/** The sampler between ticks; a reload starts it over (the records and remembered owners are in $.state and stay). */
let sampler = initialSampler()
let config = thresholdsFrom({})

const LIVE_TESTS = 'live-tests'

/** Where the footer column last landed, for /agent-usage to say. */
let footerPlacement: string | undefined

/** The sample under way, which a tick due meanwhile joins rather than starting a second. */
let running: Promise<void> | undefined

const sampleNow = async ($: $) => {
  const before = sampler.agents
  sampler = await sampleOnce($, sampler, config).catch((error: unknown) => ({ ...sampler, error: errorText(error) }))
  running = undefined
  if (!config.reapOnStop) return
  endedSince(before, sampler.agents).forEach(id => $.clock.after(REAP_GRACE_MS, () => void autoReap($, id).catch(() => undefined)))
}

const tick = ($: $) => {
  running = running ?? sampleNow($)
  return running
}

export const register: Register = (on, options) => {
  config = thresholdsFrom(options)
  sampler = initialSampler()
  running = undefined
  autoReaps = { count: 0, last: undefined }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: "How much memory and CPU each agent's processes use now, and their peaks" })
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA })
    await $.tool.register({ name: REAP_TOOL, description: REAP_DESCRIPTION, inputSchema: REAP_SCHEMA })
    $.clock.every(config.intervalMs, () => void tick($))
    void tick($)
    return started
  })
  // Observes only: the call goes on exactly as it came, and the record says whose command it is.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    const startedAt = await $.clock.now()
    await update($, records, list => [...list, { id, agentId: e.agentId ?? null, command: e.command, startedAt, endedAt: null }].slice(-MAX_RECORDS))
    const result = await next(e)
    // A command that went on in the background keeps its window open.
    if ((result.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId !== undefined) return result
    const endedAt = await $.clock.now()
    await update($, records, list => list.map(r => (r.id === id ? { ...r, endedAt } : r)))
    return result
  }).catch(($, e, next) => next(e)) // a failure here never stops or repeats the call: next(e) replays it once run

  // Observes only: each finished turn's usage (main's, or a subagent's run) adds to its loop's tokens.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const { usage } = e
    if (usage === undefined) return result
    await update($, tokens, counts => withTurn(counts, e.agentId ?? MAIN, usage))
    return result
  }).catch(($, e, next) => next(e))

  // The column goes to the right of whatever the hooks beneath drew (live-tests' runs, the engine's modes).
  // Plugins of one tier nest in no documented order and a plugin cannot pick its tier, so the column is
  // keyed `trailing:agent-usage`: live-tests (0.3.2+), when it is the outer one, moves it after its runs.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const beneath = await next(e)
    if (config.footer !== 'always') return beneath
    footerPlacement = next.trace.some(link => link.plugin === LIVE_TESTS) ? 'right of live-tests (live-tests is beneath)' : 'live-tests not beneath this time (outer, or not drawing)'
    const lines = await read($, footer)
    if (lines.length === 0) return beneath
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="flex-start">
        {beneath}
        <Box key="trailing:agent-usage" flexDirection="column" marginLeft={2}>
          {lines.map(line => (
            <Text key={line.key} wrap="truncate-end" {...(line.isOver ? { color: 'warning' } : { dimColor: true })}>
              {line.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    if (sampler.count === 0) await tick($)
    const { json, error } = sampler
    if (json === undefined) return { result: JSON.stringify({ error: error ?? 'no sample yet' }) }
    // Tokens as of now: turns end between samples.
    return { result: JSON.stringify(toolJson({ ...json, tokens: await read($, tokens) }, toolOptions(e))) }
  }).catch(() => ({ result: JSON.stringify({ error: 'agent_usage failed; /agent-usage shows the last sample error' }) }))

  // Kills only through the Bash tool (bashKill), never $.process.run: the permission check and the sandbox decide.
  on('tool.call', { tool: REAP_TOOL_ID }, async ($, e) => {
    const { agent, dryRun } = reapOptions(e)
    if (agent === undefined) return { result: JSON.stringify({ error: 'agent is required (a name or id)' }) }
    return { result: JSON.stringify(await reap($, agent, dryRun)) }
  }).catch(() => ({ result: JSON.stringify({ error: 'agent_reap failed; nothing more was sent' }) }))

  on('command.run', { command: COMMAND }, async $ => {
    if (sampler.count === 0) await tick($)
    return { text: report(sampler, config) }
  })
}
