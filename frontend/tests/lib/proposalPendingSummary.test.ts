import { describe, expect, it } from 'vitest';
import { proposalSummary } from '../../src/lib/canvasProposals';
import type { ProposalView } from '../../src/lib/wsClient';

/**
 * A proposal whose whole run waits on agents' placeholders (its run skips
 * them and what needs them, so it runs nothing): GM - Design, round 4
 * (2026-10-25), verbatim: "runs nothing until Codex finishes 2 nodes" /
 * several agents "runs nothing until agents finish 3 nodes". It read
 * "runs 0 free nodes" before.
 */
function view(cost: Partial<ProposalView['cost']>): ProposalView {
  return {
    nodes: [{ ref: '+c' }], edges: [], params: [], run: ['+c'],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '', ...cost },
  } as unknown as ProposalView;
}

describe('a proposal whose run waits on placeholders', () => {
  it('names the one agent', () => {
    expect(proposalSummary(view({ pendingSkipped: { count: 2, agents: ['Codex'] } })))
      .toBe('Adds 1 node · runs nothing until Codex finishes 2 nodes');
  });

  it('says "agents" for several', () => {
    expect(proposalSummary(view({ pendingSkipped: { count: 3, agents: ['Codex', 'Cursor'] } })))
      .toBe('Adds 1 node · runs nothing until agents finish 3 nodes');
  });

  it('one node: "finishes 1 node"', () => {
    expect(proposalSummary(view({ pendingSkipped: { count: 1, agents: ['Codex'] } })))
      .toBe('Adds 1 node · runs nothing until Codex finishes 1 node');
  });

  it('keeps its old line when something still runs', () => {
    expect(proposalSummary(view({ freeRuns: 1, pendingSkipped: { count: 2, agents: ['Codex'] } })))
      .toBe('Adds 1 node · runs 1 free node');
  });
});
