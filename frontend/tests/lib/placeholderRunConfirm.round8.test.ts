import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { formatConfirmUsd, placeholderRunConfirm, roundUpToCent } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// Review 7 (L1, L4) and GM - Design's round 8 (item 2), verbatim.

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };

function node(id: string, label: string, agent?: typeof codex, definitionId = 'nano-banana', params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const line = (nodeId: string, name: string, low: number, high: number) => ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 3, paid: [], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });

describe('GM round 8, item 2: the left line under the still-setting-up heading too', () => {
  it('body, then the left line ("1 node Codex was setting up is no longer in this run.")', () => {
    // h is still Codex's placeholder; g, which the dialog showed, was deleted.
    const nodes = [node('h', 'Hero still', codex), node('o', 'Final', undefined, 'image-compare')];
    const priced = summaryOf({ low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)] });
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced, { shown: new Map([['h', codex], ['g', codex]]) })!;
    expect(model.heading).toBe('Run 1 node Codex is still setting up?');
    expect(model.intro).toBe("Codex hasn't finished this, so its settings may not be final.");
    expect(model.leftLine).toBe('1 node Codex was setting up is no longer in this run.');
  });

  it('two left: "2 nodes Codex was setting up are no longer in this run."', () => {
    const nodes = [node('h', 'Hero still', codex), node('o', 'Final', undefined, 'image-compare')];
    const priced = summaryOf({ low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)] });
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['g', codex], ['k', codex]]) })!;
    expect(model.leftLine).toBe('2 nodes Codex was setting up are no longer in this run.');
  });

  it('nothing left the run: no left line', () => {
    const nodes = [node('h', 'Hero still', codex), node('o', 'Final', undefined, 'image-compare')];
    const priced = summaryOf({ low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)] });
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced, { shown: new Map([['h', codex]]) })!;
    expect(model.leftLine).toBeNull();
  });
});

describe("review 7, L1: a replay's saved copy of a placeholder that is no longer on the canvas", () => {
  // The replay still sends h's saved copy (it runs, priced in the total), but
  // Codex's placeholder is gone: never "finished", it left this run.
  const priced = summaryOf({ low: 1.2, high: 1.2, lines: [line('h', 'Hero still', 0.6, 0.6), line('o', 'Final', 0.6, 0.6)] });

  it('none finished: "Run without the node Codex was setting up?", and the saved copy is a muted row', () => {
    const nodes = [node('h', 'Hero still'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o')], 'o', priced,
      { shown: new Map([['h', codex]]), gone: new Set(['h']) } as never)!;
    expect(model.heading).toBe('Run without the node Codex was setting up?');
    expect(model.intro).toBe("It's no longer in this run.");
    expect(model.rows.map((row) => [row.nodeId, row.agent])).toEqual([['h', null], ['o', null]]);
    expect(model.runLabel).toBe('Run for $1.20');
  });

  it('one finished, one gone: the changes heading counts only the finished, then the left line', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o'), wire('p', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['p', codex]]), gone: new Set(['h']) } as never)!;
    expect(model.heading).toBe("Run with Codex's changes?");
    expect(model.intro).toBe('Codex finished setting up this node.');
    expect(model.leftLine).toBe('1 node Codex was setting up is no longer in this run.');
    expect(model.rows.find((row) => row.nodeId === 'p')?.agent).toEqual(codex);
    expect(model.rows.find((row) => row.nodeId === 'h')?.agent).toBeNull();
  });
});

describe('review 7, L4: any amount above zero confirms at least $0.01', () => {
  it.each([4e-7, 4.9e-7, 1e-9, Number.MIN_VALUE])('%s rounds up to $0.01', (amount) => {
    expect(roundUpToCent(amount)).toBe(0.01);
    expect(formatConfirmUsd(amount)).toBe('$0.01');
  });

  it('zero stays zero, and the 6-place read still keeps float noise out', () => {
    expect(roundUpToCent(0)).toBe(0);
    expect(roundUpToCent(0.07)).toBe(0.07);
    expect(roundUpToCent(0.0700004)).toBe(0.07);
    expect(roundUpToCent(0.201)).toBe(0.21);
  });
});
