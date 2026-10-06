import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { RunCounts, RunRecord } from '../types'
import { suiteCommand } from './command'
import type { CommandSpec } from './command'
import { configSource, detectConfig, mergeConfigs, noConfigReply, normalizeConfig, stepArgv } from './config'
import type { SuiteConfig, TestsConfig } from './config'
import { formatDuration } from './duration'
import { clashReply, findClash, prunable, runStem } from './clash'
import { NOTICE_MODES, noticeBatch, noticeMode, noticeText, parseNoticeMode } from './notices'
import type { NoticeLog, NoticeMode } from './notices'
import { runProgress } from './progress'
import type { RunProgress } from './progress'
import { summarize, totalCounts } from './summary'
import type { StepResult } from './summary'
import { agentNameOf, deliveryFor, withAgentNames } from './delivery'
import type { AgentEntry } from './delivery'
import { displayOrder, footerLines, MARKS, parseView, progressText, runLabel, splitTrailing, startReply, statusCell, VIEWS, withNewRun } from './view'
import type { View } from './view'

const TOOL = 'run_tests'
const TOOL_ID = 'mcp__live-tests__run_tests'
const POLL_MS = 500
const TAIL_LINES = 40
const MAX_BASH_TIMEOUT_MS = 600_000
const TASK_ID = /<task-id>([^<]+)<\/task-id>/
const EVENT_LINE = /@@test(:[A-Za-z0-9]+)? \{/
const NO_NOTICES: NoticeLog = { reported: [], sentAt: null }
const PID_CHECK_MS = 5_000
const KILLED = 'ended without exit (killed?)'

const runs = atom({ plugin: 'live-tests', key: 'runs' } as const, [])
const summaries = atom({ plugin: 'live-tests', key: 'summaries' } as const, {})
const view = atom({ plugin: 'live-tests', key: 'view' } as const, 'footer')

const PANE = 'live-tests'
const VIEW_COMMAND = 'tests-view'
const VIEW_STORE_KEY = 'view'

type $ = EngineInterface

const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')
const resolvePath = (root: string, path: string | undefined) =>
  path === undefined ? root : path.startsWith('/') ? path : join(root, path)

const readJson = async ($: $, path: string): Promise<unknown> => {
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`tests config error in ${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

const readOptional = async ($: $, path: string) => ((await $.fs.exists(path)) ? $.fs.read(path) : undefined)

/** The folder's file, else the session root's: a worktree has the committed config but not the local one. */
const readConfigFile = async ($: $, folder: string, root: string, name: string) => {
  const own = join(folder, '.claude', name)
  const ownValue = await readJson($, own)
  if (ownValue !== undefined || folder === root) return { path: own, value: ownValue }
  const rootPath = join(root, '.claude', name)
  return { path: rootPath, value: await readJson($, rootPath) }
}

/** `.claude/tests.json` with `.claude/tests.local.json` over it; auto-detected in the folder when neither exists. */
const loadConfig = async ($: $, folder: string, root: string): Promise<TestsConfig | undefined> => {
  const shared = await readConfigFile($, folder, root, 'tests.json')
  const local = await readConfigFile($, folder, root, 'tests.local.json')
  const merged = mergeConfigs(shared.value, local.value)
  if (merged !== undefined) return normalizeConfig(merged, configSource(shared.value, local.value, { shared: shared.path, local: local.path }))
  const detected = detectConfig({
    pyproject: await readOptional($, join(folder, 'pyproject.toml')),
    packageJson: await readOptional($, join(folder, 'package.json')),
    hasUvLock: await $.fs.exists(join(folder, 'uv.lock')),
    hasPytestIni: await $.fs.exists(join(folder, 'pytest.ini')),
  })
  return detected === undefined ? undefined : normalizeConfig(detected)
}

const suiteLine = (name: string, suite: SuiteConfig) => {
  const what = suite.description ?? suite.steps.map(s => s.label ?? s.argv.join(' ')).join(' → ')
  return `- ${name}: ${what}`
}

const describeTool = (config: TestsConfig | Error | undefined) => {
  const base =
    "Run this project's tests. Prefer this over running test commands through Bash: the person sees live progress, " +
    'and you get a compact summary (counts, failures with trimmed tracebacks, path to the full log) instead of raw output. ' +
    '`args` are appended to the test command (a file, `-k expr`, `--test-name-pattern=...`). ' +
    'With `background: true` it returns at once; when the run ends its summary is delivered only to whoever called: a subagent gets it as a message ' +
    'while it is still running, and nobody does once it has ended (so a subagent with nothing else to do should run in the foreground instead); ' +
    'the main conversation gets it with the task\'s completion notification, and gets nothing of a subagent\'s run. ' +
    'A subagent working in a worktree passes its worktree path as `cwd`. ' +
    "`failureNotices` (auto, each, first, off) overrides the suite's choice of whether a background run sends its failures before it ends; auto sends them once it has run 2 minutes."
  if (config instanceof Error) return `${base}\nThe tests config has an error, so no suites are listed: ${config.message}`
  if (config === undefined) {
    return `${base}\nNo suites are configured or detected yet. Calling it with no arguments says what to write; the live-tests:setup-tests skill walks through it.`
  }
  const suites = Object.entries(config.suites).map(([n, s]) => suiteLine(n, s))
  return `${base}\nSuites (default ${config.default}):\n${suites.join('\n')}`
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    suite: { type: 'string', description: 'Suite name; the default suite when omitted.' },
    args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments for the test command.' },
    background: { type: 'boolean', description: 'Run in the background and keep working; the summary comes with the completion notification.' },
    cwd: { type: 'string', description: 'The folder to test in, when it is not the project root: a subagent in a worktree passes its worktree path.' },
    failureNotices: {
      type: 'string',
      enum: NOTICE_MODES,
      description: 'For a background run: send failures as they come (each), only the first notice (first), none (off), or each once it has run 2 minutes (auto).',
    },
  },
}

const setRun = ($: $, id: string, fn: (run: RunRecord) => RunRecord) =>
  update($, runs, list => list.map(run => (run.id === id ? fn(run) : run)))

const readProgress = async ($: $, run: RunRecord) => {
  const texts = await Promise.all(run.events.map(path => $.fs.read(path).catch(() => '')))
  return runProgress(run.labels, texts, run.nonce)
}

const withProgress = (run: RunRecord, progress: RunProgress, now: number): RunRecord => {
  const step = progress.steps[progress.current]?.state
  return {
    ...run,
    stepIndex: progress.current,
    planned: step?.planned ?? 0,
    counts: step?.counts ?? run.counts,
    progress: step?.progress ?? null,
    recentFailures: (step?.failures ?? []).slice(-3).map(f => f.name),
    now,
  }
}

const logTail = async ($: $, path: string | undefined) => {
  const text = path === undefined ? undefined : await $.fs.read(path).catch(() => undefined)
  if (text === undefined) return ['(log unreadable or over 4 MiB; open it directly)']
  return text
    .split('\n')
    .filter(line => !EVENT_LINE.test(line))
    .slice(-TAIL_LINES)
}

const baselineKey = (root: string, suite: string) => `baseline:${root}:${suite}`

/** Turns a finished run's events into its summary, records the baseline, and marks the band. */
const finish = async ($: $, run: RunRecord, progress: RunProgress, unfinished = 'unfinished'): Promise<string> => {
  const ran = progress.steps.slice(0, progress.current + 1)
  const results: StepResult[] = await Promise.all(
    ran.map(async (step, i) => ({
      state: step.state,
      exit: { code: step.exitCode ?? null, signal: step.exitCode === undefined ? unfinished : null },
      tail: step.exitCode === 0 && step.state.counts.passed + step.state.counts.failed > 0 ? [] : await logTail($, run.logs[i]),
    })),
  )
  const now = await $.clock.now()
  const kept = (await read($, runs)).find(r => r.id === run.id) ?? run
  const summary = summarize({
    suite: run.suite,
    durationMs: now - run.startedAt,
    logPath: run.logs.slice(0, ran.length).join(', '),
    steps: results,
    baseline: run.baseline ?? undefined,
    skippedSteps: run.labels.slice(ran.length),
    reportedFailures: (kept.notices ?? NO_NOTICES).reported.length,
  })
  if (run.isFullRun) await $.store.set(baselineKey(run.root, run.suite), totalCounts(results))
  if (run.taskId !== null) await deliver($, run, run.taskId, summary)
  await setRun($, run.id, r => ({ ...withProgress(r, progress, now), outcome: progress.isOk ? 'passed' : 'failed', summary }))
  return summary
}

const listAgents = ($: $): Promise<readonly AgentEntry[]> => $.agent.list().catch(() => [])

/**
 * Settles where a finished background run's summary goes, once: the poller and the notification
 * can both get here. Main's own run keeps its summary for the task notification to carry. A
 * subagent's run keeps null there, so main's notification gets nothing (its Bash task's notification
 * reaches main, never the subagent): the subagent gets the summary as a message while it still
 * listens, and nobody does once it has ended; the run record keeps it either way.
 */
const deliver = async ($: $, run: RunRecord, taskId: string, summary: string) => {
  const delivery = deliveryFor(run.agentId, run.agentId === null ? [] : await listAgents($))
  let isClaimed = false
  await update($, summaries, all => {
    isClaimed = !(taskId in all)
    return isClaimed ? { ...all, [taskId]: delivery.to === 'main' ? summary : null } : all
  })
  if (!isClaimed || delivery.to !== 'agent') return
  const message = { type: 'user' as const, content: [{ type: 'text' as const, text: withSummary(summary) }] }
  await $.session.append({ agentId: delivery.agentId, message }).catch(() => undefined)
}

const withNotice = (text: string) => `<live-tests-notice>\n${text}\n</live-tests-notice>`

/**
 * Sends a background run's new failures to whoever its summary will go to, as its mode and the
 * 60s window allow: none once a subagent that started it has ended. The notice is claimed on the
 * run first, so overlapping polls send it once.
 */
const notify = async ($: $, run: RunRecord, progress: RunProgress, now: number) => {
  const log = run.notices ?? NO_NOTICES
  const steps = progress.steps.map(s => s.state)
  const fresh = noticeBatch({ mode: run.failureNotices ?? 'off', now, startedAt: run.startedAt, log, steps })
  if (fresh.length === 0) return
  const delivery = deliveryFor(run.agentId, run.agentId === null ? [] : await listAgents($))
  if (delivery.to === 'nobody') return
  let isClaimed = false
  await setRun($, run.id, r => {
    isClaimed = r.outcome === 'running' && (r.notices ?? NO_NOTICES).sentAt === log.sentAt
    return isClaimed ? { ...r, notices: { reported: [...log.reported, ...fresh.map(f => f.id)], sentAt: now } } : r
  })
  if (!isClaimed) return
  const text = noticeText({
    label: delivery.to === 'agent' ? run.suite : runLabel(run),
    progress: progressText(withProgress(run, progress, now)),
    failures: fresh.map(f => f.failure),
    logPath: run.logs.slice(0, progress.current + 1).join(', '),
  })
  const message = { type: 'user' as const, content: [{ type: 'text' as const, text: withNotice(text) }] }
  await $.session.append(delivery.to === 'agent' ? { agentId: delivery.agentId, message } : { message }).catch(() => undefined)
}

/** Whether a process is alive, where `/proc` can tell; undefined elsewhere, so no run is ever taken for dead there. */
const isAlive = async ($: $, pid: number) => ((await $.fs.exists('/proc/self')) ? $.fs.exists(`/proc/${pid}`) : undefined)

/**
 * A run counts as killed only once its shell was seen alive and is now gone: a pid never seen
 * (another pid namespace, no `/proc`) is never taken for dead.
 */
const isKilled = async ($: $, run: RunRecord) => run.pid !== undefined && (await isAlive($, run.pid)) === false

/** Looks for the suite's shell at most every few seconds; settles the run when it died without an exit event. */
const checkPid = async ($: $, run: RunRecord, progress: RunProgress, now: number) => {
  if (progress.pid === undefined || now - (run.pidCheckedAt ?? -Infinity) < PID_CHECK_MS) return
  const alive = await isAlive($, progress.pid)
  if (alive === false && run.pid === progress.pid) {
    // The exit event may have landed between the read and the check.
    const again = await readProgress($, run)
    await finish($, run, again, again.isDone ? 'unfinished' : KILLED)
    return
  }
  await setRun($, run.id, r => ({ ...r, pidCheckedAt: now, ...(alive === true ? { pid: progress.pid } : {}) }))
}

/** One poll of one run: refresh the band, send early failures of a background run, and settle the run once its last step has exited or died. */
const pollRun = async ($: $, run: RunRecord) => {
  const progress = await readProgress($, run)
  if (progress.isDone) return finish($, run, progress)
  const now = await $.clock.now()
  await setRun($, run.id, r => withProgress(r, progress, now))
  if (run.taskId !== null) await notify($, run, progress, now)
  await checkPid($, run, progress, now)
  return undefined
}

const pollAll = async ($: $) => {
  const unnamed = (await read($, runs)).some(r => r.agentId !== null && r.agentName === null)
  if (unnamed) {
    const agents = await listAgents($)
    await update($, runs, list => withAgentNames(list, agents))
  }
  const active = (await read($, runs)).filter(r => r.outcome === 'running')
  await Promise.all(active.map(run => pollRun($, run)))
}

type RunFields =
  | 'id'
  | 'root'
  | 'suite'
  | 'labels'
  | 'logs'
  | 'events'
  | 'isFullRun'
  | 'args'
  | 'nonce'
  | 'startedAt'
  | 'baseline'
  | 'agentId'
  | 'agentName'
  | 'failureNotices'

const newRun = (fields: Pick<RunRecord, RunFields>): RunRecord => ({
  ...fields,
  taskId: null,
  summary: null,
  outcome: 'running',
  stepIndex: 0,
  planned: 0,
  counts: { passed: 0, failed: 0, error: 0, skipped: 0 },
  progress: null,
  recentFailures: [],
  now: fields.startedAt,
  notices: NO_NOTICES,
})

const dropRun = ($: $, id: string) => update($, runs, list => list.filter(r => r.id !== id))

/** Running runs of the suite in the folder whose shell is gone: they no longer hold it. */
const deadRuns = async ($: $, root: string, suite: string) => {
  const held = (await read($, runs)).filter(r => r.outcome === 'running' && r.root === root && r.suite === suite)
  const killed = await Promise.all(held.map(async r => ((await isKilled($, r)) ? [r.id] : [])))
  return killed.flat()
}

const RUN_FILE = /([^/]+)-\d+\.log$/

/** Removes the suite's oldest run files beyond the newest few, keeping every run the mod still shows. */
const pruneRunFiles = async ($: $, dir: string, root: string, suite: string) => {
  const names = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name)
  const shown = (await read($, runs)).filter(r => r.root === root && r.suite === suite)
  const stems = shown.flatMap(r => r.logs.map(log => RUN_FILE.exec(log)?.[1] ?? ''))
  const old = prunable(names, suite, stems).map(name => join(dir, name))
  if (old.length === 0) return
  await $.process.run(['rm', '-f', '--', ...old]).catch(() => undefined)
}

type Input = {
  suite: string
  args: readonly string[]
  background: boolean
  cwd: string | undefined
  failureNotices: NoticeMode | undefined
  toolUseId: string
  agentId: string | undefined
}

const startRun = async ($: $, input: Input): Promise<string> => {
  const sessionRoot = await $.session.root()
  // The folder the run belongs to: a subagent's worktree when it says so, else the session's root.
  const root = resolvePath(sessionRoot, input.cwd)
  const config = await loadConfig($, root, sessionRoot)
  if (config === undefined) return noConfigReply(root)
  const suiteName = input.suite || config.default
  const suite = config.suites[suiteName]
  if (suite === undefined) return `No suite "${suiteName}". ${describeTool(config)}`

  const dir = join(root, '.claude/live-tests')
  const startedAt = await $.clock.now()
  const stem = runStem(suiteName, startedAt, input.toolUseId)
  const nonce = `${startedAt.toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const agentId = input.agentId ?? null
  const agentName = agentId === null ? null : agentNameOf(agentId, await listAgents($))
  const labels = { run: input.toolUseId, agentId, agentName }
  const steps = suite.steps.map((step, i) => ({
    step,
    label: step.label ?? (suite.steps.length === 1 ? suiteName : `${suiteName} ${i + 1}`),
    files: { log: join(dir, `${stem}-${i + 1}.log`), events: join(dir, `${stem}-${i + 1}.events`) },
  }))
  const specs: CommandSpec[] = steps.map(({ step, files }, i) => ({
    cwd: resolvePath(resolvePath(root, suite.cwd), step.cwd),
    argv: stepArgv(step, i === steps.length - 1, input.args),
    runner: step.runner ?? 'events',
    env: { ...suite.env, ...step.env },
    emittersDir: join($.plugin.root, 'emitters'),
    files,
    nonce,
    labels,
  }))
  const command = suiteCommand(specs)

  const isFullRun = input.args.length === 0
  const baseline = isFullRun ? (((await $.store.get(baselineKey(root, suiteName))) as RunCounts | undefined) ?? null) : null
  const run = newRun({
    id: input.toolUseId,
    root,
    suite: suiteName,
    labels: steps.map(s => s.label),
    logs: steps.map(s => s.files.log),
    events: steps.map(s => s.files.events),
    isFullRun,
    args: input.args,
    nonce,
    startedAt,
    baseline,
    agentId,
    agentName,
    failureNotices: noticeMode(input.failureNotices, suite.failureNotices),
  })
  const dead = await deadRuns($, root, suiteName)
  // The check and the insert in one update, so two calls at once cannot both pass it.
  const found: { clash?: RunRecord } = {}
  await update($, runs, list => {
    found.clash = findClash(list, { root, suite: suiteName, args: input.args }, suite.concurrency ?? 'args', dead)
    return found.clash === undefined ? withNewRun(list, run) : list
  })
  if (found.clash !== undefined) return clashReply({ holder: found.clash, callerAgentId: input.agentId ?? null, now: startedAt })

  await $.fs.write(join(dir, '.gitignore'), '*\n')
  await Promise.all(steps.map(s => $.fs.write(s.files.events, '')))
  void pruneRunFiles($, dir, root, suiteName)
  if ((await read($, view)) === 'pane') void $.ui.open({ id: PANE, title: 'Tests' }).catch(() => undefined)

  const called = await $.tool
    .call({
      tool: 'Bash',
      command,
      description: `Run test suite "${suiteName}" (live-tests)`,
      timeout: Math.min(suite.timeoutMs ?? MAX_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS),
      ...(input.background ? { run_in_background: true } : {}),
    })
    .catch(async (error: unknown) => {
      await dropRun($, run.id)
      throw new Error(`The Bash call failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  if (called.deny !== undefined) {
    await dropRun($, run.id)
    return `The Bash call was refused: ${called.deny}`
  }
  const taskId = (called.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
  if (taskId === undefined) {
    return finish($, run, await readProgress($, run))
  }
  await setRun($, run.id, r => ({ ...r, taskId }))
  const logPath = run.logs.join(', ')
  return startReply({ suite: suiteName, taskId, isAsked: input.background === true, isSubagent: input.agentId !== undefined, logPath })
}

/**
 * What main's notification of a task carries, settling its run first if the poller has not yet:
 * the summary of main's own run, null for a subagent's run (main gets nothing), undefined for a
 * task the mod did not start.
 */
const summaryForTask = async ($: $, taskId: string) => {
  const kept = (await read($, summaries))[taskId]
  if (kept !== undefined) return kept
  const run = (await read($, runs)).find(r => r.taskId === taskId)
  if (run === undefined) return undefined
  if (run.summary === null) await finish($, run, await readProgress($, run))
  return (await read($, summaries))[taskId]
}

const taskIdIn = (text: string) => TASK_ID.exec(text)?.[1]

/** Whether the task is a subagent's run: settled (its summary kept as null for main) or still listed. */
const isSubagentTask = async ($: $, taskId: string) =>
  (await read($, summaries))[taskId] === null || (await read($, runs)).some(r => r.taskId === taskId && r.agentId !== null)

const withSummary = (summary: string) => `<live-tests-summary>\n${summary}\n</live-tests-summary>`

const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk']

// Theme names where the theme has one, so light and dark themes both read; running has no theme colour of its own.
const COLORS = { running: 'cyan', passed: 'success', failed: 'error' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // One poller for every run, foreground or background; a reload starts it again over the kept runs.
    $.clock.every(POLL_MS, () => void pollAll($))
    const stored = parseView(String((await $.store.get(VIEW_STORE_KEY)) ?? ''))
    if (stored !== undefined) await update($, view, () => stored)
    await $.command.register({
      name: VIEW_COMMAND,
      description: 'Choose where live test results show: footer, band, band-right or pane',
      argumentHint: VIEWS.join('|'),
    })
    const root = await $.session.root()
    const config = await loadConfig($, root, root).catch((error: unknown) => (error instanceof Error ? error : undefined))
    await $.tool.register({ name: TOOL, description: describeTool(config), inputSchema: INPUT_SCHEMA })
    return started
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const raw = e as unknown as {
      suite?: unknown
      args?: unknown
      background?: unknown
      cwd?: unknown
      failureNotices?: unknown
      tool_use_id: string
      agentId?: string
    }
    const input: Input = {
      suite: typeof raw.suite === 'string' ? raw.suite : '',
      args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
      background: raw.background === true,
      cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : undefined,
      failureNotices: parseNoticeMode(raw.failureNotices),
      toolUseId: raw.tool_use_id,
      agentId: raw.agentId,
    }
    const text = await startRun($, input).catch((error: unknown) => (error instanceof Error ? error.message : `live-tests: ${String(error)}`))
    return { result: text }
  })

  // A background run's summary rides on the task notification Claude Code sends when its Bash task ends.
  // Idle, the notification is a stored row and the summary is added to it. Mid-turn it is an attachment
  // row the engine keeps as made, so the summary follows it as a row of its own.
  on('session.append', async ($, e, next) => {
    const blocks = e.message.content
    const taskId = blocks
      .map(b => (b.type === 'text' && typeof b.text === 'string' ? taskIdIn(b.text) : undefined))
      .find(id => id !== undefined)
    const summary = taskId === undefined ? undefined : await summaryForTask($, taskId)
    if (summary === undefined || summary === null) return next(e)
    const block = { type: 'text' as const, text: withSummary(summary) }
    if (e.message.type !== 'attachment') return next({ ...e, message: { ...e.message, content: [...blocks, block] } })
    // Raised once this row's chain is done: appends are stored in order, so awaiting one here would wait on itself.
    $.clock.after(0, () => void $.session.append({ message: { type: 'user', content: [block] } }).catch(() => undefined))
    return next(e)
  })

  // Only a prompt the person sends clears finished runs from the band: task notifications arrive
  // through here too, and must not take the run their summary is read from. The notification of a
  // subagent's run is answered without next, so it never enters main; its run is settled first,
  // which sends the subagent its summary.
  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.includes(e.origin.kind)) await update($, runs, list => list.filter(r => r.outcome === 'running'))
    const taskId = e.origin.kind === 'task-notification' ? taskIdIn(e.text) : undefined
    if (taskId === undefined || !(await isSubagentTask($, taskId))) return next(e)
    await summaryForTask($, taskId)
    return { text: e.text, origin: e.origin }
  })

  on('command.run', { command: VIEW_COMMAND }, async ($, e) => {
    const chosen = parseView(e.args)
    if (chosen === undefined) return { text: `Usage: /${VIEW_COMMAND} ${VIEWS.join('|')} (now: ${await read($, view)})` }
    await update($, view, () => chosen)
    await $.store.set(VIEW_STORE_KEY, chosen)
    if (chosen === 'pane') await $.ui.open({ id: PANE, title: 'Tests' })
    if (chosen !== 'pane') await $.ui.close({ id: PANE }).catch(() => undefined)
    return { text: `Test results now show in: ${chosen}` }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    // What the hooks beneath drew (the engine's modes, another plugin's column) is kept, the runs after it.
    const beneath = await next(e)
    const list = await read($, runs)
    if ((await read($, view)) !== 'footer' || list.length === 0) return beneath
    const { Box, Text } = $.ui.resolve(e)
    // A column keyed `trailing:<plugin>` beneath (agent-usage's) asks to stay last: it goes after the runs.
    const { kept, trailing } = splitTrailing(beneath)
    return (
      <Box flexDirection="row" alignItems="flex-start">
        {kept}
        <Box flexDirection="column" alignItems="flex-end" marginLeft={2}>
          {footerLines(displayOrder(list)).map(line => (
            <Text wrap="truncate-end" key={line.id}>
              {line.segments.map(segment => (segment.tone === undefined ? <Text dimColor>{segment.text}</Text> : <Text color={segment.tone}>{segment.text}</Text>))}
            </Text>
          ))}
        </Box>
        {trailing as RenderElement[]}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, runs)
    const chosen: View = await read($, view)
    const isBand = chosen === 'band' || chosen === 'band-right'
    if (e.props.hasSurvey || !isBand || list.length === 0) return next(e)
    return runTree($.ui.resolve(e), list, chosen === 'band-right' ? 'flex-end' : 'flex-start')
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, runs)
    const elements = $.ui.resolve(e)
    if (list.length === 0) return <elements.Text dimColor>No test runs yet.</elements.Text>
    return runTree(elements, displayOrder(list), 'flex-start')
  })
}

type Elements = { Box: (props: Record<string, unknown>) => JSX.Element; Text: (props: Record<string, unknown>) => JSX.Element }

/** Every run as a status line and its latest failures: the band's and the pane's content. */
const runTree = ({ Box, Text }: Elements, list: readonly RunRecord[], align: 'flex-start' | 'flex-end') => (
  <Box flexDirection="column" alignItems={align}>
    {list.map(run => (
      <Box flexDirection="column" alignItems={align} key={run.id}>
        <Text wrap="truncate-end">
          <Text color={COLORS[run.outcome]}>
            {MARKS[run.outcome]} {runLabel(run)}
          </Text>
          <Text dimColor>
            {run.taskId !== null && run.outcome === 'running' ? ' (bg)' : ''}
            {run.labels.length > 1 ? ` · ${run.stepIndex + 1}/${run.labels.length} ${run.labels[run.stepIndex] ?? ''}` : ''} ·{' '}
          </Text>
          {statusCell(run, false).map(segment => (segment.tone === undefined ? <Text dimColor>{segment.text}</Text> : <Text color={segment.tone}>{segment.text}</Text>))}
          <Text dimColor> · {formatDuration(run.now - run.startedAt)}</Text>
        </Text>
        {run.recentFailures.map(name => (
          <Text color="error" dimColor wrap="truncate-end">
            {'  '}✗ {name}
          </Text>
        ))}
      </Box>
    ))}
  </Box>
)
