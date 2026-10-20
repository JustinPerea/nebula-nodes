export type AgentEventSource =
  /** An agent's action on the canvas or a board (agentLogStore), named by the entry's agent. */
  | 'agent'
  | 'graph'
  | 'claude'
  | 'codex'
  | 'personal'
  | 'system';

const AGENT_EVENT_SOURCES = new Set<AgentEventSource>([
  'agent',
  'graph',
  'claude',
  'codex',
  'personal',
  'system',
]);

export function normalizeAgentEventSource(value: unknown): AgentEventSource {
  const source = String(value ?? 'system') as AgentEventSource;
  return AGENT_EVENT_SOURCES.has(source) ? source : 'system';
}
