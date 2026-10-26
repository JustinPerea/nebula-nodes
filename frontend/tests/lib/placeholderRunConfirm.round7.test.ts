import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { formatConfirmUsd, placeholderRunConfirm, roundUpToCent } from '../../src/lib/placeholderRunConfirm';
import type { RunCost, RunScopeSummary } from '../../src/lib/runScope';

// GM - Design, round 7 (2026-10-26) and its answers to review 6 (L-b, L-e), verbatim.

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

describe('GM round 7, item 1: "finished setting up this node / these nodes"', () => {
  const edges = [wire('h', 'o'), wire('p', 'o')];
  const priced = summaryOf({ low: 0.5, high: 0.5, lines: [line('h', 'Hero still', 0.43, 0.43), line('p', 'Plate', 0.07, 0.07)] });

  it('one finished node: "Codex finished setting up this node."', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex]]) })!;
    expect(model.heading).toBe("Run with Codex's changes?");
    expect(model.intro).toBe('Codex finished setting up this node.');
    expect(model.leftLine).toBeNull();
  });

  it('two finished nodes: "Codex finished setting up these nodes."', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex], ['p', codex]]) })!;
    expect(model.intro).toBe('Codex finished setting up these nodes.');
  });

  it('several agents: "The agents finished setting up these nodes."', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, edges, 'o', priced, { shown: new Map([['h', codex], ['p', claude]]) })!;
    expect(model.heading).toBe("Run with the agents' changes?");
    expect(model.intro).toBe('The agents finished setting up these nodes.');
  });
});

describe('review 6, L-b (GM answer): placeholders the dialog showed that left the run', () => {
  const priced = summaryOf({ low: 0.07, high: 0.07, lines: [line('p', 'Plate', 0.07, 0.07)] });

  it('one, none finished: "Run without the node Codex was setting up?" / "It\'s no longer in this run."', () => {
    // h was deleted (or disconnected): it is no longer in o's run.
    const nodes = [node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, [wire('p', 'o')], 'o', priced, { shown: new Map([['h', codex]]) })!;
    expect(model.heading).toBe('Run without the node Codex was setting up?');
    expect(model.intro).toBe("It's no longer in this run.");
    expect(model.leftLine).toBeNull();
    expect(model.rows.map((row) => row.nodeId)).toEqual(['p']);
    expect(model.runLabel).toBe('Run for $0.07');
  });

  it('two of one agent: "Run without the nodes Codex was setting up?" / "They\'re no longer in this run."', () => {
    const nodes = [node('p', 'Plate'), node('h', 'Hero still', codex), node('o', 'Final', undefined, 'image-compare')];
    // h is still a placeholder on the canvas, but disconnected from o's run.
    const model = placeholderRunConfirm(nodes, [wire('p', 'o')], 'o', priced, { shown: new Map([['h', codex], ['g', codex]]) })!;
    expect(model.heading).toBe('Run without the nodes Codex was setting up?');
    expect(model.intro).toBe("They're no longer in this run.");
  });

  it('several agents: "Run without the nodes agents were setting up?"', () => {
    const nodes = [node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, [wire('p', 'o')], 'o', priced, { shown: new Map([['h', codex], ['g', claude]]) })!;
    expect(model.heading).toBe('Run without the nodes agents were setting up?');
    expect(model.intro).toBe("They're no longer in this run.");
  });

  it('some finished, one left: the changes heading, the finished count, then "1 node Codex was setting up is no longer in this run."', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o'), wire('p', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['g', codex]]) })!;
    expect(model.heading).toBe("Run with Codex's changes?");
    expect(model.intro).toBe('Codex finished setting up this node.');
    expect(model.leftLine).toBe('1 node Codex was setting up is no longer in this run.');
  });

  it('some finished, two left: "2 nodes Codex was setting up are no longer in this run."', () => {
    const nodes = [node('h', 'Hero still'), node('p', 'Plate'), node('o', 'Final', undefined, 'image-compare')];
    const model = placeholderRunConfirm(nodes, [wire('h', 'o'), wire('p', 'o')], 'o', priced,
      { shown: new Map([['h', codex], ['g', codex], ['k', codex]]) })!;
    expect(model.leftLine).toBe('2 nodes Codex was setting up are no longer in this run.');
  });
});

