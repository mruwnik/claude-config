import type { Counts, StepState } from './events'
import { formatDuration } from './duration'

export type StepResult = {
  state: StepState
  exit: { code: number | null; signal: string | null }
  tail: readonly string[]
}

export type RunReport = {
  suite: string
  durationMs: number
  logPath: string
  steps: readonly StepResult[]
  baseline?: Counts
  skippedSteps?: readonly string[]
  /** Failures already sent to the agent while the run went on. */
  reportedFailures?: number
}

const MAX_FAILURES = 10
const MAX_MESSAGE_LINES = 30

const ORDER = ['passed', 'failed', 'error', 'skipped'] as const

export const countsLine = (counts: Counts) =>
  ORDER.filter(k => counts[k] > 0)
    .map(k => `${counts[k]} ${k}`)
    .join(', ') || 'no tests'

export const totalCounts = (steps: readonly StepResult[]): Counts =>
  steps.reduce(
    (sum, { state: { counts } }) => ({
      passed: sum.passed + counts.passed,
      failed: sum.failed + counts.failed,
      error: sum.error + counts.error,
      skipped: sum.skipped + counts.skipped,
    }),
    { passed: 0, failed: 0, error: 0, skipped: 0 },
  )

const isStepOk = ({ state, exit }: StepResult) =>
  exit.code === 0 && state.counts.failed === 0 && state.counts.error === 0

const reported = ({ counts }: StepState) => ORDER.some(k => counts[k] > 0)

const exitText = ({ code, signal }: StepResult['exit']) => (signal !== null ? `killed by ${signal}` : `exit ${code ?? '?'}`)

const QUIET_TAIL_LINES = 3

const lastLines = (tail: readonly string[], count: number) => tail.filter(line => line.trim() !== '').slice(-count)

const stepLine = (step: StepResult) => {
  if (isStepOk(step) && !reported(step.state)) {
    return `✓ ${step.state.label}: exit 0, no @@test events; last output:\n${lastLines(step.tail, QUIET_TAIL_LINES).join('\n')}`
  }
  if (isStepOk(step)) return `✓ ${step.state.label}: ${countsLine(step.state.counts)}`
  if (!reported(step.state)) return `✗ ${step.state.label}: ${exitText(step.exit)}, no test results\nLast output:\n${step.tail.join('\n')}`
  return `✗ ${step.state.label}: ${countsLine(step.state.counts)} (${exitText(step.exit)})`
}

export const trimMessage = (message: string) => {
  const lines = message.replace(/\s+$/, '').split('\n')
  const extra = lines.length - MAX_MESSAGE_LINES
  return extra > 0 ? [...lines.slice(0, MAX_MESSAGE_LINES), `… ${extra} more lines in the log`].join('\n') : lines.join('\n')
}

const failureBlocks = (steps: readonly StepResult[]) => {
  const failures = steps.flatMap(s => s.state.failures)
  const shown = failures.slice(0, MAX_FAILURES).map(f => `${f.outcome.toUpperCase()} ${f.name}\n${trimMessage(f.message)}`)
  const hidden = failures.length - shown.length
  return hidden > 0 ? [...shown, `… and ${hidden} more failures (see the log)`] : shown
}

export const NO_EVENTS_HINT =
  'No live progress or test counts: nothing printed @@test lines. Use runner "pytest" or "node-test" in .claude/tests.json, or print @@test lines (see the live-tests:setup-tests skill).'

const sameCounts = (a: Counts, b: Counts) => ORDER.every(k => a[k] === b[k])

const reportedLine = (count: number) =>
  count === 0 ? [] : [`${count === 1 ? '1 failure was' : `${count} failures were`} already reported during the run.`]

export const summarize = ({ suite, durationMs, logPath, steps, baseline, skippedSteps = [], reportedFailures = 0 }: RunReport) => {
  const isOk = steps.every(isStepOk) && skippedSteps.length === 0
  const header = `Suite ${suite}: ${isOk ? 'PASSED' : 'FAILED'} in ${formatDuration(durationMs)}`
  const skipped = skippedSteps.map(label => `- ${label}: not run (an earlier step failed)`)
  const totals = totalCounts(steps)
  const drift = baseline !== undefined && !sameCounts(baseline, totals) ? [`Last run: ${countsLine(baseline)}`] : []
  const failures = failureBlocks(steps)
  const hint = steps.some(s => reported(s.state)) ? [] : [NO_EVENTS_HINT]
  const head = [header, ...steps.map(stepLine), ...skipped, ...drift, ...reportedLine(reportedFailures)].join('\n')
  const body = failures.length === 0 ? '' : `\n\n${failures.join('\n\n')}\n`
  return [`${head}${body}`, ...hint, `Full log: ${logPath}`].join('\n')
}
