import type { Failure, StepState } from './events'
import { trimMessage } from './summary'

export type NoticeMode = 'auto' | 'each' | 'first' | 'off'

export const NOTICE_MODES: readonly NoticeMode[] = ['auto', 'each', 'first', 'off']

/** Under auto, how long a run goes before its failures are sent early; a quicker suite just gets its summary. */
export const AUTO_DELAY_MS = 120_000

/** The least time between two notices of one run. */
export const BATCH_MS = 60_000

/** The failures a background run has already sent early, by step and test name, and when it last sent. */
export type NoticeLog = { readonly reported: readonly string[]; readonly sentAt: number | null }

export const parseNoticeMode = (value: unknown) => NOTICE_MODES.find(mode => mode === value)

/** The tool call's choice, else the suite's, else auto. */
export const noticeMode = (arg: NoticeMode | undefined, suite: NoticeMode | undefined): NoticeMode => arg ?? suite ?? 'auto'

type Fresh = { id: string; failure: Failure }

/** Failed tests not yet reported, once per test; errors wait for the summary. */
export const freshFailures = (steps: readonly StepState[], reported: readonly string[]): Fresh[] => {
  const all = steps.flatMap((s, i) => s.failures.filter(f => f.outcome === 'failed').map(failure => ({ id: `${i + 1}:${failure.name}`, failure })))
  return all.filter((f, i) => !reported.includes(f.id) && all.findIndex(other => other.id === f.id) === i)
}

const isDue = (mode: NoticeMode, now: number, startedAt: number, sentAt: number | null) => {
  if (mode === 'off') return false
  if (mode === 'first') return sentAt === null
  if (mode === 'auto' && now - startedAt < AUTO_DELAY_MS) return false
  return sentAt === null || now - sentAt >= BATCH_MS
}

type BatchFields = { mode: NoticeMode; now: number; startedAt: number; log: NoticeLog; steps: readonly StepState[] }

/** The failures to send now: none until the mode and the 60s window allow, then every one held. */
export const noticeBatch = ({ mode, now, startedAt, log, steps }: BatchFields): Fresh[] =>
  isDue(mode, now, startedAt, log.sentAt) ? freshFailures(steps, log.reported) : []

type TextFields = { label: string; progress: string; failures: readonly Failure[]; logPath: string }

export const noticeText = ({ label, progress, failures, logPath }: TextFields) => {
  const count = failures.length === 1 ? '1 new failure' : `${failures.length} new failures`
  const blocks = failures.map(f => `FAILED ${f.name}\n${trimMessage(f.message)}`)
  return [`Suite ${label}: ${count} so far (${progress}).`, ...blocks, `Full log: ${logPath}\nThe run continues; the full summary comes when it ends.`].join('\n\n')
}
