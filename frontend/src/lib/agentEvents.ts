export type AgentEventSource =
  | 'graph'
  | 'claude'
  | 'codex'
  | 'system';

const AGENT_EVENT_SOURCES = new Set<AgentEventSource>([
  'graph',
  'claude',
  'codex',
  'system',
]);

export function normalizeAgentEventSource(value: unknown): AgentEventSource {
  const source = String(value ?? 'system') as AgentEventSource;
  return AGENT_EVENT_SOURCES.has(source) ? source : 'system';
}
