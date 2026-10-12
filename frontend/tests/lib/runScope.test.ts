import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  cinemaSceneBase, describeRunScope, runChipLabel, runCostConfirmMessage, runMultipliers, shouldConfirmRunCost,
  summarizeRunScope,
} from '../../src/lib/runScope';
import type { PricingTable } from '../../src/lib/pricing';
import type { NodeData } from '../../src/types';

const node = (id: string, definitionId: string, label = ''): Node<NodeData> => ({
  id, position: { x: 0, y: 0 }, data: { definitionId, label, params: {} } as unknown as NodeData,
});

// prompt -> image -> claude, plus an unconnected second image.
const nodes = [
  node('prompt', 'text-input'),
  node('image', 'gpt-image-1-generate', 'Hero shot'),
  node('chat', 'claude-chat'),
  node('stray', 'gpt-image-1-generate'),
];
const edges: Edge[] = [
  { id: 'e1', source: 'prompt', target: 'image' },
  { id: 'e2', source: 'image', target: 'chat' },
];

describe('run scope', () => {
  it('counts the whole graph and names paid nodes by label, then definition name', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'graph' });
    expect(summary.total).toBe(4);
    expect(summary.paid).toHaveLength(3);
    expect(summary.paid[0]).toBe('Hero shot');
  });

  it('runs one node with everything feeding it, and nothing downstream', () => {
    const summary = summarizeRunScope(nodes, edges, { kind: 'node', nodeId: 'image' });
    expect(summary).toEqual({ total: 2, paid: ['Hero shot'] });
  });

  it('runs a cluster exactly as selected', () => {
    expect(summarizeRunScope(nodes, edges, { kind: 'cluster', nodeIds: ['prompt'] })).toEqual({ total: 1, paid: [] });
  });

  it('describes free and paid scopes in plain language', () => {
    expect(describeRunScope({ total: 1, paid: [] })).toBe('Runs 1 node · no paid providers');
    expect(describeRunScope({ total: 2, paid: ['Hero shot'] })).toBe('Runs 2 nodes · 1 calls a paid provider: Hero shot');
    expect(describeRunScope({ total: 5, paid: ['a', 'b', 'c', 'd'] })).toBe('Runs 5 nodes · 4 call paid providers: a, b, c and 1 more');
  });
});

const priced = (id: string, definitionId: string, params: Record<string, unknown> = {}, label = ''): Node<NodeData> => ({
  id, position: { x: 0, y: 0 }, data: { definitionId, label, params } as unknown as NodeData,
});

// A small table keyed by real node ids, so definitions and routes are real
// but the numbers here don't move when vendors change theirs.
const pricing: PricingTable = {
  currencies: {},
  nodes: {
    'nano-banana': {
      currency: 'usd', per: 'image',
      rows: [{ match: { imageSize: '1K' }, price: 0.05 }, { match: { imageSize: '2K' }, price: 0.1 }],
    },
    'gpt-image-2-edit': {
      currency: 'usd', per: 'image', plus: 'input images',
      rows: [{ match: {}, price: [0.01, 0.2] }],
    },
    'veo-3': {
      currency: 'usd', per: 'second', provider: 'google', multiplyBy: ['duration'], defaults: { duration: 8 },
      rows: [{ match: {}, price: 0.1 }],
    },
    'krea-2-generate': {
      currency: 'usd', per: 'request',
      rows: [{ match: { _kreaAuth: 'api-token' }, price: 0.03 }],
    },
  },
};
const context = { pricing, apiKeys: {} };