describe('GM round 7, item 2: rows priced by their input under a total', () => {
  const nodes = [node('h', 'Hero still', codex), node('u', 'Upscale', codex), node('g', 'Grade', codex), node('f', 'Flux still', codex),
    node('o', 'Final', undefined, 'image-compare')];
  const edges = [wire('h', 'o'), wire('u', 'o'), wire('g', 'o'), wire('f', 'o')];
  const total = { low: 0.43, high: 0.43, lines: [line('h', 'Hero still', 0.43, 0.43)] };
  const ids = (unpriced: string[], awaitingInput: string[]) => ({ ids: { unpriced, plan: [], awaitingInput } });

  it('one: the button drops the amount, "“Upscale” is priced by its input, so the run may cost more."', () => {
    const model = placeholderRunConfirm(nodes.filter((n) => !['g', 'f'].includes(n.id)), edges, 'o', summaryOf({ ...total,
      unpriced: ['Upscale'], awaitingInput: ['Upscale'], ...ids(['u'], ['u']) }))!;
    expect(model.rows.find((row) => row.nodeId === 'u')?.price).toBe('price depends on its input');
    expect(model.runLabel).toBe('Run');
    expect(model.totalLine).toBe('The listed prices total $0.43.');
    expect(model.notes).toEqual(['“Upscale” is priced by its input, so the run may cost more.']);
  });

  it('two: "“Upscale” and “Grade” are priced by their input, so the run may cost more."', () => {
    const model = placeholderRunConfirm(nodes.filter((n) => n.id !== 'f'), edges, 'o', summaryOf({ ...total,
      unpriced: ['Upscale', 'Grade'], awaitingInput: ['Upscale', 'Grade'], ...ids(['u', 'g'], ['u', 'g']) }))!;
    expect(model.notes).toEqual(['“Upscale” and “Grade” are priced by their input, so the run may cost more.']);
  });

  it('three or more by their input: "3 nodes have no price yet, so the run may cost more."', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ ...total,
      unpriced: ['Upscale', 'Grade', 'Flux still'], awaitingInput: ['Upscale', 'Grade', 'Flux still'],
      ...ids(['u', 'g', 'f'], ['u', 'g', 'f']) }))!;
    expect(model.notes).toEqual(['3 nodes have no price yet, so the run may cost more.']);
  });

  it('both kinds together: "2 nodes have no price yet, so the run may cost more."', () => {
    const model = placeholderRunConfirm(nodes.filter((n) => n.id !== 'g'), edges, 'o', summaryOf({ ...total,
      unpriced: ['Upscale', 'Flux still'], awaitingInput: ['Upscale'], ...ids(['u', 'f'], ['u']) }))!;
    expect(model.notes).toEqual(['2 nodes have no price yet, so the run may cost more.']);
    expect(model.runLabel).toBe('Run');
  });

  it('both kinds, three nodes: "3 nodes have no price yet, so the run may cost more."', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ ...total,
      unpriced: ['Upscale', 'Grade', 'Flux still'], awaitingInput: ['Upscale', 'Grade'], ...ids(['u', 'g', 'f'], ['u', 'g']) }))!;
    expect(model.notes).toEqual(['3 nodes have no price yet, so the run may cost more.']);
  });

  it('only unlisted rows keep round 6\'s words', () => {
    const model = placeholderRunConfirm(nodes.filter((n) => !['u', 'g'].includes(n.id)), edges, 'o', summaryOf({ ...total,
      unpriced: ['Flux still'], ...ids(['f'], []) }))!;
    expect(model.notes).toEqual(['“Flux still” has no list price, so the run may cost more.']);
  });
});

describe('review 6, L-e (GM answer): amounts the person confirms show cents, rounded up', () => {
  it.each([
    [0.201, '$0.21', 0.21],
    [10.481, '$10.49', 10.49],
    [10.49, '$10.49', 10.49],
    [0.0047, '$0.01', 0.01],
    [0.07, '$0.07', 0.07],
    [0.43, '$0.43', 0.43],
    [1.2, '$1.20', 1.2],
    [9.6, '$9.60', 9.6],
    [0.29, '$0.29', 0.29],
    [123.456, '$123.46', 123.46],
  ])('%s shows %s and confirms %s', (amount, shown, sent) => {
    expect(formatConfirmUsd(amount)).toBe(shown);
    expect(roundUpToCent(amount)).toBe(sent);
  });

  const nodes = [node('h', 'Hero still', codex), node('o', 'Final', undefined, 'image-compare')];
  const edges = [wire('h', 'o')];

  it('the button, the total line and the confirmed cost: $0.201 is "$0.21" and sends 0.21; the row keeps its own format', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ low: 0.201, high: 0.201, lines: [line('h', 'Hero still', 0.201, 0.201)] }))!;
    expect(model.runLabel).toBe('Run for $0.21');
    expect(model.totalLine).toBe('This run could cost up to $0.21 at list prices.');
    expect(model.confirmCost).toBe(0.21);
    expect(model.rows[0].price).toBe('$0.20');
  });

  it('never whole dollars: $10.481 is "Run for $10.49", not "$10"', () => {
    const model = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ low: 10.481, high: 10.481, lines: [line('h', 'Hero still', 10.481, 10.481)] }))!;
    expect(model.runLabel).toBe('Run for $10.49');
    expect(model.totalLine).toBe('This run could cost up to $10.49 at list prices.');
    expect(model.confirmCost).toBe(10.49);
  });

  it('a range: "Run for up to $0.43" and the listed-total line in cents', () => {
    const range = placeholderRunConfirm(nodes, edges, 'o', summaryOf({ low: 0.0047, high: 0.4301, lines: [line('h', 'Hero still', 0.0047, 0.4301)] }))!;
    expect(range.runLabel).toBe('Run for up to $0.44');
    expect(range.confirmCost).toBe(0.44);
    const withUnlisted = placeholderRunConfirm([...nodes, node('f', 'Flux still', codex)], [...edges, wire('f', 'o')], 'o', summaryOf({
      low: 0.067, high: 0.067, lines: [line('h', 'Hero still', 0.067, 0.067)], unpriced: ['Flux still'] }))!;
    expect(withUnlisted.totalLine).toBe('The listed prices total $0.07.');
    expect(withUnlisted.confirmCost).toBe(0.07);
  });
});
