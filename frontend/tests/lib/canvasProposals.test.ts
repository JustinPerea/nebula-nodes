import { describe, expect, it } from 'vitest';
import { proposalChanges } from '../../src/lib/canvasProposals';
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
});
