import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { placeholderRunConfirm } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// GM - Design, round 6 (2026-10-26), verbatim, and review 5 (H1, L5).

const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const claude = { id: 'ext:claude', name: 'Claude Code', color: '#5B9DFF', verified: false };

function node(id: string, label: string, agent?: typeof codex, definitionId = 'nano-banana', params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label, params, state: 'idle', outputs: {}, ...(agent ? { pending: { agent, at: 1 } } : {}) } } as Node<NodeData>;
}
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, sourceHandle: 'image', targetHandle: 'images' });
const line = (nodeId: string, name: string, low: number, high: number) => ({ nodeId, name, low, high, runs: [1, 1] as [number, number] });
const summaryOf = (cost: Partial<RunCost>): RunScopeSummary => ({ total: 3, paid: [], cost: {
  low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ...cost } });
const text = (model: { rows: Array<{ name: string; model: string | null; price: string }> }) =>
  model.rows.map((row) => [row.name, row.model, row.price].filter(Boolean).join(' · '));

describe('GM round 6, item 1: the footnotes', () => {
  // f (Codex's FLUX still) and u (Codex's upscale) feed o; h (Codex's, priced) too.
  const nodes = [node('h', 'Hero still', codex), node('f', 'Flux still', codex), node('u', 'Upscale', codex),
    node('o', 'Final', undefined, 'image-compare')];
  const edges = [wire('h', 'o'), wire('f', 'o'), wire('u', 'o')];

  it('no total line, no footnote: the rows already say it', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ unpriced: ['Hero still', 'Flux still', 'Upscale'] }))!;
    expect(model.totalLine).toBeNull();
    expect(model.notes).toEqual([]);
  });

  it('one node: “Flux still” has no list price, so the run may cost more.', () => {
    const model = placeholderRunConfirm(nodes.filter((n) => n.id !== 'u'), edges, 'o', summaryOf({
      low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)], unpriced: ['Flux still'] }))!;
    expect(model.totalLine).toBe('The listed prices total $0.43.');
    expect(model.notes).toEqual(['“Flux still” has no list price, so the run may cost more.']);
  });

  it('two nodes, named, quoted', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({
      low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)], unpriced: ['Flux still', 'Upscale'] }))!;
    expect(model.notes).toEqual(['“Flux still” and “Upscale” have no list price, so the run may cost more.']);
  });

  it('three or more: a count', () => {
    const more = [...nodes, node('g', 'Grade', codex)];
    const model = placeholderRunConfirm(more, [...edges, wire('g', 'o')], 'o', summaryOf({
      low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)], unpriced: ['Flux still', 'Upscale', 'Grade'] }))!;
    expect(model.notes).toEqual(['3 nodes have no list price, so the run may cost more.']);
  });
});

describe('GM round 6, item 2: a price waiting on its input', () => {
  const nodes = [node('in', 'Clip', undefined, 'image-input', { filePath: '/api/outputs/a.png' }),
    node('u', 'Upscale', codex, 'seedvr2-upscale')];
  const edges = [{ id: 'e', source: 'in', target: 'u', sourceHandle: 'image', targetHandle: 'image' }];

  it('reads "price depends on its input" in its row, with no "Priced when its input is known" line', () => {
    const model = placeholderRunConfirm(nodes, edges, 'u', summaryOf({ unpriced: ['Upscale'], awaitingInput: ['Upscale'] }))!;
    expect(text(model)[0]).toMatch(/^“Upscale” · .+ · price depends on its input$/);
    expect(model.notes).toEqual([]);
    expect(model.runLabel).toBe('Run');
  });

  it("an input Nebula can't read the size of says the same, with no note either", () => {
    const model = placeholderRunConfirm(nodes, edges, 'u', summaryOf({
      unpriced: ['Upscale'], awaitingInput: ['Upscale'], sizeUnreadable: ['Upscale'] }))!;
    expect(model.rows[0].price).toBe('price depends on its input');
    expect(model.notes).toEqual([]);
  });
});

describe('GM round 6, item 3 and review 5, L5: every dollar in the total has a row', () => {
  // Codex's placeholder h and the person's own paid node p both feed o (free).
  const nodes = [node('h', 'Hero still', codex), node('p', 'Plate', undefined), node('o', 'Final', undefined, 'image-compare')];
  const edges = [wire('h', 'o'), wire('p', 'o')];

  it('a paid node that is no placeholder gets a muted row with no agent, after the placeholders', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ low: 0.5, high: 0.5,
      lines: [line('h', 'Hero still', 0.43, 0.43), line('p', 'Plate', 0.07, 0.07)] }))!;
    expect(text(model)).toEqual(['“Hero still” · Nano Banana 2 (3.1 Flash) · $0.43', '“Plate” · Nano Banana 2 (3.1 Flash) · $0.07']);
    expect(model.rows.map((row) => row.agent?.name ?? null)).toEqual(['Codex', null]);
    expect(model.totalLine).toBe('This run could cost up to $0.50 at list prices.');
    expect(model.runLabel).toBe('Run for $0.50');
  });

  it('a normal paid node with no list price: "price not listed", plain "Run", the listed total and a footnote', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ low: 0.067, high: 0.067,
      lines: [line('h', 'Hero still', 0.067, 0.067)], unpriced: ['Plate'] }))!;
    expect(text(model)).toEqual(['“Hero still” · Nano Banana 2 (3.1 Flash) · $0.067', '“Plate” · Nano Banana 2 (3.1 Flash) · price not listed']);
    expect(model.runLabel).toBe('Run');
    // In cents, rounded up (review 6, L-e; GM round 7); the row keeps $0.067.
    expect(model.totalLine).toBe('The listed prices total $0.07.');
    expect(model.notes).toEqual(['“Plate” has no list price, so the run may cost more.']);
  });

  it('prices each row by its node, not its name, when two share a name', () => {
    const twins = [node('h', 'Still', codex), node('p', 'Still'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(twins, edges, 'o', summaryOf({ low: 0.07, high: 0.07,
      lines: [line('p', 'Still', 0.07, 0.07)], unpriced: ['Still'], ids: { unpriced: ['h'], plan: [], awaitingInput: [] } }))!;
    expect(model.rows.map((row) => row.price)).toEqual(['price not listed', '$0.07']);
  });
});