describe('run cost', () => {
  it('sums list prices for the run scope and labels the chip', () => {
    const graph = [priced('a', 'nano-banana'), priced('b', 'nano-banana', { imageSize: '2K' }), priced('p', 'text-input')];
    const summary = summarizeRunScope(graph, [], { kind: 'graph' }, context);
    expect(summary.cost?.low).toBeCloseTo(0.15);
    expect(summary.cost?.high).toBeCloseTo(0.15);
    expect(runChipLabel(summary)).toBe('~$0.15');
    expect(describeRunScope(summary)).toContain('Estimated $0.15 at list prices');
  });

  it('shows a range when a setting only resolves at run time, and marks costs left out', () => {
    const summary = summarizeRunScope([priced('e', 'gpt-image-2-edit')], [], { kind: 'graph' }, context);
    expect(summary.cost?.plus).toEqual(['input images']);
    expect(runChipLabel(summary)).toBe('$0.01–0.20+');
    expect(describeRunScope(summary)).toContain('Not included: input images');
  });

  it('marks the total open-ended when a paid node has no list price', () => {
    const summary = summarizeRunScope(
      [priced('a', 'nano-banana'), priced('c', 'claude-chat', {}, 'Writer')], [], { kind: 'graph' }, context,
    );
    expect(summary.cost?.unpriced).toEqual(['Writer']);
    expect(runChipLabel(summary)).toBe('$0.05+');
    expect(describeRunScope(summary)).toContain('No list price for Writer');
  });

  it('falls back to counting paid nodes when nothing is priced or the table is missing', () => {
    const graph = [priced('c', 'claude-chat')];
    expect(runChipLabel(summarizeRunScope(graph, [], { kind: 'graph' }, context))).toBe('1 paid');
    expect(runChipLabel(summarizeRunScope(graph, [], { kind: 'graph' }))).toBe('1 paid');
    expect(runChipLabel(summarizeRunScope([priced('p', 'text-input')], [], { kind: 'graph' }, context))).toBeNull();
  });

  it('prices a dual-route node only on the route it will bill', () => {
    const veo = [priced('v', 'veo-3')];
    const direct = summarizeRunScope(veo, [], { kind: 'graph' }, { pricing, apiKeys: { GOOGLE_API_KEY: 'set' } });
    expect(direct.cost?.high).toBeCloseTo(0.8);
    const viaFal = summarizeRunScope(veo, [], { kind: 'graph' }, { pricing, apiKeys: { FAL_KEY: 'set' } });
    expect(viaFal.cost?.unpriced).toHaveLength(1);
  });

  it('lists Krea account runs as billed to the plan, not as unpriced', () => {
    const summary = summarizeRunScope(
      [priced('k', 'krea-2-generate', { _kreaAuth: 'mcp' }, 'Krea shot')], [], { kind: 'graph' }, context,
    );
    expect(summary.cost?.plan).toEqual(['Krea shot']);
    expect(summary.cost?.unpriced).toEqual([]);
    expect(describeRunScope(summary)).toContain('Billed to your Krea plan: Krea shot');
    const api = summarizeRunScope([priced('k', 'krea-2-generate', { _kreaAuth: 'api-token' })], [], { kind: 'graph' }, context);
    expect(runChipLabel(api)).toBe('~$0.03');
  });

  it('repeats everything below a Batch once per item and below an Iterator up to its cap', () => {
    const batch = priced('batch', 'batch', { items_text: 'one\ntwo\nthree', batch_size_cap: 10 });
    const iterator = priced('iter', 'iterator-image', { batch_size_cap: 4 });
    const graph = [batch, priced('img', 'nano-banana'), iterator, priced('img2', 'nano-banana')];
    const fanEdges: Edge[] = [
      { id: 'b1', source: 'batch', target: 'img' },
      { id: 'i1', source: 'img', target: 'iter' },
      { id: 'i2', source: 'iter', target: 'img2' },
    ];
    const runs = runMultipliers(graph, fanEdges);
    expect(runs.get('img')).toEqual([3, 3]);
    expect(runs.get('img2')).toEqual([1, 4]);
    const summary = summarizeRunScope(graph, fanEdges, { kind: 'graph' }, context);
    expect(summary.cost?.low).toBeCloseTo(0.15 + 0.05);
    expect(summary.cost?.high).toBeCloseTo(0.15 + 0.2);
    expect(describeRunScope(summary)).toContain('× 3 runs');
    expect(describeRunScope(summary)).toContain('× up to 4 runs');
    // A cluster run sends only its own nodes, so a Batch outside it doesn't repeat them.
    const cluster = summarizeRunScope(graph, fanEdges, { kind: 'cluster', nodeIds: ['img'] }, context);
    expect(cluster.cost?.high).toBeCloseTo(0.05);
  });

  it('asks before a run whose high estimate reaches the threshold', () => {
    const summary = summarizeRunScope([priced('e', 'gpt-image-2-edit', {}, 'Retouch')], [], { kind: 'graph' }, context);
    expect(shouldConfirmRunCost(summary, 0.2)).toBe(true);
    expect(shouldConfirmRunCost(summary, 0.5)).toBe(false);
    expect(shouldConfirmRunCost(summary, null)).toBe(false);
    expect(shouldConfirmRunCost(summarizeRunScope([priced('c', 'claude-chat')], [], { kind: 'graph' }), 0)).toBe(false);
    const message = runCostConfirmMessage(summary);
    expect(message).toContain('could cost up to $0.20 at list prices');
    expect(message).toContain('• Retouch: $0.01–0.20');
    expect(message).toContain('Not included: input images.');
  });
});

describe('cinema scene cost', () => {
  const scene = (base: string | undefined, shots: number, params: Record<string, unknown> = {}) => priced(
    'scene', 'cinema-scene',
    { scene: { aspectRatio: '16:9', base: base ? { model: base, params } : undefined,
      shots: Array.from({ length: shots }, (_, i) => ({ id: `s${i}`, prompt: 'a lighthouse' })) } },
    'Lighthouse',
  );

  it('prices a scene as its base model once per shot, like the backend', () => {
    const summary = summarizeRunScope([scene('nano-banana', 3, { imageSize: '2K' })], [], { kind: 'graph' }, context);
    expect(summary.paid).toEqual(['Lighthouse']);
    expect(summary.cost?.high).toBeCloseTo(0.3);
    expect(summary.cost?.lines[0].runs).toEqual([3, 3]);
    expect(runChipLabel(summary)).toBe('~$0.30');
  });

  it('leaves a scene unpriced when its base has no list price or would be refused', () => {
    for (const base of [undefined, 'seedream-4-5', 'world-labs-anything']) {
      const summary = summarizeRunScope([scene(base, 2)], [], { kind: 'graph' }, context);
      expect(summary.paid).toEqual(['Lighthouse']);
      expect(summary.cost?.unpriced).toEqual(['Lighthouse']);
    }
  });

  it('reads the base the way the cinema handler does', () => {
    expect(cinemaSceneBase({ scene: { shots: [{}, 'not a shot', {}] } })).toEqual(
      { model: 'seedream-4-5', params: {}, shots: 2 });
    expect(cinemaSceneBase({ scene: { base: { model: 'flux-dev' }, shots: [] } })?.model).toBe('seedream-4-5');
    expect(cinemaSceneBase({ scene: { base: { model: 'Nano-Banana' }, aspectRatio: '9:16', shots: [{}] } })).toEqual(
      { model: 'nano-banana', params: { aspect_ratio: '9:16' }, shots: 1 });
    expect(cinemaSceneBase({ scene: 'not a scene' })).toBeNull();
  });
});
