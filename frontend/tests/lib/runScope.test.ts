import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  cinemaSceneBase, describeRunScope, runChipLabel, runChipTitle, runCostConfirmMessage, runMultipliers, shouldConfirmRunCost,
  summarizeRunScope,
} from '../../src/lib/runScope';
import type { PricingTable } from '../../src/lib/pricing';
import shippedTable from '../../../backend/data/model_pricing.json';
import type { ModelNodeDefinition, NodeData } from '../../src/types';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { routeUnavailable, withWiredBlockers } from '../../src/lib/directRoute';

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
    expect(runChipLabel(summary)).toBe('$0.01–0.20 + unpriced');
    expect(describeRunScope(summary)).toContain('Not included: input images');
  });

  it('marks the total open-ended when a paid node has no list price', () => {
    const summary = summarizeRunScope(
      [priced('a', 'nano-banana'), priced('c', 'claude-chat', {}, 'Writer')], [], { kind: 'graph' }, context,
    );
    expect(summary.cost?.unpriced).toEqual(['Writer']);
    expect(runChipLabel(summary)).toBe('$0.05 + unpriced');
    expect(describeRunScope(summary)).toContain('No list price for Writer');
  });

  it('decides "$0" by source: a run whose every priced row is 0 reads "$0", titled "This costs nothing to run."; one that only rounds to zero keeps "~" (GM, PR #203 r11 item 4)', () => {
    const free: PricingTable = { ...pricing, nodes: { ...pricing.nodes, 'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0 }] } } };
    const summary = summarizeRunScope([priced('a', 'nano-banana')], [], { kind: 'graph' }, { pricing: free, apiKeys: {} });
    expect(summary.cost?.sourcedZero).toBe(true);
    expect(runChipLabel(summary)).toBe('$0');
    expect(runChipTitle(summary)).toBe('This costs nothing to run.');
    // A closed 0 with no sourced zero (a figure that only rounds to it) is an estimate.
    const rounded = { ...summary, cost: { ...summary.cost!, sourcedZero: undefined } };
    expect(runChipLabel(rounded)).toBe('~$0');
    expect(runChipTitle(rounded)).toBe('Estimated cost');
    // A paid priced line beside it: not a sourced zero.
    const mixed = summarizeRunScope([priced('a', 'nano-banana'), priced('b', 'veo-3')], [], { kind: 'graph' },
      { pricing: free, apiKeys: { GOOGLE_API_KEY: 'set' } });
    expect(mixed.cost?.sourcedZero).toBeUndefined();
  });

  it('never counts Idol as paid: free without a token, "1 may cost" with one (GM, PR #203 r11 item 2, r12)', () => {
    const shipped = (keys: Record<string, string>) => ({ pricing: shippedTable as unknown as PricingTable, apiKeys: keys });
    const idol = priced('i', 'speridlabs-idol', {}, 'Idol');
    const keyless = summarizeRunScope([idol], [], { kind: 'graph' }, shipped({}));
    expect(keyless.paid).toEqual([]);
    expect(keyless.mayCost).toBeUndefined();
    expect(keyless.cost?.lines).toEqual([]);
    expect(runChipLabel(keyless)).toBeNull();
    expect(runChipTitle(keyless)).toBeUndefined();
    const signed = summarizeRunScope([idol], [], { kind: 'graph' }, shipped({ HF_TOKEN: 'hf_fixture' }));
    expect(signed.paid).toEqual([]);
    expect(signed.cost?.lines).toEqual([]);
    expect(signed.mayCost).toEqual([{ name: 'Idol', account: 'Hugging Face' }]);
    expect(runChipLabel(signed)).toBe('1 may cost');
    expect(runChipTitle(signed)).toBe('Idol can use your Hugging Face credits.');
    expect(describeRunScope(signed)).toBe('Runs 1 node · no paid providers. Idol can use your Hugging Face credits');
  });

  it('counts Idol apart beside paid models: "2 paid · 1 may cost", and a priced chip keeps its amount with Idol\'s sentence last', () => {
    const keys = { HF_TOKEN: 'hf_fixture' };
    const idol = priced('i', 'speridlabs-idol', {}, 'Idol');
    const unpricedPair = summarizeRunScope([idol, priced('c', 'claude-chat', {}, 'Writer'), priced('d', 'claude-chat', {}, 'Editor')],
      [], { kind: 'graph' }, { pricing, apiKeys: keys });
    expect(unpricedPair.paid).toEqual(['Writer', 'Editor']);
    expect(runChipLabel({ ...unpricedPair, cost: undefined })).toBe('2 paid · 1 may cost');
    expect(runChipTitle({ ...unpricedPair, cost: undefined })).toBe('Idol can use your Hugging Face credits.');
    const withPrice = summarizeRunScope([idol, priced('a', 'nano-banana')], [], { kind: 'graph' }, { pricing, apiKeys: keys });
    expect(runChipLabel(withPrice)).toBe('~$0.05');
    expect(runChipTitle(withPrice)).toBe('Estimated cost\nIdol can use your Hugging Face credits.');
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

  it('keeps a run on Krea when a Krea-only setting arrives by wire, as the router does', () => {
    // Grok Imagine 1.5's start video is Krea-only (directRoute.blockedBy).
    const routed: PricingTable = { ...pricing, nodes: { 'krea-video-xai-grok-video-1-5': { routes: {
      krea: { currency: 'usd', per: 'request', rows: [{ match: {}, price: 1 }] },
      xai: { currency: 'usd', per: 'request', rows: [{ match: {}, price: 2 }] },
    } } } as PricingTable['nodes'] };
    const keys = { XAI_API_KEY: 'set', KREA_API_TOKEN: 'set' };
    const graph = [priced('src', 'text-input'), priced('v', 'krea-video-xai-grok-video-1-5', { _kreaAuth: 'api-token' })];
    const unwired = summarizeRunScope(graph, [], { kind: 'graph' }, { pricing: routed, apiKeys: keys });
    expect(unwired.cost?.high).toBe(2);
    const wire: Edge[] = [{ id: 'w', source: 'src', target: 'v', targetHandle: 'start_video' }];
    const wired = summarizeRunScope(graph, wire, { kind: 'graph' }, { pricing: routed, apiKeys: keys });
    expect(wired.cost?.high).toBe(1);
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
    expect(message).toContain('• Retouch: $0.01–$0.20');
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

describe('local nodes that call a provider, and wired price settings', () => {
  it('counts a vision-llm QC node as paid with no list price, and local modes as free', () => {
    const qc = (mode: unknown) => priced('qc', 'qc-frame-review', { mode }, 'QC');
    const vision = summarizeRunScope([qc('vision-llm')], [], { kind: 'graph' }, context);
    expect(vision.paid).toEqual(['QC']);
    expect(vision.cost?.unpriced).toEqual(['QC']);
    expect(runChipLabel(vision)).toBe('1 paid');
    expect(describeRunScope(vision)).toContain('No list price for QC');
    for (const mode of ['heuristic', 'opencv']) {
      const local = summarizeRunScope([qc(mode)], [], { kind: 'graph' }, context);
      expect(local.paid).toEqual([]);
      expect(runChipLabel(local)).toBeNull();
    }
    // A value the handler would refuse isn't free either.
    expect(summarizeRunScope([qc('')], [], { kind: 'graph' }, context).paid).toEqual(['QC']);
  });

  it('prices a QC node in Jev mode per request from its own entry, and only that mode', () => {
    const shipped = { pricing: shippedTable as unknown as PricingTable, apiKeys: {} };
    const qc = (mode: string) => priced(`qc-${mode}`, 'qc-loop-safety', { mode }, `QC ${mode}`);
    const run = summarizeRunScope([qc('jev'), qc('vision-llm'), qc('heuristic')], [], { kind: 'graph' }, shipped);
    expect(run.paid).toEqual(['QC jev', 'QC vision-llm']);
    expect(run.cost?.lines).toEqual([{ name: 'QC jev', low: 0.0000128, high: 0.0027, runs: [1, 1], nodeId: 'qc-jev' }]);
    expect(run.cost?.unpriced).toEqual(['QC vision-llm']);
    expect(run.cost?.plus).toEqual(['input images']);
    // Without the table entry, Jev mode is paid but unpriced like vision-llm.
    expect(summarizeRunScope([qc('jev')], [], { kind: 'graph' }, context).cost?.unpriced).toEqual(['QC jev']);
  });

  it('leaves a node unpriced when a setting its price reads arrives by wire', () => {
    const table: PricingTable = { currencies: {}, nodes: { 'krea-video-kling-kling-3-0': {
      currency: 'usd', per: 'request', rows: [{ match: { _kreaAuth: 'api-token', multi_prompt: '' }, price: 0.42 }],
    } } };
    const kling = priced('k', 'krea-video-kling-kling-3-0', { _kreaAuth: 'api-token' }, 'Kling');
    const shots = priced('t', 'text-input', { value: '[]' });
    const plain = summarizeRunScope([kling], [], { kind: 'graph' }, { pricing: table, apiKeys: {} });
    expect(plain.cost?.high).toBeCloseTo(0.42);
    const wired: Edge[] = [{ id: 'w', source: 't', target: 'k', targetHandle: 'multi_prompt' }];
    const summary = summarizeRunScope([shots, kling], wired, { kind: 'graph' }, { pricing: table, apiKeys: {} });
    expect(summary.cost?.unpriced).toEqual(['Kling']);
    expect(summary.cost?.lines).toEqual([]);
    // A wire into a port the price doesn't read changes nothing.
    const other: Edge[] = [{ id: 'w', source: 't', target: 'k', targetHandle: 'prompt' }];
    expect(summarizeRunScope([shots, kling], other, { kind: 'graph' }, { pricing: table, apiKeys: {} }).cost?.high)
      .toBeCloseTo(0.42);
    // A cluster run sends only the edges inside it (graphStore runCluster), so a
    // wire from outside never arrives and the param is what gets priced, just as
    // the backend sees it. Inside the cluster, the wire still counts.
    const outside = summarizeRunScope([shots, kling], wired, { kind: 'cluster', nodeIds: ['k'] }, { pricing: table, apiKeys: {} });
    expect(outside.cost?.unpriced).toEqual([]);
    expect(outside.cost?.high).toBeCloseTo(0.42);
    const inside = summarizeRunScope([shots, kling], wired, { kind: 'cluster', nodeIds: ['t', 'k'] }, { pricing: table, apiKeys: {} });
    expect(inside.cost?.unpriced).toEqual(['Kling']);
  });
});

describe('run estimate for a route-table node (cases shared with the backend)', () => {
  type RunCase = {
    name: string; nodeId: string; params: Record<string, unknown>; apiKeys: Record<string, string>;
    wiredCounts?: Record<string, number>;
    expected: { low: number | null; high: number | null; unavailable: boolean; plan: boolean };
  };
  const fixture = pricingCases as unknown as {
    definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable; runCases: RunCase[];
  };
  // summarizeRunScope reads the registry, so the fixture node joins it for these cases.
  beforeAll(() => { NODE_DEFINITIONS.table = fixture.definitions.table; });
  afterAll(() => { delete NODE_DEFINITIONS.table; });

  for (const testCase of fixture.runCases) {
    it(testCase.name, () => {
      const target: Node<NodeData> = {
        id: 'n1', position: { x: 0, y: 0 },
        data: { definitionId: testCase.nodeId, label: 'Node', params: testCase.params } as unknown as NodeData,
      };
      const sources: Node<NodeData>[] = [];
      const wires: Edge[] = [];
      for (const [port, count] of Object.entries(testCase.wiredCounts ?? {})) {
        for (let index = 0; index < count; index += 1) {
          sources.push(node(`${port}-${index}`, 'text-input'));
          wires.push({ id: `${port}-${index}`, source: `${port}-${index}`, target: 'n1', targetHandle: port });
        }
      }
      const { cost } = summarizeRunScope([...sources, target], wires, { kind: 'graph' },
        { pricing: fixture.pricing, apiKeys: testCase.apiKeys });
      const line = cost!.lines.find((candidate) => candidate.name === 'Node');
      if (testCase.expected.low === null) expect(line).toBeUndefined();
      else expect([line!.low, line!.high]).toEqual([testCase.expected.low, testCase.expected.high]);
      expect(Boolean(cost!.unavailable?.Node)).toBe(testCase.expected.unavailable);
      expect(cost!.plan.includes('Node')).toBe(testCase.expected.plan);
      if (testCase.expected.unavailable) {
        const definition = fixture.definitions.table;
        const routed = withWiredBlockers(definition, testCase.params, new Map(Object.entries(testCase.wiredCounts ?? {})));
        expect(cost!.unavailable!.Node).toBe(routeUnavailable(definition, routed, testCase.apiKeys)!.message);
        expect(cost!.unpriced).toContain('Node');
        expect(describeRunScope({ total: 1, paid: ['Node'], cost })).toContain("Can't run on the chosen provider: Node");
        expect(describeRunScope({ total: 1, paid: ['Node'], cost })).not.toContain('No list price');
      }
    });
  }
});

describe('run estimate for a shipped route-table node (cases shared with the backend)', () => {
  // pricing_cases.json shippedRunCases; test_flux3_nodes.py runs them too.
  type ShippedRunCase = {
    name: string; nodeId: string; params: Record<string, unknown>; apiKeys: Record<string, string>; wired: string[];
    expected: { low: number | null; high: number | null; unavailable: boolean; plan: boolean };
  };
  const cases = (pricingCases as unknown as { shippedRunCases: ShippedRunCase[] }).shippedRunCases;
  for (const testCase of cases) {
    it(testCase.name, () => {
      const target: Node<NodeData> = {
        id: 'n1', position: { x: 0, y: 0 },
        data: { definitionId: testCase.nodeId, label: 'Node', params: testCase.params } as unknown as NodeData,
      };
      const sources = testCase.wired.map((port) => node(`${port}-0`, 'image-input'));
      const wires: Edge[] = testCase.wired.map((port) => ({ id: port, source: `${port}-0`, target: 'n1', targetHandle: port }));
      const { cost } = summarizeRunScope([...sources, target], wires, { kind: 'graph' },
        { pricing: shippedTable as unknown as PricingTable, apiKeys: testCase.apiKeys });
      const line = cost!.lines.find((candidate) => candidate.name === 'Node');
      if (testCase.expected.low === null) expect(line).toBeUndefined();
      else {
        expect(line!.low).toBeCloseTo(testCase.expected.low, 6);
        expect(line!.high).toBeCloseTo(testCase.expected.high!, 6);
      }
      expect(Boolean(cost!.unavailable?.Node)).toBe(testCase.expected.unavailable);
      expect(cost!.plan.includes('Node')).toBe(testCase.expected.plan);
    });
  }
});

describe('a run priced from its input file (cases shared with the backend)', () => {
  // pricing_cases.json sizedRunCases; test_price_from_input_size.py runs them too.
  type SizedRunCase = {
    name: string; nodeId: string; params: Record<string, unknown>; apiKeys: Record<string, string>; port: string;
    size?: Record<string, number>;
    expected: { low: number | null; high: number | null; awaitingInput: boolean };
  };
  const cases = (pricingCases as unknown as { sizedRunCases: SizedRunCase[] }).sizedRunCases;
  for (const testCase of cases) {
    it(testCase.name, () => {
      const video = NODE_DEFINITIONS[testCase.nodeId].inputPorts.find((port) => port.id === testCase.port)?.dataType === 'Video';
      const ref = video ? '/out/clip.mp4' : '/out/in.png';
      const source: Node<NodeData> = {
        id: 'in', position: { x: 0, y: 0 },
        data: { definitionId: video ? 'video-input' : 'image-input', label: 'In', params: { filePath: ref } } as unknown as NodeData,
      };
      const target: Node<NodeData> = {
        id: 'n1', position: { x: 0, y: 0 },
        data: { definitionId: testCase.nodeId, label: 'Node', params: testCase.params } as unknown as NodeData,
      };
      const wires: Edge[] = [{ id: 'w', source: 'in', sourceHandle: video ? 'video' : 'image', target: 'n1', targetHandle: testCase.port }];
      const { cost } = summarizeRunScope([source, target], wires, { kind: 'graph' }, {
        pricing: shippedTable as unknown as PricingTable, apiKeys: testCase.apiKeys,
        sizes: testCase.size ? { [ref]: testCase.size } : {},
      });
      const line = cost!.lines.find((candidate) => candidate.name === 'Node');
      if (testCase.expected.low === null) expect(line).toBeUndefined();
      else {
        expect(line!.low).toBeCloseTo(testCase.expected.low, 9);
        expect(line!.high).toBeCloseTo(testCase.expected.high!, 9);
      }
      expect(cost!.awaitingInput.includes('Node')).toBe(testCase.expected.awaitingInput);
    });
  }

  const upload = (params: Record<string, unknown>): Node<NodeData> => ({
    id: 'in', position: { x: 0, y: 0 }, data: { definitionId: 'image-input', label: 'Photo', params } as unknown as NodeData,
  });
  const seedvr: Node<NodeData> = {
    id: 'up', position: { x: 0, y: 0 }, data: { definitionId: 'seedvr2-upscale', label: 'Upscale', params: {} } as unknown as NodeData,
  };
  const wire: Edge[] = [{ id: 'w', source: 'in', sourceHandle: 'image', target: 'up', targetHandle: 'image' }];
  const context = { pricing: shippedTable as unknown as PricingTable, apiKeys: { FAL_KEY: 'set' } };

  it('asks for the size of an upload it has not measured, and says it is priced when known', () => {
    const summary = summarizeRunScope([upload({ filePath: '/out/a.png' }), seedvr], wire, { kind: 'node', nodeId: 'up' }, context);
    expect(summary.cost!.sizeRefs).toEqual([{ ref: '/out/a.png', kind: 'Image' }]);
    expect(summary.cost!.awaitingInput).toEqual(['Upscale']);
    expect(runChipLabel(summary)).toBe('1 paid');
    const text = describeRunScope(summary);
    expect(text).toContain('Priced when its input is known: Upscale');
    expect(text).not.toContain('No list price');
    expect(runCostConfirmMessage(summary)).toContain('Priced when its input is known: Upscale');
  });

  it('prices it once the size is in', () => {
    const summary = summarizeRunScope([upload({ filePath: '/out/a.png' }), seedvr], wire, { kind: 'node', nodeId: 'up' },
      { ...context, sizes: { '/out/a.png': { width: 1000, height: 1000 } } });
    expect(summary.cost!.sizeRefs).toEqual([]);
    expect(summary.cost!.lines).toEqual([{ name: 'Upscale', low: 0.004, high: 0.004, runs: [1, 1], nodeId: 'up' }]);
    // GM, PR #198 r1: a chip never shows a sub-cent figure; the detail lines do.
    expect(runChipLabel(summary)).toBe('<$0.01');
  });

  it('never measures an input made in the same run', () => {
    const generator: Node<NodeData> = {
      id: 'gen', position: { x: 0, y: 0 },
      data: { definitionId: 'gpt-image-2-generate', label: 'Gen', params: {}, outputs: { image: { type: 'Image', value: '/out/b.png' } } } as unknown as NodeData,
    };
    const edges: Edge[] = [{ id: 'w', source: 'gen', sourceHandle: 'image', target: 'up', targetHandle: 'image' }];
    const summary = summarizeRunScope([generator, seedvr], edges, { kind: 'node', nodeId: 'up' },
      { ...context, sizes: { '/out/b.png': { width: 1000, height: 1000 } } });
    expect(summary.cost!.sizeRefs).toEqual([]);
    expect(summary.cost!.awaitingInput).toEqual(['Upscale']);
  });

  it('says when the backend can\'t read the input file, rather than that it isn\'t known yet', () => {
    // The measure route answers null for a file on another host (never
    // downloaded to price it) or one it can't read.
    const summary = summarizeRunScope([upload({ filePath: 'https://images.example.com/x.png' }), seedvr], wire,
      { kind: 'node', nodeId: 'up' }, { ...context, sizes: { 'https://images.example.com/x.png': null } });
    expect(summary.cost!.sizeRefs).toEqual([]);
    expect(summary.cost!.awaitingInput).toEqual(['Upscale']);
    expect(summary.cost!.sizeUnreadable).toEqual(['Upscale']);
    const text = describeRunScope(summary);
    expect(text).not.toContain('Priced when its input is known');
    expect(text).toContain("Nebula can't read the size of its input");
    expect(text).toContain('Upscale');
    expect(runCostConfirmMessage(summary)).toContain("Nebula can't read the size of its input");
    expect(runCostConfirmMessage(summary)).not.toContain('Priced when its input is known');
  });

  it('keeps both notes when an unreadable and a pending node share a name', () => {
    const generator: Node<NodeData> = {
      id: 'gen', position: { x: 0, y: 0 }, data: { definitionId: 'gpt-image-2-generate', label: 'Gen', params: {} } as unknown as NodeData,
    };
    const second: Node<NodeData> = { ...seedvr, id: 'up2' };
    const edges: Edge[] = [...wire, { id: 'w2', source: 'gen', sourceHandle: 'image', target: 'up2', targetHandle: 'image' }];
    const summary = summarizeRunScope([upload({ filePath: 'https://images.example.com/x.png' }), seedvr, generator, second], edges,
      { kind: 'graph' }, { ...context, sizes: { 'https://images.example.com/x.png': null } });
    const text = describeRunScope(summary);
    expect(text).toContain('Priced when its input is known: Upscale');
    expect(text).toContain("Nebula can't read the size of its input (a file on another host is never downloaded to price it): Upscale");
  });

  it('never measures an upload with no file yet', () => {
    const summary = summarizeRunScope([upload({}), seedvr], wire, { kind: 'graph' }, context);
    expect(summary.cost!.sizeRefs).toEqual([]);
    expect(summary.cost!.awaitingInput).toEqual(['Upscale']);
  });
});
