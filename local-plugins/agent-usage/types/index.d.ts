/** One Bash tool call, as the `tool.call` hook saw it: whose it is and the exact command. */
export type BashRecord = {
  id: string
  /** The subagent that called it, null for the main conversation. */
  agentId: string | null
  command: string
  startedAt: number
  /** When the call returned; null while it runs, and for a command that went on in the background. */
  endedAt: number | null
}

/** Whose a process is, and how that was worked out. */
export type Owner = {
  agentId: string | null
  command: string
  /** `env`: its environment names the agent (live-tests' LIVE_TESTS_AGENT_ID). */
  via: 'bash' | 'tree' | 'heuristic' | 'env'
}

declare module 'claude-code' {
  interface PluginState {
    'agent-usage': {
      /** The session's latest Bash calls, newest last. */
      records: BashRecord[]
      /** `pid:starttime` → owner of every process seen so far that is still alive, so one reparented later keeps its agent. */
      remembered: Record<string, Owner>
      /** The footer column's lines, one per agent row; empty unless the footer option is `always`. */
      footer: { key: string; text: string; isOver: boolean }[]
      /** Tokens per loop (`main` or a subagent's id) so far, from each finished turn's usage: the last turn's model, and the tokens per model. */
      tokens: Record<string, { tokens: number; cacheReadTokens: number; model?: string; byModel: Record<string, number> }>
    }
  }
}
