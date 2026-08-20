import { describe, expect, it } from 'vitest';

import { normalizeAgentEventSource } from '../../src/lib/agentEvents';

describe('agent event source attribution', () => {
  it.each(['claude', 'codex', 'daedalus', 'hermes', 'graph', 'system'])(
    'preserves the supported source %s',
    (source) => {
      expect(normalizeAgentEventSource(source)).toBe(source);
    },
  );

  it('does not let an unknown source masquerade as an agent', () => {
    expect(normalizeAgentEventSource('bogus')).toBe('system');
  });
});
