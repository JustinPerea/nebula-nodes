import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { undosToFitSave, type UndoWalkStep } from '../src/lib/saveFixStep';
import { applySlice, edgeKey, ownAddStep, type GraphSlice, type OwnParamChange } from '../src/lib/canvasUndo';
import * as shared from '../src/lib/graphFileShared';

// Review 8 of PR #205, limits LOW-2, LOW-3 and NIT-2: Save's Undo walk applies
// each step as Undo does (connections keyed by edgeKey on both sides, a
// removed node's connections dropped), its own add's param changes count, and
// a node is measured once per content version, not once per snapshot step.

vi.mock('../src/lib/graphFileShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/graphFileShared')>();
  return { ...actual, measureShape: vi.fn(actual.measureShape) };
});

const { GRAPH_MAX_DEPTH, GRAPH_MAX_VALUES, serializeGraph } = shared;
const measureShape = vi.mocked(shared.measureShape);

const node = (id: string, params: Record<string, unknown> = {}, label = id) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label, definitionId: 'text-input', params, outputs: {}, state: 'idle' },
}) as Node<NodeData>;
const edge = (source: string, target: string, data?: Record<string, unknown>) => ({
  id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'text', type: 'typed-edge',
  ...(data ? { data } : {}),
}) as Edge;
/** Save's own walk of the whole file. */
const fileShape = (nodes: Node<NodeData>[], edges: Edge[]) =>
  measureShape({ ...serializeGraph(nodes, edges), version: 3 });
const fileCount = (nodes: Node<NodeData>[], edges: Edge[]) => fileShape(nodes, edges).count;
const fitsSave = (nodes: Node<NodeData>[], edges: Edge[]) => {
  const shape = fileShape(nodes, edges);
  return !shape.bad && shape.count <= GRAPH_MAX_VALUES && shape.depth <= GRAPH_MAX_DEPTH;
};
/** A canvas of one node holding `room` zeros, sized so the file is exactly at the limit with `rest` beside it. */
const atLimit = (rest: Node<NodeData>[], edges: Edge[] = []) => {
  const empty = [node('big', { value: [] as number[] }), ...rest];
  const room = GRAPH_MAX_VALUES - fileCount(empty, edges);
  return [node('big', { value: new Array(room).fill(0) }), ...rest];
};

describe('the walk applies a slice step as Undo does (LOW-2)', () => {
  it('a paste of two connected nodes whose Undo fits: their connection goes with them (F1)', () => {
    const base = atLimit([]);
    expect(fileCount(base, [])).toBe(GRAPH_MAX_VALUES);
    const nodes = [...base, node('p1'), node('p2')];
    const edges = [edge('p1', 'p2')];
    const step = ownAddStep(['p1', 'p2']);
    const real = applySlice(nodes, edges, step.before, step.after);
    expect(real.edges).toEqual([]);
    expect(fitsSave(real.nodes, real.edges)).toBe(true);
    expect(undosToFitSave(nodes, edges, undefined, undefined, [{ before: step.before }])).toBe(1);
  });

  it('an agent step that changed a connection: one key on both sides, so it counts once', () => {
    const rest = [node('a'), node('b')];
    const small = edge('a', 'b');
    const base = atLimit(rest, [small]);
    expect(fileCount(base, [small])).toBe(GRAPH_MAX_VALUES);
    // The agent put 3 values on the connection: over by 4 (the data key, the list and its 3).
    const now = { ...small, data: { note: [1, 2, 3] } } as Edge;
    expect(fitsSave(base, [now])).toBe(false);
    const before: GraphSlice = { nodes: {}, edges: { [edgeKey(small)]: small } };
    // Undo keeps the canvas's connection where the slice has one with the same key.
    const real = applySlice(base, [now], before, { nodes: {}, edges: { [edgeKey(now)]: now } });
    expect(real.edges).toHaveLength(1);
    expect(undosToFitSave(base, [now], undefined, undefined, [{ before }])).toBe(
      fitsSave(real.nodes, real.edges) ? 1 : null);
  });

  it('a step that added a connection: its Undo (the slice\'s null) takes it off (f04)', () => {
    const rest = [node('a'), node('b')];
    const base = atLimit(rest);
    const added = edge('a', 'b', { note: 'x' });
    expect(fitsSave(base, [added])).toBe(false);
    const before: GraphSlice = { nodes: {}, edges: { [edgeKey(added)]: null } };
    expect(undosToFitSave(base, [added], undefined, undefined, [{ before }])).toBe(1);
  });

  it('a step that removed a connection: it comes back only between two nodes on the canvas', () => {
    const base = atLimit([node('a')]);
    const gone = edge('a', 'zz', { note: 'x' });
    // b isn't on the canvas: Undo can't bring the connection back, so it costs nothing.
    const before: GraphSlice = { nodes: {}, edges: { [edgeKey(gone)]: gone } };
    const over = [...base, node('extra')];
    expect(undosToFitSave(over, [], undefined, undefined, [{ before }, { before: { nodes: { extra: null }, edges: {} } }])).toBe(2);
  });
});

