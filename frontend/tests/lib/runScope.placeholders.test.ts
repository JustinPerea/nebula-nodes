import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { describeRunScope, runChipLabel, runCostConfirmMessage, summarizeRunScope } from '../../src/lib/runScope';
import type { PricingTable } from '../../src/lib/pricing';
import type { NodeData } from '../../src/types';

/**
 * The cost shown before a run agrees with what the run will do with agents'
 * placeholders (Q125 item 3). GM - Design, 2026-10-25, verbatim: "the cost
 * shown before the person's Run must count the placeholders it will run and
 * say so, with a line under the cost: “Includes 2 nodes Codex is still
 * setting up.” With several agents: “Includes 3 nodes the agents are still
 * setting up.” ... for a whole-canvas Run that SKIPS placeholders, the cost
 * shown must leave out the skipped nodes and everything downstream of them."
 * The backend's spend check prices only what runs (main._skip_placeholders):
 * a whole-canvas Run, Run selected and an accepted proposal's run skip every
 * placeholder and what needs it; the person's direct run of a node runs the
 * placeholders that feed it.
 */

const CODEX = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const CLAUDE = { agent: { id: 'claude', name: 'Claude Code', color: '#D97757', verified: false }, at: 1 };

const pricing: PricingTable = {
  currencies: {},
  nodes: { 'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.05 }] } },
};
const context = { pricing, apiKeys: {} };

const image = (id: string, pending?: unknown): Node<NodeData> => ({
  id, position: { x: 0, y: 0 },
  data: { definitionId: 'nano-banana', label: id, params: {}, ...(pending ? { pending } : {}) } as unknown as NodeData,
});
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, targetHandle: 'image' });

// p (Codex's placeholder) -> t; o stands alone.
const nodes = [image('p', CODEX), image('t'), image('o')];
const edges = [wire('p', 't')];

describe('a whole-canvas Run skips placeholders, and its cost leaves them out', () => {
  it('prices only what runs and says what it skips', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' }, context);
    expect(summary.total).toBe(1);
    expect(summary.paid).toEqual(['o']);
    expect(summary.cost?.high).toBeCloseTo(0.05);
    expect(runChipLabel(summary)).toBe('~$0.05');
    expect(summary.pendingSkipped).toEqual({ count: 2, agents: ['Codex'] });
    expect(summary.pendingIncluded).toBeUndefined();
  });

  it('Run selected skips them the same way', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'cluster', nodeIds: ['p', 't', 'o'] }, context);
    expect(summary.total).toBe(1);
    expect(summary.cost?.high).toBeCloseTo(0.05);
    expect(summary.pendingSkipped).toEqual({ count: 2, agents: ['Codex'] });
  });

  it("an accepted proposal's run of a node (not the person's direct run) skips them", () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 't', direct: false }, context);
    expect(summary.total).toBe(0);
    expect(summary.paid).toEqual([]);
    expect(summary.pendingSkipped).toEqual({ count: 2, agents: ['Codex'] });
  });
});

describe("the person's direct run of a node counts the placeholders it runs and says so", () => {
  it('prices the placeholder and what it feeds, with the line under the cost', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 't' }, context);
    expect(summary.total).toBe(2);
    expect(summary.cost?.high).toBeCloseTo(0.1);
    expect(summary.pendingIncluded).toEqual({ count: 2, agents: ['Codex'] });
    expect(summary.pendingSkipped).toBeUndefined();
    expect(runCostConfirmMessage(summary)).toContain(
      'This run could cost up to $0.10 at list prices.\nIncludes 2 nodes Codex is still setting up.');
    expect(describeRunScope(summary)).toContain('Includes 2 nodes Codex is still setting up');
  });

  it('says "agents" when the placeholders are more than one agent\'s', () => {
    const two = [image('p', CODEX), image('q', CLAUDE), image('t')];
    const summary = summarizeRunScope(two, [wire('p', 't'), wire('q', 't')], { kind: 'node', nodeId: 't' }, context);
    expect(summary.pendingIncluded).toEqual({ count: 3, agents: ['Codex', 'Claude Code'] });
    expect(runCostConfirmMessage(summary)).toContain('Includes 3 nodes the agents are still setting up.');
  });

  it('says nothing when no placeholder is in the run', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'o' }, context);
    expect(summary.pendingIncluded).toBeUndefined();
    expect(runCostConfirmMessage(summary)).not.toContain('Includes');
  });
});