describe('GM round 6, item 3: from Cinema the button says Generate', () => {
  const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a cat' }] };
  const nodes = [node('t', 'Hero prompt', codex, 'text-input'), node('h', 'Hero still', codex),
    node('cine', 'Scene', undefined, 'cinema-scene', { scene })];
  const edges = [{ id: 'e0', source: 't', target: 'h', sourceHandle: 'text', targetHandle: 'prompt' }, wire('h', 'cine')];
  const range = summaryOf({ low: 0.0747, high: 0.5, lines: [line('h', 'Hero still', 0.0047, 0.43), line('cine', 'Scene', 0.07, 0.07)] });

  it('“Shot 1” · Nano Banana · $0.07 above the free line, and "Generate for up to $0.50"', () => {
    const model = placeholderRunConfirm(nodes, edges, 'cine', range, { verb: 'Generate', names: { cine: 'Shot 1' } })!;
    expect(model.heading).toBe('Run 2 nodes Codex is still setting up?');
    expect(text(model)).toEqual(['“Hero still” · Nano Banana 2 (3.1 Flash) · $0.0047–$0.43', '“Shot 1” · Nano Banana · $0.07']);
    expect(model.freeLine).toBe('Plus 1 free node.');
    expect(model.totalLine).toBe('This run could cost up to $0.50 at list prices.');
    expect(model.runLabel).toBe('Generate for up to $0.50');
  });

  it('"Generate for $X" for a fixed price and plain "Generate" where the canvas says plain "Run"', () => {
    const fixed = placeholderRunConfirm(nodes, edges, 'cine', summaryOf({ low: 0.5, high: 0.5,
      lines: [line('h', 'Hero still', 0.43, 0.43), line('cine', 'Scene', 0.07, 0.07)] }), { verb: 'Generate' })!;
    expect(fixed.runLabel).toBe('Generate for $0.50');
    const unlisted = placeholderRunConfirm(nodes, edges, 'cine', summaryOf({ unpriced: ['Hero still', 'Scene'] }), { verb: 'Generate' })!;
    expect(unlisted.runLabel).toBe('Generate');
  });
});

describe('review 5, H1 (GM copy answer): once no placeholder is left', () => {
  const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
  const edges = [wire('h', 'o'), wire('p', 'o')];
  const priced = summaryOf({ low: 9.07, high: 9.07, lines: [line('h', 'Hero still', 9, 9), line('p', 'Plate', 0.07, 0.07)] });

  it('nothing shown before and no paid placeholder: no dialog, as before', () => {
    expect(placeholderRunConfirm(nodes, edges, 'o', priced)).toBeNull();
  });

  it('"Run with Codex\'s changes?" and "Codex finished setting up this node." with its rows as usual', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex]]) })!;
    expect(model.heading).toBe("Run with Codex's changes?");
    // One finished node: "this node" (GM - Design, round 7, item 1).
    expect(model.intro).toBe('Codex finished setting up this node.');
    expect(text(model)).toEqual(['“Hero still” · Nano Banana 2 (3.1 Flash) · $9.00', '“Plate” · Nano Banana 2 (3.1 Flash) · $0.07']);
    expect(model.rows.map((row) => row.agent?.name ?? null)).toEqual(['Codex', null]);
    expect(model.runLabel).toBe('Run for $9.07');
    expect(model.confirmIds).toEqual([]);
    expect(model.confirmCost).toBe(9.07);
  });

  it('several agents: "Run with the agents\' changes?" / "The agents finished setting up these nodes."', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex], ['p', claude]]) })!;
    expect(model.heading).toBe("Run with the agents' changes?");
    expect(model.intro).toBe('The agents finished setting up these nodes.');
  });

  it('from Cinema: the same heading, with the Generate button', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex]]), verb: 'Generate' })!;
    expect(model.heading).toBe("Run with Codex's changes?");
    expect(model.runLabel).toBe('Generate for $9.07');
  });

  it('some still left: the original heading, counting only those', () => {
    const left = [node('h', 'Hero still'), node('p', 'Plate', codex), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(left, edges, 'o', priced, { shown: new Map([['h', codex], ['p', codex]]) })!;
    expect(model.heading).toBe('Run 1 node Codex is still setting up?');
    expect(model.intro).toBe("Codex hasn't finished this, so its settings may not be final.");
    expect(model.confirmIds).toEqual(['p']);
  });
});
