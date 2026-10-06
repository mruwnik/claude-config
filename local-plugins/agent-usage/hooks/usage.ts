/** One measured process: whose (`key`), its memory and its CPU time so far. */
export type ProcRow = {
  /** `main`, a subagent's id, or one of the shared keys (claude itself, its untracked children). */
  key: string
  pid: number
  procKey: string
  command: string
  /** Bytes. */
  pss: number
  /** Bytes; counts shared pages in full, so it overstates. */
  rss: number
  /** utime + stime, clock ticks. */
  ticks: number
  startedMs: number
}

export type ProcUsage = { pid: number; procKey: string; command: string; pss: number; rss: number; cpu: number; startedMs: number }

/** One agent's processes together: memory in bytes, CPU in % of one core. */
export type AgentUsage = { key: string; pss: number; rss: number; cpu: number; procs: ProcUsage[] }

export type PrevSample = { t: number; ticks: ReadonlyMap<string, number> }

export type Point = { t: number; pss: number; cpu: number }

export type Level = { pss: number; cpu: number }

/**
 * CPU over the interval: the ticks since the last sample; a process first seen now counts all
 * its ticks only when it started inside the interval, since older ones' time is not all in it.
 */
const cpuOf = (row: ProcRow, prev: PrevSample | undefined, t: number, hz: number) => {
  if (prev === undefined || t <= prev.t) return 0
  const before = prev.ticks.get(row.procKey) ?? (row.startedMs >= prev.t ? 0 : row.ticks)
  return (((row.ticks - before) / hz) * 100_000) / (t - prev.t)
}

/** Sums the rows per agent, in the order agents first appear; each agent's processes biggest first. */
export const measure = (rows: readonly ProcRow[], prev: PrevSample | undefined, t: number, hz: number): AgentUsage[] => {
  const keys = [...new Set(rows.map(row => row.key))]
  return keys.map(key => {
    const procs = rows
      .filter(row => row.key === key)
      .map(row => ({ pid: row.pid, procKey: row.procKey, command: row.command, pss: row.pss, rss: row.rss, cpu: cpuOf(row, prev, t, hz), startedMs: row.startedMs }))
      .sort((a, b) => b.pss - a.pss)
    const sum = (pick: (p: ProcUsage) => number) => procs.reduce((total, p) => total + pick(p), 0)
    return { key, pss: sum(p => p.pss), rss: sum(p => p.rss), cpu: sum(p => p.cpu), procs }
  })
}

export const ticksOf = (rows: readonly ProcRow[]) => new Map(rows.map(row => [row.procKey, row.ticks]))

/** The history with this sample added, each agent's points inside the window; an agent with none left is dropped. */
export const withPoints = (history: Readonly<Record<string, readonly Point[]>>, usages: readonly AgentUsage[], t: number, windowMs: number) => {
  const added = usages.reduce<Record<string, Point[]>>(
    (all, u) => ({ ...all, [u.key]: [...(all[u.key] ?? []), { t, pss: u.pss, cpu: u.cpu }] }),
    Object.fromEntries(Object.entries(history).map(([key, points]) => [key, [...points]])),
  )
  return Object.fromEntries(
    Object.entries(added)
      .map(([key, points]) => [key, points.filter(p => p.t > t - windowMs)] as const)
      .filter(([, points]) => points.length > 0),
  )
}

export const peakOf = (points: readonly Point[]): Level => ({
  pss: Math.max(0, ...points.map(p => p.pss)),
  cpu: Math.max(0, ...points.map(p => p.cpu)),
})

export const withMaxima = (maxima: Readonly<Record<string, Level>>, usages: readonly AgentUsage[]) =>
  usages.reduce<Record<string, Level>>((all, u) => {
    const old = all[u.key] ?? { pss: 0, cpu: 0 }
    return { ...all, [u.key]: { pss: Math.max(old.pss, u.pss), cpu: Math.max(old.cpu, u.cpu) } }
  }, { ...maxima })

/**
 * One loop's tokens so far: input, cache writes and output in `tokens`; prompt-cache reads apart,
 * as they cost a tenth. `model` is the last turn's, by the id the API reports; `byModel` splits `tokens`.
 */
export type TokenCount = { tokens: number; cacheReadTokens: number; model?: string; byModel: Record<string, number> }

const NO_TOKENS: TokenCount = { tokens: 0, cacheReadTokens: 0, byModel: {} }

/** What a finished turn's usage adds to: the counts with `key`'s (`main` or a subagent's id) moved on by it. */
export const withTurn = (
  counts: Readonly<Record<string, TokenCount>>,
  key: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string },
): Record<string, TokenCount> => {
  // A count kept by an older version may lack byModel.
  const prev = { ...NO_TOKENS, ...counts[key] }
  const added = usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
  return {
    ...counts,
    [key]: {
      tokens: prev.tokens + added,
      cacheReadTokens: prev.cacheReadTokens + usage.cache_read_input_tokens,
      model: usage.model,
      byModel: { ...prev.byModel, [usage.model]: (prev.byModel[usage.model] ?? 0) + added },
    },
  }
}

/** Tokens per model over every loop. */
export const tokensByModel = (counts: readonly TokenCount[]) =>
  counts.reduce<Record<string, number>>(
    (all, c) => Object.entries(c.byModel ?? {}).reduce((acc, [model, n]) => ({ ...acc, [model]: (acc[model] ?? 0) + n }), all),
    {},
  )
