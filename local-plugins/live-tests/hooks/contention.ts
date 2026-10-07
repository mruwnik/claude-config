import type { RunRecord } from '../types'
import { formatDuration } from './duration'

/** How `update` says another writer beat each of its tries (64 of them, back to back). */
const CONTENDED = 'update: the value was written by another every time it was read'

/** How many times a write that must land goes again after `update` gave up, and how long it waits between. */
export const PERSIST_ATTEMPTS = 10
const BACKOFF_BASE_MS = 25
const BACKOFF_CAP_MS = 2_000

export const isContended = (error: unknown) => error instanceof Error && error.message.startsWith(CONTENDED)

/** Full jitter: a random wait up to a cap that doubles each attempt, so writers that collided spread out. */
export const backoffMs = (attempt: number, random: number) => Math.floor(random * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt))

export type Poll = (run: RunRecord) => RunRecord

/** The run list with each poll applied to its run, the rest as they stand. */
export const withPolls = (list: readonly RunRecord[], polls: ReadonlyMap<string, Poll>): RunRecord[] =>
  list.map(run => polls.get(run.id)?.(run) ?? run)

/** A run as the band shows it: its clock only to the second it draws. */
const shownForm = (run: RunRecord) => ({ ...run, now: formatDuration(run.now - run.startedAt) })

/** Whether the list changed in a way anyone would see, so an idle poll writes nothing. */
export const isShownChange = (before: readonly RunRecord[], after: readonly RunRecord[]) =>
  JSON.stringify(before.map(shownForm)) !== JSON.stringify(after.map(shownForm))

/** A write the next poll makes again anyway: lost to contention, it is skipped; any other failure stands. */
export const skipContended = <T,>(write: Promise<T>): Promise<T | undefined> =>
  write.catch((error: unknown) => {
    if (!isContended(error)) throw error
    return undefined
  })
