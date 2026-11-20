import { describe, expect, it } from 'vitest';
import { canvasProposalIdOf, suppressedByBar, type AgentNote } from '../src/lib/agentNotes';

function note(overrides: Partial<AgentNote>): AgentNote {
  return {
    id: 'an_1', author: { kind: 'agent', id: 'claude', name: 'Claude', color: '#E8825A' }, source: 'agent', about: 'proposal',
    at: '2026-11-19T00:00:00.000Z', text: 't', parts: [{ text: 't' }], refs: [], actions: [
      { label: 'Review', op: { kind: 'proposal.review', proposalId: 'cp_1', target: 'canvas' } },
    ], readAt: null, dismissedAt: null, actedAt: null, actedWith: null, ...overrides,
  };
}

describe('suppressedByBar', () => {
  it('is true only for a proposal Update whose proposal the bar shows', () => {
    expect(suppressedByBar(note({}), 'cp_1')).toBe(true);
  });
  it('is false for a different proposal or a closed bar', () => {
    expect(suppressedByBar(note({}), 'cp_2')).toBe(false);
    expect(suppressedByBar(note({}), null)).toBe(false);
  });
  it('is false for an Update that is not about a canvas proposal', () => {
    expect(suppressedByBar(note({ about: 'other' }), 'cp_1')).toBe(false);
    expect(suppressedByBar(note({ actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'cp_1', target: 'commons' } }] }), 'cp_1')).toBe(false);
    expect(canvasProposalIdOf(note({ actions: [] }))).toBeNull();
  });
});
