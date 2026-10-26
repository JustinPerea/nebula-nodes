import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// The canvas shows exactly the backend's wires between backend nodes, plus
// the person's own wires that are still on their way (found by the Q82 lane's
// live check, 2026-10-21: after an agent's undo the backend had no wires, but
// the open canvas still drew e1 until a reload).

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
type Answer = { status: number; detail?: string; body?: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  /** Paths whose answers wait until the test releases them. */
  held: new Set<string>(),
  waiting: [] as Array<{ path: string; release: (answer?: { status: number; detail?: string; body?: unknown }) => void }>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => {
    net.calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (answer: Answer = { status: 200 }) => new Response(
      JSON.stringify(answer.body ?? (answer.detail ? { detail: answer.detail } : {})), { status: answer.status });
    if (!net.held.has(path)) return Promise.resolve(respond());
    return new Promise<Response>((resolve, reject) => {
      // Status 0: the request got no answer (the network dropped it).
      net.waiting.push({ path, release: (answer) => (answer?.status === 0
        ? reject(new TypeError('Failed to fetch')) : resolve(respond(answer))) });
    });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore, watchGraphSyncs } from '../src/store/graphStore';
import { captureProjectSnapshot } from '../src/store/projectStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';

const CLAUDE = { actor: { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' } };

function textNode(id: string, x = 0): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'fog' }, state: 'idle', outputs: {} },
  };
}
function previewNode(id: string, x = 400): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 },
    data: { label: 'Preview', definitionId: 'preview', params: {}, state: 'idle', outputs: {} },
  };
}
function wire(source: string, target: string, id: string): Edge {
  return { id, source, sourceHandle: 'text', target, targetHandle: 'input', type: 'typed-edge' };
}
const connection = (source: string, target: string) => ({ source, sourceHandle: 'text', target, targetHandle: 'input' });

