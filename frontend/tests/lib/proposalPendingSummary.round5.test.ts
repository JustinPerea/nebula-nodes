import { describe, expect, it } from 'vitest';
import { acceptLabel } from '../../src/lib/canvasProposals';
import type { ProposalView } from '../../src/lib/wsClient';

/**
 * The "runs nothing until Codex finishes N nodes" line is the backend's plan
 * line now (backend tests/test_proposal_plan_line.py). GM - Design, round 5, item 3: when accepting doesn't start
 * or queue a run, the button reads "Accept".
 */
function view(cost: Partial<ProposalView['cost']>): ProposalView {
  return {
    nodes: [{ ref: '+c' }], edges: [], params: [], run: ['+c'],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '', ...cost },
  } as unknown as ProposalView;
}

describe('a proposal whose run waits on placeholders (round 5)', () => {
  it('its button reads "Accept": accepting starts nothing and queues nothing', () => {
    expect(acceptLabel(view({ pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } }))).toBe('Accept');
  });

  // GM - Design, 2026-11-01: the paid count left the label; the plan line
  // right above it says what's paid.
  it('keeps "Accept and run" when something still runs', () => {
    expect(acceptLabel(view({ freeRuns: 1, pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } }))).toBe('Accept and run');
    expect(acceptLabel(view({ paidRuns: 1 }))).toBe('Accept and run');
  });
});
