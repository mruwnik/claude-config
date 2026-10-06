import { applyEvent, emptyStep, parseEventLine } from './events'
import type { StepState, TestEvent } from './events'

export type StepProgress = { state: StepState; exitCode?: number; pid?: number }

export type RunProgress = {
  steps: readonly StepProgress[]
  /** The step running now, or the one the run ended on. */
  current: number
  isDone: boolean
  isOk: boolean
  /** The suite's shell, from its start event: gone with no exit event means the run was killed. */
  pid: number | undefined
}

/** Reads one step's events file; a line not yet ended by a newline waits for the next read. */
export const parseStep = (label: string, text: string, nonce?: string): StepProgress => {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  const events = complete
    .split('\n')
    .map(line => parseEventLine(line, nonce))
    .filter((e): e is TestEvent => e !== undefined)
  const exit = events.find(e => e.event === 'exit')
  const start = events.find(e => e.event === 'start')
  const state = events.reduce(applyEvent, emptyStep(label))
  const pid = start?.event === 'start' ? { pid: start.pid } : {}
  return exit?.event === 'exit' ? { state, exitCode: exit.code, ...pid } : { state, ...pid }
}

const isStepOk = ({ state, exitCode }: StepProgress) =>
  exitCode === 0 && state.counts.failed === 0 && state.counts.error === 0

export const runProgress = (labels: readonly string[], texts: readonly string[], nonce?: string): RunProgress => {
  const steps = labels.map((label, i) => parseStep(label, texts[i] ?? '', nonce))
  const failedAt = steps.findIndex(s => s.exitCode !== undefined && s.exitCode !== 0)
  const runningAt = steps.findIndex(s => s.exitCode === undefined)
  const isFinished = failedAt >= 0 || runningAt < 0
  const current = failedAt >= 0 ? failedAt : runningAt >= 0 ? runningAt : steps.length - 1
  return { steps, current, isDone: isFinished, isOk: isFinished && steps.every(isStepOk), pid: steps[0]?.pid }
}
