export type AgentEventSource =
  | 'graph'
  | 'claude'
  | 'codex'
  | 'daedalus'
  | 'hermes'
  | 'system';

const AGENT_EVENT_SOURCES = new Set<AgentEventSource>([
  'graph',
  'claude',
  'codex',
  'daedalus',
  'hermes',
  'system',
]);

export function normalizeAgentEventSource(value: unknown): AgentEventSource {
  const source = String(value ?? 'system') as AgentEventSource;
  return AGENT_EVENT_SOURCES.has(source) ? source : 'system';
}
