import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { agentActionEntry } from '../src/store/agentLogStore';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

// GM - Design, round 16: the cursor bubble names the card's labels and leaves
// out a field the card shows no label for (no words at all when none has
// one); "The Agent log keeps recording the change; where there's no card
// label it uses the param key." The backend sends the log's words as `log`
// when they differ from the bubble's (main._set_words).

const event = (say: string, log?: string): AgentPresenceEvent => ({
  type: 'agentPresence', agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true },
  target: { nodeId: 'n2' }, action: 'click', say, at: 1, ...(log !== undefined ? { log } : {}),
} as AgentPresenceEvent);

describe('the Agent log keeps a change the bubble leaves out', () => {
  it('no card label: the bubble says nothing, the log names the key', () => {
    expect(agentActionEntry(event('', 'Set aspect_ratio'))?.message).toBe('Set aspect_ratio');
  });
  it('some labels: the log lists them all', () => {
    expect(agentActionEntry(event('Set “Aspect ratio”', 'Set “Aspect ratio” and seed_mode'))?.message)
      .toBe('Set “Aspect ratio” and seed_mode');
  });
  it('with no separate log words, the bubble words are the log', () => {
    expect(agentActionEntry(event('Set “Aspect ratio”'))?.message).toBe('Set “Aspect ratio”');
    expect(agentActionEntry(event(''))).toBeNull();
  });
});
