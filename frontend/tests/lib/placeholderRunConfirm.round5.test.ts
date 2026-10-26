import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRefusalOf, placeholderRunConfirm, withRunEstimate } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';
import { ExecutionStartRejectedError } from '../../src/lib/api';

// Review 4 and GM - Design's round-5 answers (2026-10-25), verbatim:
// "a dollar amount shows only when it covers every paid row; Krea-plan rows
// cost nothing extra and don't count as missing."

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };

function node(id: string, label: string, agent?: typeof codex): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'nano-banana', label, params: {}, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const line = (nodeId: string, name: string, low: number, high: number) => ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 2, paid: ['Hero still'], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });

// i (Codex's) feeds o; k (Codex's) feeds o too.
const nodes = [node('i', 'Hero still', codex), node('k', 'Krea still', codex), node('o', 'Final')];
const edges = [wire('i', 'o'), wire('k', 'o')];

describe("GM round 5: the placeholder dialog's $0 lines", () => {
  it('only Krea-plan rows: no total line, and the button reads "Run"', () => {
    const model = placeholderRunConfirm(nodes.slice(0, 2), [], 'i', summaryOf({ plan: ['Hero still', 'Krea still'] }))!;
    const one = placeholderRunConfirm([node('k', 'Krea still', codex)], [], 'k', summaryOf({ plan: ['Krea still'] }))!;
    expect(one.rows.map((row) => row.price)).toEqual(['on your Krea plan']);
    expect(one.totalLine).toBeNull();
    expect(one.runLabel).toBe('Run');
    expect(model.runLabel).toBe('Run');
  });

  it('every row "price not listed": no total line, and the button reads "Run"', () => {
    const model = placeholderRunConfirm([node('i', 'Hero still', codex)], [], 'i', summaryOf({ unpriced: ['Hero still'] }))!;
    expect(model.rows.map((row) => row.price)).toEqual(['price not listed']);
    expect(model.totalLine).toBeNull();
    expect(model.runLabel).toBe('Run');
  });

  it('Krea-plan rows plus priced rows: the total line and the button with only the priced amount', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({
      low: 0.0047, high: 0.43, lines: [line('i', 'Hero still', 0.0047, 0.43)], plan: ['Krea still'] }))!;
    expect(model.rows.map((row) => row.price)).toEqual(['$0.0047–0.43', 'on your Krea plan']);
    expect(model.totalLine).toBe('This run could cost up to $0.43 at list prices.');
    expect(model.runLabel).toBe('Run for up to $0.43');
  });

  it('unlisted rows plus priced rows: plain "Run", and "The listed prices total up to $0.43." for a range', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({
      low: 0.0047, high: 0.43, lines: [line('i', 'Hero still', 0.0047, 0.43)], unpriced: ['Krea still'] }))!;
    expect(model.rows.map((row) => row.price)).toEqual(['$0.0047–0.43', 'price not listed']);
    expect(model.totalLine).toBe('The listed prices total up to $0.43.');
    expect(model.runLabel).toBe('Run');
  });

  it('unlisted rows plus a fixed price: "The listed prices total $0.43."', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({
      low: 0.43, high: 0.43, lines: [line('i', 'Hero still', 0.43, 0.43)], unpriced: ['Krea still'] }))!;
    expect(model.totalLine).toBe('The listed prices total $0.43.');
    expect(model.runLabel).toBe('Run');
  });
});

describe('review 4, L1: the total the run sends', () => {
  it('is rounded to 6 places, as Nebula rounds its own', () => {
    const model = placeholderRunConfirm([node('i', 'Hero still', codex)], [], 'i', summaryOf({
      low: 0.00005024, high: 0.00005024, lines: [line('i', 'Hero still', 0.00005024, 0.00005024)] }))!;
    expect(model.confirmCost).toBe(0.00005);
  });

  it('is still sent ($0) when the dialog shows no total, so Nebula can hold the run to it', () => {
    const model = placeholderRunConfirm([node('i', 'Hero still', codex)], [], 'i', summaryOf({ unpriced: ['Hero still'] }))!;
    expect(model.confirmCost).toBe(0);
  });
});

describe("review 4, M1: Nebula's own estimate from its refusal", () => {
  const refusal = new ExecutionStartRejectedError('Nothing ran.', 409, { detail: {
    code: 'placeholder_confirm_required', message: 'Nothing ran.', placeholders: ['i'],
    agents: { i: codex },
    estimate: { low: 0.03, high: 0.03, nodes: { i: { low: 0.03, high: 0.03 } }, unpriced: [], plan: [], plus: [],
      unavailable: {}, awaitingInput: [] },
  } });

  it('reads the refusal', () => {
    expect(placeholderRefusalOf(refusal)).toMatchObject({ placeholders: ['i'], estimate: { high: 0.03 } });
    expect(placeholderRefusalOf(new ExecutionStartRejectedError('No.', 409, { detail: 'busy' }))).toBeNull();
    expect(placeholderRefusalOf(new Error('x'))).toBeNull();
  });

  it("prices the rows and the total at Nebula's numbers, which the run then confirms", () => {
    const shown = summaryOf({ unpriced: ['Hero still'] }); // the tab had no key: "price not listed"
    const { estimate } = placeholderRefusalOf(refusal)!;
    const model = placeholderRunConfirm([node('i', 'Hero still', codex)], [], 'i', withRunEstimate(shown, estimate!, [node('i', 'Hero still', codex)]))!;
    expect(model.rows.map((row) => row.price)).toEqual(['$0.03']);
    expect(model.totalLine).toBe('This run could cost up to $0.03 at list prices.');
    expect(model.runLabel).toBe('Run for $0.03');
    expect(model.confirmCost).toBe(0.03);
  });
});