describe('an own add\'s param changes count (NIT-2, f03)', () => {
  it('an accepted proposal that set a param on a node it didn\'t add: its Undo puts the old value back', () => {
    const base = atLimit([node('a', { value: 'x' })]);
    const nodes = base.map((item) => (item.id === 'a' ? node('a', { value: [1, 2, 3, 4] }) : item));
    expect(fitsSave(nodes, [])).toBe(false);
    const params: OwnParamChange[] = [{ nodeId: 'a', before: { value: 'x' }, absent: [] }];
    expect(undosToFitSave(nodes, [], undefined, undefined, [{ before: { nodes: {}, edges: {} }, params }])).toBe(1);
  });

  it('a key the step added (absent before): its Undo takes it off', () => {
    const base = atLimit([node('a', {})]);
    const nodes = base.map((item) => (item.id === 'a' ? node('a', { extra: [1, 2, 3] }) : item));
    expect(fitsSave(nodes, [])).toBe(false);
    const params: OwnParamChange[] = [{ nodeId: 'a', before: {}, absent: ['extra'] }];
    expect(undosToFitSave(nodes, [], undefined, undefined, [{ before: { nodes: {}, edges: {} }, params }])).toBe(1);
  });
});

describe('the walk agrees with Save\'s whole walk after each Undo', () => {
  // A seeded mix of snapshot steps, slices that add, remove and change nodes
  // and connections, and own adds, near the count limit.
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', (seed) => {
    const rand = random(seed);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pickNode = (id: string) => node(id, { value: new Array(Math.floor(rand() * 4)).fill(0) });
    const pickEdges = (present: string[]) => {
      const out: Edge[] = [];
      for (const s of present) for (const t of present) if (s < t && rand() < 0.4) out.push(edge(s, t, rand() < 0.5 ? { n: [1] } : undefined));
      return out;
    };
    let nodes = atLimit(ids.slice(0, 3).map(pickNode));
    // Make the base sit a few values under the limit, so steps cross it.
    nodes = nodes.map((item) => (item.id === 'big' ? node('big', { value: (item.data.params.value as number[]).slice(6) }) : item));
    let edges = pickEdges(['a', 'b', 'c']);
    const steps: UndoWalkStep[] = [];
    // Build forward: each step records how to go back.
    for (let index = 0; index < 8; index += 1) {
      const kind = rand();
      if (kind < 0.3) {
        steps.unshift({ nodes: nodes.map((item) => ({ ...item, data: { ...item.data, params: { ...item.data.params } } })), edges: edges.map((item) => ({ ...item })) });
        const id = ids[Math.floor(rand() * ids.length)];
        nodes = [...nodes.filter((item) => item.id !== id), pickNode(id)];
        edges = edges.filter((item) => nodes.some((n) => n.id === item.source) && nodes.some((n) => n.id === item.target));
      } else if (kind < 0.6) {
        const fresh = ids.filter((id) => !nodes.some((item) => item.id === id));
        if (fresh.length === 0) continue;
        const add = fresh.slice(0, 1 + Math.floor(rand() * fresh.length));
        steps.unshift({ before: ownAddStep(add).before });
        nodes = [...nodes, ...add.map(pickNode)];
        edges = [...edges, ...pickEdges(nodes.map((item) => item.id)).filter((item) => add.includes(item.source) || add.includes(item.target))];
      } else {
        const id = nodes.filter((item) => item.id !== 'big')[Math.floor(rand() * (nodes.length - 1))]?.id;
        if (!id) continue;
        const was = nodes.find((item) => item.id === id) as Node<NodeData>;
        const wires = edges.filter((item) => item.source === id || item.target === id);
        const before: GraphSlice = { nodes: { [id]: was }, edges: Object.fromEntries(wires.map((item) => [edgeKey(item), item])) };
        steps.unshift({ before });
        if (rand() < 0.5) {
          nodes = nodes.filter((item) => item.id !== id);
          edges = edges.filter((item) => !wires.includes(item));
        } else {
          nodes = nodes.map((item) => (item.id === id ? pickNode(id) : item));
        }
      }
    }
    // Brute force: Save's whole walk of the canvas as each Undo leaves it.
    let expected: number | null = null;
    let canvas = { nodes, edges };
    for (let undos = 0; undos <= steps.length; undos += 1) {
      if (fitsSave(canvas.nodes, canvas.edges)) { expected = undos; break; }
      const step = steps[undos];
      if (!step) break;
      canvas = 'before' in step ? applySlice(canvas.nodes, canvas.edges, step.before, { nodes: {}, edges: {} })
        : { nodes: step.nodes, edges: step.edges };
    }
    expect(undosToFitSave(nodes, edges, undefined, undefined, steps)).toBe(expected);
  });
});

