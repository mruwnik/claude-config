export type Outcome = 'passed' | 'failed' | 'error' | 'skipped'

export type TestEvent =
  | { event: 'plan'; total: number }
  | { event: 'result'; name: string; outcome: Outcome; message?: string }
  | { event: 'progress'; done: number; total: number; unit: string }
  | { event: 'phase'; name: string }
  | { event: 'exit'; code: number }
  | { event: 'start'; pid: number }

export type Failure = { name: string; outcome: 'failed' | 'error'; message: string }

export type Counts = Record<Outcome, number>

export type StepState = {
  label: string
  planned: number
  counts: Counts
  progress?: { done: number; total: number; unit: string }
  phase?: string
  failures: readonly Failure[]
}

const MARK = '@@test {'
const OUTCOMES: readonly string[] = ['passed', 'failed', 'error', 'skipped']

export const emptyCounts = (): Counts => ({ passed: 0, failed: 0, error: 0, skipped: 0 })

export const emptyStep = (label: string): StepState => ({ label, planned: 0, counts: emptyCounts(), failures: [] })

export const splitLines = (rest: string, chunk: string) => {
  const parts = (rest + chunk).split('\n')
  return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isString = (v: unknown): v is string => typeof v === 'string'

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const toEvent = (raw: Record<string, unknown>): TestEvent | undefined => {
  switch (raw.event) {
    case 'plan':
      return isNumber(raw.total) ? { event: 'plan', total: raw.total } : undefined
    case 'result': {
      if (!isString(raw.name) || !isString(raw.outcome) || !OUTCOMES.includes(raw.outcome)) return undefined
      const base = { event: 'result', name: raw.name, outcome: raw.outcome as Outcome } as const
      return isString(raw.message) ? { ...base, message: raw.message } : base
    }
    case 'progress':
      return isNumber(raw.done) && isNumber(raw.total) && isString(raw.unit)
        ? { event: 'progress', done: raw.done, total: raw.total, unit: raw.unit }
        : undefined
    case 'phase':
      return isString(raw.name) ? { event: 'phase', name: raw.name } : undefined
    case 'exit':
      return isNumber(raw.code) ? { event: 'exit', code: raw.code } : undefined
    case 'start':
      return isNumber(raw.pid) ? { event: 'start', pid: raw.pid } : undefined
    default:
      return undefined
  }
}

/** Where the event's JSON starts: after the run's own `@@test:<nonce> ` mark, else after a plain `@@test `. */
const jsonAt = (line: string, nonce: string | undefined) => {
  const own = nonce === undefined ? -1 : line.indexOf(`@@test:${nonce} {`)
  if (own >= 0) return own + `@@test:${nonce} `.length
  const plain = line.indexOf(MARK)
  return plain < 0 ? -1 : plain + MARK.length - 1
}

/** Finds a `@@test {...}` or `@@test:<nonce> {...}` event anywhere in the line (runners print it mid-line, after a progress dot). */
export const parseEventLine = (line: string, nonce?: string): TestEvent | undefined => {
  const at = jsonAt(line, nonce)
  if (at < 0) return undefined
  const raw = parseJson(line.slice(at).trim())
  return raw === undefined ? undefined : toEvent(raw)
}

export const applyEvent = (state: StepState, event: TestEvent): StepState => {
  switch (event.event) {
    case 'plan':
      return { ...state, planned: state.planned + event.total }
    case 'progress':
      return { ...state, progress: { done: event.done, total: event.total, unit: event.unit } }
    case 'phase':
      return { ...state, phase: event.name }
    case 'exit':
    case 'start':
      return state
    case 'result': {
      const counts = { ...state.counts, [event.outcome]: state.counts[event.outcome] + 1 }
      if (event.outcome !== 'failed' && event.outcome !== 'error') return { ...state, counts }
      const failure: Failure = { name: event.name, outcome: event.outcome, message: event.message ?? '' }
      return { ...state, counts, failures: [...state.failures, failure] }
    }
  }
}
