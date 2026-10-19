import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
const layout = vi.hoisted(() => ({ bodies: [] as unknown[], reply: { status: 'arranged' } as Record<string, unknown> }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => {
    if (path !== '/api/graph/layout') return Promise.reject(new Error('offline'));
    layout.bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify(layout.reply), { status: 200 }));
  },
}));

import { completeArrange, useGraphStore } from '../src/store/graphStore';
import { useArrangeStore } from '../src/store/arrangeStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const node = (id: string, x: number, y: number): Node<NodeData> => ({
  id, type: 'model-node', position: { x, y },
  data: { label: 'Image Input', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} },
});
function sync(extra: Record<string, unknown>) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [node('n1', 0, 0)], edges: [],
    empty: false, ...extra } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

beforeEach(() => {
  layout.bodies.length = 0;
  layout.reply = { status: 'arranged' };
  useGraphStore.setState({ nodes: [], edges: [] });
  useArrangeStore.setState({ pending: [], finished: [] });
});

describe('arrange requests from graphSync', () => {
  it('mirrors the backend list, and an older backend without one means none', () => {
    sync({ arrange: [{ id: 'a_1', nodeIds: ['n1', 7], direction: 'down', gap: 80 }, { id: 'bad' }] });
    expect(useArrangeStore.getState().pending).toEqual([{ id: 'a_1', nodeIds: ['n1'], direction: 'down', gap: 80 }]);
    const before = useArrangeStore.getState().pending;
    sync({ arrange: [{ id: 'a_1', nodeIds: ['n1'], direction: 'down', gap: 80 }] });
    expect(useArrangeStore.getState().pending).toBe(before);
    sync({});
    expect(useArrangeStore.getState().pending).toEqual([]);
  });

  it('writes the arrange with its id and leaves positions to the graphSync', async () => {
    useGraphStore.setState({ nodes: [node('n1', 0, 0)] });
    await expect(completeArrange('a_1', { n1: { x: 5, y: 6 }, 'local-uuid': { x: 0, y: 0 } })).resolves.toBe('arranged');
    expect(layout.bodies).toEqual([{ positions: { n1: { x: 5, y: 6 } }, arrangeId: 'a_1' }]);
    // This tab doesn't move the node itself: every tab takes the winner's positions from graphSync.
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });

    layout.reply = { status: 'already-arranged', count: 0 };
    await expect(completeArrange('a_1', { n1: { x: 9, y: 9 } })).resolves.toBe('already-arranged');
  });
});

describe('measuring', () => {
  it('renders every node only while this tab still has an arrange to do', async () => {
    const { selectMeasuring } = await import('../src/store/arrangeStore');
    useArrangeStore.setState({ pending: [], finished: [] });
    expect(selectMeasuring(useArrangeStore.getState())).toBe(false);
    useArrangeStore.getState().setPending([{ id: 'a_1', nodeIds: ['n1'], direction: 'right', gap: 120 }]);
    expect(selectMeasuring(useArrangeStore.getState())).toBe(true);
    useArrangeStore.getState().markFinished('a_1');
    expect(selectMeasuring(useArrangeStore.getState())).toBe(false);
    // Once the backend stops listing it, its id is dropped too.
    useArrangeStore.getState().setPending([]);
    expect(useArrangeStore.getState().finished).toEqual([]);
  });
});
