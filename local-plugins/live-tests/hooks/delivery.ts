/** What the mod needs of `$.agent.list()`'s entries. */
export type AgentEntry = { readonly id: string; readonly status: string; readonly name?: string; readonly description: string }

export type Delivery = { to: 'agent'; agentId: string } | { to: 'main' } | { to: 'nobody' }

/** Statuses whose loop can still read a message; the rest have ended. */
const LISTENING: readonly string[] = ['pending', 'running', 'waiting', 'idle']

/**
 * Where a background run's summary and failure notices go: main for main's own run, the subagent
 * that started it while it still listens, else nobody. A subagent's run never reaches main.
 */
export const deliveryFor = (agentId: string | null, agents: readonly AgentEntry[]): Delivery => {
  if (agentId === null) return { to: 'main' }
  const agent = agents.find(a => a.id === agentId)
  return agent !== undefined && LISTENING.includes(agent.status) ? { to: 'agent', agentId: agent.id } : { to: 'nobody' }
}

export const agentNameOf = (agentId: string | null, agents: readonly AgentEntry[]) => {
  const agent = agentId === null ? undefined : agents.find(a => a.id === agentId)
  return agent === undefined ? null : (agent.name ?? agent.description)
}

type Named = { readonly agentId: string | null; readonly agentName: string | null }

/** Runs whose subagent had no name listed when they started, named now if the list has one. */
export const withAgentNames = <T extends Named>(list: readonly T[], agents: readonly AgentEntry[]): T[] =>
  list.map(run => (run.agentId === null || run.agentName !== null ? run : { ...run, agentName: agentNameOf(run.agentId, agents) }))
