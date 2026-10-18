import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
const layoutWrites = vi.hoisted(() => ({ settle: [] as Array<() => void>, bodies: [] as unknown[] }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => {
    if (path !== '/api/graph/layout') return Promise.reject(new Error('offline'));
    layoutWrites.bodies.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => {
      layoutWrites.settle.push(() => resolve(new Response('{}', { status: 200 })));
    });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const node = (id: string, x: number, y: number, extra: Partial<Node<NodeData>> = {}): Node<NodeData> => ({
  id, type: 'model-node', position: { x, y }, ...extra,
  data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} },
});
function sync(nodes: Node<NodeData>[], moved?: string[]) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges: [], empty: false,
    ...(moved ? { moved } : {}) } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const position = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)?.position;

beforeEach(() => {
  layoutWrites.settle.length = 0;
  layoutWrites.bodies.length = 0;
  useGraphStore.setState({ nodes: [node('n1', 0, 0), node('n2', 0, 300)], edges: [], undoStack: [], redoStack: [] });
});
afterEach(async () => {
  for (const settle of layoutWrites.settle.splice(0)) settle();
  await Promise.resolve();
});

describe('positions from the backend', () => {
  it('an agent move reaches an open canvas', () => {
    sync([node('n1', 520, 40), node('n2', 0, 300)], ['n1']);

    expect(position('n1')).toEqual({ x: 520, y: 40 });
    expect(position('n2')).toEqual({ x: 0, y: 300 });
  });

  it('a sync that moved nothing keeps the canvas positions', () => {
    useGraphStore.setState({ nodes: [node('n1', 10, 10), node('n2', 0, 300)] });

    sync([node('n1', 0, 0), node('n2', 0, 300)]);

    expect(position('n1')).toEqual({ x: 10, y: 10 });
  });

  it('a node the person is dragging stays under the pointer', () => {
    useGraphStore.setState({ nodes: [node('n1', 50, 50, { dragging: true }), node('n2', 0, 300)] });

    sync([node('n1', 520, 40), node('n2', 0, 300)], ['n1']);

    expect(position('n1')).toEqual({ x: 50, y: 50 });
  });

  it('this tab\'s own layout write wins over an older echo until it settles', async () => {
    useGraphStore.getState().onNodesChange([
      { type: 'position', id: 'n1', position: { x: 100, y: 100 }, dragging: false },
    ]);
    useGraphStore.getState().onNodesChange([
      { type: 'position', id: 'n1', position: { x: 200, y: 200 }, dragging: false },
    ]);
    expect(layoutWrites.bodies).toHaveLength(2);

    // The first drop's echo arrives after the second drop.
    sync([node('n1', 100, 100), node('n2', 0, 300)], ['n1']);
    expect(position('n1')).toEqual({ x: 200, y: 200 });

    for (const settle of layoutWrites.settle.splice(0)) settle();
    await vi.waitFor(() => {
      sync([node('n1', 640, 0), node('n2', 0, 300)], ['n1']);
      expect(position('n1')).toEqual({ x: 640, y: 0 });
    });
  });
});
