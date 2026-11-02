import { describe, expect, it } from 'vitest';
import { changeCountLabel, proposalChangeCount, proposalChanges } from '../../src/lib/canvasProposals';
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
    expect(proposalChanges(named)[0].title).toBe('New “Lake hero” · Krea 2');
    // An unnamed node's name is already the model's. No ref anywhere a person
    // reads (GM - Design, 2026-11-01).
    expect(proposalChanges(view())[0].title).toBe('New “Krea 2”');
  });

  it('titles a changed node by its name and model, never its id', () => {
    const titled = view();
    titled.params[0] = { ...titled.params[0], title: 'Hero shot', model: 'Krea 2' };
    expect(proposalChanges(titled)[1].title).toBe('“Hero shot” · Krea 2');
    titled.params[0] = { ...titled.params[0], title: 'Krea 2', model: 'Krea 2' };
    expect(proposalChanges(titled)[1].title).toBe('“Krea 2”');
  });

  it('counts operations, one per node group and one per wire, never field lines (GM - Design, PR #216 r2)', () => {
    const groups = proposalChanges(view(), {
      nodes: { '+k': { _provider: 'replicate', prompt: 'x', seed: 2 } },
      params: { n1: { _provider: { from: null, to: 'bfl' } } },
    });
    expect(proposalChangeCount(view(), groups)).toBe(2);
    expect(changeCountLabel(2)).toBe('2 changes');
    expect(changeCountLabel(1)).toBe('1 change');
  });

  it("reads the backend's changeCount, the Update's and MCP's number (GM - Design, PR #216 r3)", () => {
    const counted = { ...view(), changeCount: 7 };
    expect(proposalChangeCount(counted, proposalChanges(counted))).toBe(7);
  });

  it('lists new and removed connections, by name, with the target port', () => {
    const wired: ProposalView = {
      ...view(),
      edges: [{ source: 'n2', sourceHandle: 'text', target: '+k', targetHandle: 'prompt',
        sourceName: 'Prompt', targetName: 'Second take', targetLabel: 'Prompt' }],
      removedEdges: [{ source: 'n3', sourceHandle: 'image', target: 'n1', targetHandle: 'images' }],
      names: { n3: 'Photo' },
    };
    const groups = proposalChanges(wired);
    expect(groups.map((group) => [group.kind, group.title])).toEqual([
      ['new', 'New “Krea 2”'], ['edit', 'Krea 2 (n1)'], ['wires', 'New connections'], ['unwired', 'Removed connections']]);
    expect(groups[2].wires).toEqual([{ id: 'n2.text>+k.prompt', from: '“Prompt”', to: '“Second take”', port: 'Prompt' }]);
    // A view without names on the wire falls back to the names it has, then the handle.
    expect(groups[3].wires?.[0]).toMatchObject({ from: '“Photo”', to: '“n1”', port: 'images' });
    expect(proposalChangeCount(wired, groups)).toBe(4);
  });
});
