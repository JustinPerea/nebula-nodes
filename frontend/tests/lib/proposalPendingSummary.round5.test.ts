import { describe, expect, it } from 'vitest';
import { acceptLabel, proposalSummary } from '../../src/lib/canvasProposals';
import type { ProposalView } from '../../src/lib/wsClient';

/**
 * Review 4, M2: "runs nothing until Codex finishes N nodes" counts the
 * placeholders themselves, not the proposal's own nodes that wait on them
 * (the backend's pendingSkipped.placeholders; `count` keeps counting both for
 * the skip line). GM - Design, round 5, item 3: when accepting doesn't start
 * or queue a run, the button reads "Accept".
 */
function view(cost: Partial<ProposalView['cost']>): ProposalView {
  return {
    nodes: [{ ref: '+c' }], edges: [], params: [], run: ['+c'],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '', ...cost },
  } as unknown as ProposalView;
}

describe('a proposal whose run waits on placeholders (round 5)', () => {
  it('counts the placeholders, not what waits on them', () => {
    expect(proposalSummary(view({ pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } })))
      .toBe('Adds 1 node · runs nothing until Codex finishes 1 node');
  });

  it('a backend without the count keeps the old one', () => {
    expect(proposalSummary(view({ pendingSkipped: { count: 2, agents: ['Codex'] } })))
      .toBe('Adds 1 node · runs nothing until Codex finishes 2 nodes');
  });

  it('its button reads "Accept": accepting starts nothing and queues nothing', () => {
    expect(acceptLabel(view({ pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } }))).toBe('Accept');
  });

  it('keeps "Accept & run" when something still runs', () => {
    expect(acceptLabel(view({ freeRuns: 1, pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } }))).toBe('Accept & run');
    expect(acceptLabel(view({ paidRuns: 1 }))).toBe('Accept & run (1 paid)');
  });
});
