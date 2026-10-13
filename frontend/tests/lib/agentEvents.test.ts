import { describe, expect, it } from 'vitest';

import { normalizeAgentEventSource } from '../../src/lib/agentEvents';

describe('agent event source attribution', () => {
  it.each(['claude', 'codex', 'graph', 'system'])(
    'preserves the supported source %s',
    (source) => {
      expect(normalizeAgentEventSource(source)).toBe(source);
    },
  );

  it('does not let an unknown source masquerade as an agent', () => {
    expect(normalizeAgentEventSource('bogus')).toBe('system');
  });

  // Daedalus (the Hermes runner) was removed; stale events that still name it
  // render as system lines.
  it.each(['daedalus', 'hermes'])('treats the removed %s source as system', (source) => {
    expect(normalizeAgentEventSource(source)).toBe('system');
  });
});
