import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRunConfirm } from '../../src/lib/placeholderRunConfirm';
import { summarizeRunScope, type RunCost, type RunScopeSummary } from '../../src/lib/runScope';
import type { PricingTable } from '../../src/lib/pricing';

// Q133 (Justin, 2026-10-25): the person's direct run always asks first when a
// placeholder it would run calls a paid model. GM - Design's copy, verbatim.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const cursor = { id: 'self:cursor', name: 'Cursor', color: '#5B8DEF', verified: false };

function node(id: string, definitionId: string, label: string, agent?: typeof codex, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string, targetHandle = 'prompt'): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'text', targetHandle });

const pricing: PricingTable = { currencies: {}, nodes: {
  'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.12 }] },
} } as unknown as PricingTable;

function confirmFor(nodes: Node<NodeData>[], edges: Edge[], target: string) {
  const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: target },
    { pricing, apiKeys: { GOOGLE_API_KEY: 'set' } });
  return placeholderRunConfirm(nodes, edges, target, summary);
}

describe('placeholderRunConfirm', () => {
  it('asks nothing when every placeholder in the run is free', () => {
    const nodes = [node('p', 'text-input', 'Hero prompt', codex), node('i', 'nano-banana', 'Hero still')];
    expect(confirmFor(nodes, [wire('p', 'i')], 'i')).toBeNull();
  });

  it("one agent's: GM's copy, a row per paid placeholder, the free ones in one line, the whole run's total", () => {
    const nodes = [
      node('p', 'text-input', 'Hero prompt', codex),
      node('i', 'nano-banana', 'Hero still', codex, { model: 'gemini-3-pro-image' }),
      node('o', 'nano-banana', 'Final'),
    ];
    const model = confirmFor(nodes, [wire('p', 'i'), wire('i', 'o', 'images')], 'o')!;
    expect(model.heading).toBe('Run 2 nodes Codex is still setting up?');
    expect(model.intro).toBe("Codex hasn't finished these, so their settings may not be final.");
    expect(model.rows).toEqual([{ nodeId: 'i', name: '“Hero still”', model: 'Nano Banana Pro (3 Pro)', price: '$0.12', agent: codex }]);
    expect(model.freeLine).toBe('Plus 1 free node.');
    // The whole run: the placeholder and the node after it.
    expect(model.totalLine).toBe('This run could cost up to $0.24 at list prices.');
    expect(model.runLabel).toBe('Run for $0.24');
    expect(model.confirmIds).toEqual(['i']);
  });

  it('several agents: "agents are", "Agents haven\'t", and a plural free line', () => {
    const nodes = [
      node('p', 'text-input', 'Hero prompt', codex),
      node('q', 'text-input', 'Alt prompt', cursor),
      node('i', 'nano-banana', 'Hero still', cursor),
    ];
    const model = confirmFor(nodes, [wire('p', 'i'), wire('q', 'i', 'text')], 'i')!;
    expect(model.heading).toBe('Run 3 nodes agents are still setting up?');
    expect(model.intro).toBe("Agents haven't finished these, so their settings may not be final.");
    expect(model.rows.map((row) => [row.name, row.agent.verified])).toEqual([['“Hero still”', false]]);
    expect(model.freeLine).toBe('Plus 2 free nodes.');
    expect(model.totalLine).toBe('This run could cost up to $0.12 at list prices.');
  });

  it('counts only the placeholders this run runs', () => {
    const nodes = [node('i', 'nano-banana', 'Hero still', codex), node('x', 'nano-banana', 'Elsewhere', codex)];
    const model = confirmFor(nodes, [], 'i')!;
    expect(model.heading).toBe('Run 1 node Codex is still setting up?');
    expect(model.confirmIds).toEqual(['i']);
    expect(model.freeLine).toBeNull();
  });

  it('still asks with no price table, with a plain Run', () => {
    const nodes = [node('i', 'nano-banana', 'Hero still', codex)];
    const summary = summarizeRunScope(nodes, [], { kind: 'node', nodeId: 'i' });
    const model = placeholderRunConfirm(nodes, [], 'i', summary)!;
    expect(model.totalLine).toBeNull();
    expect(model.runLabel).toBe('Run');
    expect(model.rows[0].price).toBe('price not listed');
    expect(model.confirmCost).toBeNull();
  });

  // GM - Design, round 4 (2026-10-25), verbatim.
  describe("GM's round-4 copy", () => {
    const line = (nodeId: string, name: string, low: number, high: number) =>
      ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
    const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 1, paid: ['Hero still'], cost: {
      low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });

    it('one placeholder: "Codex hasn\'t finished this, so its settings may not be final."', () => {
      const model = confirmFor([node('i', 'nano-banana', 'Hero still', codex)], [], 'i')!;
      expect(model.intro).toBe("Codex hasn't finished this, so its settings may not be final.");
    });

    it('a fixed total: "Run for $0.12"; a range: "Run for up to $0.86"', () => {
      const nodes = [node('i', 'nano-banana', 'Hero still', codex)];
      const fixed = placeholderRunConfirm(nodes, [], 'i', summaryOf({ low: 0.12, high: 0.12, lines: [line('i', 'Hero still', 0.12, 0.12)] }))!;
      expect(fixed.runLabel).toBe('Run for $0.12');
      expect(fixed.confirmCost).toBe(0.12);
      const range = placeholderRunConfirm(nodes, [], 'i', summaryOf({ low: 0.0094, high: 0.86, lines: [line('i', 'Hero still', 0.0094, 0.86)] }))!;
      expect(range.runLabel).toBe('Run for up to $0.86');
      // The total line keeps its words.
      expect(range.totalLine).toBe('This run could cost up to $0.86 at list prices.');
      expect(range.confirmCost).toBe(0.86);
    });

    it('a row with no list price: "price not listed", and the button is just "Run"', () => {
      const nodes = [node('i', 'nano-banana', 'Hero still', codex), node('j', 'nano-banana', 'Alt still', codex)];
      const model = placeholderRunConfirm(nodes, [wire('j', 'i', 'images')], 'i', summaryOf({
        low: 0.12, high: 0.12, lines: [line('i', 'Hero still', 0.12, 0.12)], unpriced: ['Alt still'] }))!;
      expect(model.rows.map((row) => row.price)).toEqual(['$0.12', 'price not listed']);
      expect(model.runLabel).toBe('Run');
      expect(model.totalLine).toBe('This run could cost up to $0.12 at list prices.');
    });

    it('a Krea-plan row: "on your Krea plan", which is not a missing price', () => {
      const nodes = [node('i', 'nano-banana', 'Hero still', codex), node('k', 'nano-banana', 'Krea still', codex)];
      const model = placeholderRunConfirm(nodes, [wire('k', 'i', 'images')], 'i', summaryOf({
        low: 0.12, high: 0.12, lines: [line('i', 'Hero still', 0.12, 0.12)], plan: ['Krea still'] }))!;
      expect(model.rows.map((row) => row.price)).toEqual(['$0.12', 'on your Krea plan']);
      expect(model.runLabel).toBe('Run for $0.12');
    });
  });
});