function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = {
    type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra,
  } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wires = () => useGraphStore.getState().edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`);
const links = () => useGraphStore.getState().edges.map((edge) => `${edge.source}->${edge.target}`);
async function release(path: string, answer?: Answer) {
  await flush();
  const index = net.waiting.findIndex((item) => item.path === path);
  expect(index, `a ${path} request is waiting`).toBeGreaterThanOrEqual(0);
  const [item] = net.waiting.splice(index, 1);
  item.release(answer);
  await flush();
  await flush();
}

const nodes = () => [textNode('n1'), previewNode('n2')];

beforeEach(() => {
  net.calls.length = 0;
  net.held.clear();
  net.waiting.length = 0;
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], undoNotice: null,
    isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
  // Every test starts from a canvas the backend drew: n1 and n2, no wires.
  sync(nodes(), [], { graphReplaced: true });
});

describe('a wire the backend removed leaves the canvas', () => {
  it("an agent's unwire drops the wire, and is one undo step the person can undo", async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    expect(wires()).toEqual(['e1:n1->n2']);

    sync(nodes(), [], { edit: CLAUDE });
    expect(wires()).toEqual([]);
    const stack = useGraphStore.getState().undoStack;
    expect(stack).toHaveLength(2);
    expect(stack[1]).toMatchObject({ kind: 'foreign', agentName: 'Claude' });

    useGraphStore.getState().undo();
    expect(links()).toEqual(['n1->n2']);
    await flush();
    const restore = net.calls.find((call) => call.path === '/api/graph/restore');
    expect(restore?.body).toMatchObject({ action: 'undo', wire: [{ source: 'n1', target: 'n2' }], unwire: [] });
  });

  it("a run's sync (no edit) without the wire drops it too: it is the backend's graph now", () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    sync(nodes(), []);
    expect(wires()).toEqual([]);
  });

  it("an agent's undo of an edit that added a wire drops it", () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: { ...CLAUDE, id: 'edit-1' } });
    sync(nodes(), [], { edit: { ...CLAUDE, id: 'edit-2', undoes: 'edit-1' } });
    expect(wires()).toEqual([]);
  });

  it("the person's undo of the agent's unwire keeps the wire while that restore is on its way", async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    sync(nodes(), [], { edit: CLAUDE });
    net.held.add('/api/graph/restore');
    useGraphStore.getState().undo();
    expect(links()).toEqual(['n1->n2']);
    // A run's output sync sent before the restore landed.
    sync(nodes(), []);
    expect(links()).toEqual(['n1->n2']);
    sync(nodes(), [wire('n1', 'n2', 'e2')]);
    await release('/api/graph/restore');
    expect(wires()).toEqual(['e2:n1->n2']);
    // Settled: the next removal shows.
    sync(nodes(), [], { edit: CLAUDE });
    expect(wires()).toEqual([]);
  });
});

describe("the person's own wire on its way", () => {
  it('survives an older sync and is replaced by the backend copy when it arrives', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    const optimistic = useGraphStore.getState().edges[0];
    expect(links()).toEqual(['n1->n2']);

    // An agent's unrelated edit, sent before the connect landed.
    sync([textNode('n1'), previewNode('n2'), textNode('n3', 800)], [], { edit: CLAUDE });
    expect(wires()).toEqual([`${optimistic.id}:n1->n2`]);

    // The connect's own sync, then its answer.
    sync([textNode('n1'), previewNode('n2'), textNode('n3', 800)], [wire('n1', 'n2', 'e1')], { edit: { tab: 'mine' } });
    expect(wires()).toEqual(['e1:n1->n2']);
    await release('/api/graph/connect');
    expect(wires()).toEqual(['e1:n1->n2']);

    // Settled: an agent's later unwire shows.
    sync([textNode('n1'), previewNode('n2'), textNode('n3', 800)], [], { edit: CLAUDE });
    expect(wires()).toEqual([]);
  });

  it("an agent's unwire after the connect's own sync, before its answer, still drops it (review)", async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: { tab: 'mine' } });
    expect(wires()).toEqual(['e1:n1->n2']);
    // The backend took the connect (its sync agreed): this later sync is newer.
    sync(nodes(), [], { edit: CLAUDE });
    expect(wires()).toEqual([]);
    await release('/api/graph/connect');
    expect(wires()).toEqual([]);
    sync(nodes(), []);
    expect(wires()).toEqual([]);
  });

  it('a connect answered before its sync arrives still waits for that sync', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect');
    // An older sync that was still on the socket.
    sync(nodes(), []);
    expect(links()).toEqual(['n1->n2']);
    sync(nodes(), [wire('n1', 'n2', 'e1')]);
    expect(wires()).toEqual(['e1:n1->n2']);
    sync(nodes(), [], { edit: CLAUDE });
    expect(wires()).toEqual([]);
  });

  it("a connect the backend refused leaves no ghost and says so", async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect', { status: 409, detail: 'A run is going.' });
    expect(wires()).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toBe("Couldn't make that connection. A run is going.");
    sync(nodes(), []);
    expect(wires()).toEqual([]);
  });

  it('a connect that got no answer leaves the next sync to decide', async () => {
    net.held.add('/api/graph/connect');
    useGraphStore.getState().onConnect(connection('n1', 'n2'));
    await release('/api/graph/connect', { status: 0 });
    // It didn't land: the backend's graph has no such wire.
    sync(nodes(), []);
    expect(wires()).toEqual([]);
  });
});

describe('a wire the person deleted', () => {
  it("doesn't come back from a sync sent before the delete landed", async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    net.held.add('/api/graph/edge');
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'e1' }]);
    expect(wires()).toEqual([]);

    // A run's sync from before the delete.
    sync(nodes(), [wire('n1', 'n2', 'e1')]);
    expect(wires()).toEqual([]);

    sync(nodes(), [], { edit: { tab: 'mine' } });
    await release('/api/graph/edge');
    expect(wires()).toEqual([]);

    // Settled: an agent wiring it again shows.
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    expect(wires()).toEqual(['e1:n1->n2']);
  });

  it("an agent's re-wire after the delete's own sync, before its answer, shows (review)", async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    net.held.add('/api/graph/edge');
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'e1' }]);
    sync(nodes(), [], { edit: { tab: 'mine' } });
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    expect(wires()).toEqual(['e1:n1->n2']);
    await release('/api/graph/edge');
    expect(wires()).toEqual(['e1:n1->n2']);
  });

  it('a delete the backend refused puts the wire back and says so', async () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    net.held.add('/api/graph/edge');
    useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'e1' }]);
    await release('/api/graph/edge', { status: 409, detail: 'A run is going.' });
    expect(wires()).toEqual(['e1:n1->n2']);
    expect(useGraphStore.getState().undoNotice?.text).toBe("Couldn't remove that connection. A run is going.");
    sync(nodes(), [wire('n1', 'n2', 'e1')]);
    expect(wires()).toEqual(['e1:n1->n2']);
  });
});

describe('a late answer does not bring back what a sync already took away (review)', () => {
  const pairNodes = () => [textNode('n1'), previewNode('n2'), previewNode('n3', 420)];
  const pairWire = () => ({ ...wire('n1', 'n3', 'e1'), data: { dataType: 'Text' } });
  const addPair = () => {
    net.held.add('/api/graph/node-and-connect');
    return useGraphStore.getState().addNodeAndConnect('preview', { x: 420, y: 100 },
      { source: 'n1', sourceHandle: 'text', target: '', targetHandle: 'input', newNodeIs: 'target' });
  };
  const pairAnswer = () => ({ status: 200, body: { id: 'n3', definitionId: 'preview', params: {},
    connected: true, edge: pairWire() } });

  it("node-and-connect: the wire an agent removed meanwhile stays removed", async () => {
    const added = addPair();
    sync(pairNodes(), [pairWire()]);
    sync(pairNodes(), [], { edit: CLAUDE });
    await release('/api/graph/node-and-connect', pairAnswer());
    expect(await added).toBe('n3');
    expect(wires()).toEqual([]);
  });

  it('node-and-connect: the node an agent deleted meanwhile stays deleted', async () => {
    const added = addPair();
    sync(pairNodes(), [pairWire()]);
    sync(nodes(), [], { edit: CLAUDE });
    await release('/api/graph/node-and-connect', pairAnswer());
    await added;
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(wires()).toEqual([]);
  });

  it('node-and-connect answered before any sync still shows the pair at once, as before', async () => {
    const added = addPair();
    await release('/api/graph/node-and-connect', pairAnswer());
    await added;
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1', 'n2', 'n3']);
    expect(wires()).toEqual(['e1:n1->n3']);
  });

  it("Create's cluster: a wire an agent removed meanwhile stays removed", async () => {
    net.held.add('/api/graph/cluster');
    const cluster = [textNode('n3'), { ...previewNode('n4'), data: { ...previewNode('n4').data, definitionId: 'nano-banana' } }];
    const clusterWire = { ...wire('n3', 'n4', 'e1'), targetHandle: 'prompt' };
    const done = useGraphStore.getState().authorGenerationCluster({ definitionId: 'nano-banana', prompt: 'fog',
      params: {}, refPaths: [], quantity: 1, sessionId: 's1', genId: 'g1', layoutOrigin: { x: 0, y: 0 } });
    sync([...nodes(), ...cluster], [clusterWire]);
    sync([...nodes(), ...cluster], [], { edit: CLAUDE });
    await release('/api/graph/cluster', { status: 200, body: { idMap: {}, nodes: cluster, edges: [clusterWire] } });
    await done;
    expect(wires()).toEqual([]);
  });

  it('a proposal accept: a wire an agent removed meanwhile stays removed', () => {
    const watch = watchGraphSyncs();
    const accepted = previewNode('n3', 420);
    sync([...nodes(), accepted], [wire('n1', 'n3', 'e1')]);
    sync([...nodes(), accepted], [], { edit: CLAUDE });
    useGraphStore.getState().adoptAcceptedProposal({ nodes: [accepted], edges: [wire('n1', 'n3', 'e1')], updatedNodes: [] },
      { synced: watch.seen });
    watch.stop();
    expect(wires()).toEqual([]);
  });
});

describe('a wire drawn to a dynamic node before its create answered (review)', () => {
  it('is sent once the node has its backend id, and stays through the next sync', async () => {
    net.held.add('/api/graph/node');
    const tempId = useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 800, y: 0 })!;
    const port = NODE_DEFINITIONS['openrouter-universal'].inputPorts.find((item) => item.dataType === 'Text')!;
    useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'text', target: tempId, targetHandle: port.id });
    expect(net.calls.some((call) => call.path === '/api/graph/connect')).toBe(false);

    net.held.add('/api/graph/connect');
    await release('/api/graph/node', { status: 200, body: { id: 'n5' } });
    const connect = net.calls.find((call) => call.path === '/api/graph/connect');
    expect(connect?.body).toEqual({ source: 'n1', sourceHandle: 'text', target: 'n5', targetHandle: port.id });

    // An older sync (the create's own, say) without the wire: it is on its way.
    const n5 = { id: 'n5', type: 'dynamic-node', position: { x: 800, y: 0 },
      data: { label: 'OpenRouter', definitionId: 'openrouter-universal', params: {}, state: 'idle', outputs: {} } } as Node<NodeData>;
    sync([...nodes(), n5], []);
    expect(links()).toEqual(['n1->n5']);
  });
});

describe('wires on nodes only this tab has', () => {
  it('stay through a sync, as before', () => {
    const local = { ...textNode('7f0c2a9e-0000-4000-8000-000000000001', 0) };
    const localTarget = { ...previewNode('7f0c2a9e-0000-4000-8000-000000000002', 600) };
    useGraphStore.setState((state) => ({
      nodes: [...state.nodes, local, localTarget],
      edges: [wire(local.id, 'n2', 'u1'), wire(local.id, localTarget.id, 'u2')],
    }));
    sync(nodes(), [], { edit: CLAUDE });
    expect(wires()).toEqual([`u1:${local.id}->n2`, `u2:${local.id}->${localTarget.id}`]);
  });
});

describe('nodes, for comparison', () => {
  it("a node the backend deleted leaves with its wires (already so: nodes come only from the sync)", () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    sync([previewNode('n2')], [], { edit: CLAUDE });
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n2']);
    expect(wires()).toEqual([]);
  });
});

describe('the save path', () => {
  it("doesn't write a wire the backend removed back into the project", () => {
    sync(nodes(), [wire('n1', 'n2', 'e1')], { edit: CLAUDE });
    sync(nodes(), [], { edit: CLAUDE });
    expect(captureProjectSnapshot().edges).toEqual([]);
  });
});