describe('the walk measures a node once per content version (LOW-3)', () => {
  it('a 10,000-node canvas with 50 snapshot steps: each node is measured once, within budget', () => {
    // About 1,080,000 values: past Save's limit, and no step fixes it.
    const nodes = Array.from({ length: 10_000 }, (_, index) => node(`n${index}`, { value: new Array(95).fill(index) }));
    const edges = Array.from({ length: 2_000 }, (_, index) => edge(`n${index}`, `n${index + 1}`));
    expect(fitsSave(nodes, edges)).toBe(false);
    // As createSnapshot copies them: new node, data and params objects, the same values.
    const copy = () => ({
      nodes: nodes.map((item) => ({ ...item, position: { ...item.position }, data: { ...item.data, params: { ...item.data.params } } })),
      edges: edges.map((item) => ({ ...item })),
    });
    const steps: UndoWalkStep[] = Array.from({ length: 50 }, copy);
    measureShape.mockClear();
    const started = performance.now();
    expect(undosToFitSave(nodes, edges, undefined, undefined, steps)).toBeNull();
    const took = performance.now() - started;
    // The root, each node and each connection once: never once per step.
    expect(measureShape.mock.calls.length).toBe(1 + nodes.length + edges.length);
    // Timed at load average ~30: round 8's walk took 3,008 ms on this canvas,
    // this one 237 ms, one Save walk of it 52 ms. A loose wall-clock bound
    // for a loaded machine; the call count above is the exact budget.
    expect(took).toBeLessThan(1_500);
  }, 60_000);

  it('a step that changed one node measures only that node again', () => {
    const nodes = Array.from({ length: 200 }, (_, index) => node(`n${index}`, { value: new Array(5_100).fill(0) }));
    expect(fitsSave(nodes, [])).toBe(false);
    const changed = nodes.map((item) => (item.id === 'n7' ? node('n7', { value: 'short' }) : { ...item, data: { ...item.data, params: { ...item.data.params } } }));
    measureShape.mockClear();
    expect(undosToFitSave(nodes, [], undefined, undefined, [{ nodes: changed, edges: [] }])).toBeNull();
    expect(measureShape.mock.calls.length).toBe(1 + nodes.length + 1);
  });

  it('a copy with a param key the canvas\'s node lacks is a new version, not the same content', () => {
    // The canvas is over by b's list. Undoing the snapshot shrinks b but gives
    // a a key it didn't have: still over, so a second Undo is needed.
    const base = atLimit([node('a', {}), node('b', { value: 'x' })]);
    const nodes = base.map((item) => (item.id === 'b' ? node('b', { value: [1, 2, 3, 4, 5] }) : item));
    const older = base.map((item) => (item.id === 'a' ? node('a', { extra: [1, 2, 3, 4, 5, 6, 7, 8] }) : { ...item }));
    expect(fitsSave(older, [])).toBe(false);
    expect(undosToFitSave(nodes, [], undefined, undefined, [{ nodes: older, edges: [] }, { nodes: base, edges: [] }])).toBe(2);
  });

  it('two connections between the same ports count as Save counts them, twice', () => {
    const rest = [node('a'), node('b')];
    const one = edge('a', 'b');
    const base = atLimit(rest, [one]);
    expect(fileCount(base, [one])).toBe(GRAPH_MAX_VALUES);
    const twin = { ...one, id: 'e-a-b-2' } as Edge;
    expect(fitsSave(base, [one, twin])).toBe(false);
    expect(undosToFitSave(base, [one, twin], undefined, undefined, [])).toBeNull();
    expect(undosToFitSave(base, [one], undefined, undefined, [])).toBe(0);
  });
});
