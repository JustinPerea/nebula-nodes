import { describe, expect, it } from 'vitest';
import { proposalChanges, proposalEstimateLabel } from '../../src/lib/canvasProposals';
import type { ProposalView } from '../../src/lib/wsClient';

function view(): ProposalView {
  return {
    id: 'p_1', status: 'open', agent: { id: 'ext:claude', name: 'Claude', color: '#fff', verified: false },
    note: 'Bill it to the plan', projectId: null, createdAt: 0, expiresAt: 1,
    nodes: [{
      ref: '+k', definitionId: 'krea-2-generate', name: 'Krea 2', category: 'image-gen', params: {},
      position: { x: 0, y: 0 }, cost: { kind: 'paid', provider: 'krea', label: 'paid · krea' } as never,
      runs: false, willRun: false, ports: { inputs: [], outputs: [] },
    }],
    edges: [],
    params: [{ nodeId: 'n1', name: 'Krea 2 (n1)', changes: { _kreaAuth: { from: '<internal>', to: '<internal>' } } }],
    run: [],
    cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [] } as never,
  } as ProposalView;
}

describe('proposalChanges', () => {
  it('names a Krea billing switch plainly, so the person sees what Accept changes', () => {
    const groups = proposalChanges(view(), {
      nodes: { '+k': { _kreaAuth: 'mcp', seed: 7 } },
      params: { n1: { _kreaAuth: { from: 'api-token', to: 'mcp' } } },
    });
    expect(groups[0].lines).toEqual([{ key: 'Billed to', to: 'Krea plan' }, { key: 'seed', to: '7' }]);
    expect(groups[1].lines).toEqual([{ key: 'Billed to', from: 'API token balance', to: 'Krea plan' }]);
    // A node that never set it is on the API token, not "(empty)".
    const unset = proposalChanges(view(), { nodes: {}, params: { n1: { _kreaAuth: { from: null, to: 'mcp' } } } });
    expect(unset[1].lines).toEqual([{ key: 'Billed to', from: 'API token balance', to: 'Krea plan' }]);
  });

  it('names a provider switch plainly, with Auto for a node that never set it', () => {
    const groups = proposalChanges(view(), {
      nodes: { '+k': { _provider: 'replicate' } },
      params: { n1: { _provider: { from: null, to: 'bfl' } } },
    });
    expect(groups[0].lines).toEqual([{ key: 'Provider', to: 'replicate' }]);
    expect(groups[1].lines).toEqual([{ key: 'Provider', from: 'Auto', to: 'bfl' }]);
  });

  it('names the model beside a name the agent gave a new node, so the person sees what Accept adds', () => {
    const named = view();
    named.nodes[0] = { ...named.nodes[0], name: 'Lake hero', model: 'Krea 2' };
    expect(proposalChanges(named)[0].title).toBe('New Lake hero (+k, Krea 2)');
    // An unnamed node's name is already the model's.
    expect(proposalChanges(view())[0].title).toBe('New Krea 2 (+k)');
  });
});

describe('proposalEstimateLabel', () => {
  const priced = (low: number, high: number, open = false) => ({
    ...view(), run: ['+k'], cost: { ...view().cost, estimate: { low, high, open } },
  }) as unknown as ProposalView;

  it('shows a sourced $0 as "$0", not "~$0" (GM, PR #203 r1)', () => {
    expect(proposalEstimateLabel(priced(0, 0))).toBe('$0');
    expect(proposalEstimateLabel(priced(0.07, 0.07))).toBe('~$0.07');
    expect(proposalEstimateLabel(priced(0, 0, true))).toBe('$0+');
  });
});
