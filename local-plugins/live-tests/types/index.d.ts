export type RunOutcome = 'running' | 'passed' | 'failed'

export type RunCounts = { passed: number; failed: number; error: number; skipped: number }

/** One run_tests run: what the band draws, and what the poller needs to follow it. */
export type RunRecord = {
  id: string
  root: string
  suite: string
  labels: string[]
  logs: string[]
  events: string[]
  isFullRun: boolean
  /** The run_tests args; absent on runs kept from before 0.3.0. */
  args?: readonly string[]
  /** The suite's shell once seen alive, and when it was last looked for: gone with no exit means killed. */
  pid?: number
  pidCheckedAt?: number
  /** Marks this run's own events (`@@test:<nonce> {`); absent on runs kept from before 0.3.0. */
  nonce?: string
  startedAt: number
  /** The subagent that asked for the run, null for the main conversation; its summary goes back there. */
  agentId: string | null
  /** What the band calls that subagent (its name, or the Agent call's description). */
  agentName: string | null
  /** Set once Bash runs the suite in the background; its completion notification names it. */
  taskId: string | null
  /** The summary once the run is done; null while it runs. */
  summary: string | null
  baseline: RunCounts | null
  /** Whether failures go out before the summary, for a background run; absent on runs kept from before 0.2.4. */
  failureNotices?: 'auto' | 'each' | 'first' | 'off'
  /** The failures already sent early, by step and test name, and when the last notice went. */
  notices?: { reported: readonly string[]; sentAt: number | null }
  // What the band draws, refreshed by the poller.
  outcome: RunOutcome
  stepIndex: number
  planned: number
  counts: RunCounts
  progress: { done: number; total: number; unit: string } | null
  recentFailures: string[]
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'live-tests': {
      runs: RunRecord[]
      /**
       * What main's notification of each background run carries, by Bash task id, kept all session (a
       * notification is re-rendered per request): the summary of main's own run, null for a subagent's.
       */
      summaries: Record<string, string | null>
      /** Where test results show: the footer, the band (left or right aligned), or a docked pane. */
      view: 'footer' | 'band' | 'band-right' | 'pane'
    }
  }
}
