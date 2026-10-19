import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
const net = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }> }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    net.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/graph/layout') return new Response(JSON.stringify({ status: 'arranged' }), { status: 200 });
    return new Response('{}', { status: 200 });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { completeArrange, useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';

const CLAUDE = { actor: { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' } };

function textNode(id: string, value: string, x = 0, y = 0): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} },
  };
}
function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = {
    type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra,
  } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

const restores = () => net.calls.filter((call) => call.path === '/api/graph/restore').map((call) => call.body as {
  action: string; nodes: Array<{ id: string; position?: { x: number; y: number } }>; remove: string[];
});
const position = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)?.position;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The person's node, and the agent's two new nodes: placed stacked, then arranged.
const mine = textNode('n1', 'a lighthouse');
const STACKED = { n2: { x: 1000, y: 0 }, n3: { x: 1000, y: 0 } };
const ARRANGED = { n2: { x: 1200, y: 40 }, n3: { x: 1600, y: 40 } };
const REQUEST = { id: 'a_1', nodeIds: ['n2', 'n3'], direction: 'right', gap: 120 };
const agentNodes = (at: Record<string, { x: number; y: number }>) =>
  [textNode('n2', 'fog', at.n2.x, at.n2.y), textNode('n3', 'dusk', at.n3.x, at.n3.y)];

/** The agent's edit lands with an arrange request. */
const agentApply = () => sync([mine, ...agentNodes(STACKED)], [], { edit: CLAUDE, arrange: [REQUEST] });
/** The backend's sync after a canvas finished the arrange (PUT /api/graph/layout + arrangeId). */
const arrangeDone = () => sync([mine, ...agentNodes(ARRANGED)], [],
  { moved: ['n2', 'n3'], arranged: { id: 'a_1', nodeIds: ['n2', 'n3'] }, arrange: [] });

beforeEach(() => {
  net.calls.length = 0;
  useGraphStore.setState({ nodes: [{ ...mine }], edges: [], undoStack: [], redoStack: [], undoNotice: null,
    isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
});

async function expectOneAgentStepThatRedoesArranged() {
  const { undoStack, undoNotice } = useGraphStore.getState();
  expect(undoStack).toHaveLength(1);
  expect(undoStack[0]).toMatchObject({ kind: 'foreign', agentName: 'Claude', source: 'agent' });
  expect(undoNotice).toMatchObject({ text: 'Claude changed the canvas', offer: 'undo', entry: undoStack[0] });

  useGraphStore.getState().undo();
  expect(position('n2')).toBeUndefined();
  expect(useGraphStore.getState().undoStack).toHaveLength(0);
  useGraphStore.getState().redo();
  expect(position('n2')).toEqual(ARRANGED.n2);
  expect(position('n3')).toEqual(ARRANGED.n3);
  await flush();
  const [undone, redone] = restores();
  expect(undone).toMatchObject({ action: 'undo', remove: ['n2', 'n3'] });
  expect(redone.action).toBe('redo');
  expect(Object.fromEntries(redone.nodes.map((node) => [node.id, node.position]))).toEqual(ARRANGED);
}

describe("an agent's arrange is part of the agent's undo step", () => {
  it('in a tab that did not arrange: no second step, no notice, and redo keeps the arranged positions', async () => {
    agentApply();
    const notice = useGraphStore.getState().undoNotice;
    arrangeDone();
    expect(position('n2')).toEqual(ARRANGED.n2);
    // No "edit arrived" notice for the arrange: the agent's notice is the one showing.
    expect(useGraphStore.getState().undoNotice?.id).toBe(notice?.id);
    await expectOneAgentStepThatRedoesArranged();
  });

  it('in the tab that arranged: its write leaves the step alone, and the sync folds the positions in', async () => {
    agentApply();
    await expect(completeArrange('a_1', ARRANGED)).resolves.toBe('arranged');
    expect(net.calls.find((call) => call.path === '/api/graph/layout')?.body)
      .toEqual({ positions: ARRANGED, arrangeId: 'a_1' });
    arrangeDone();
    expect(position('n3')).toEqual(ARRANGED.n3);
    await expectOneAgentStepThatRedoesArranged();
  });

  it('a person edit made before the arrange landed keeps the arranged positions when undone', async () => {
    agentApply();
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'a fort' } });
    expect(useGraphStore.getState().undoStack).toHaveLength(2);
    arrangeDone();
    expect(useGraphStore.getState().undoStack).toHaveLength(2);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('a lighthouse');
    expect(position('n2')).toEqual(ARRANGED.n2);
    useGraphStore.getState().undo();
    useGraphStore.getState().redo();
    expect(position('n2')).toEqual(ARRANGED.n2);
    useGraphStore.getState().redo();
    expect(position('n3')).toEqual(ARRANGED.n3);
    await flush();
    // No restore ever writes the stacked positions back.
    for (const body of restores()) {
      for (const node of body.nodes) if (node.position) expect(node.position).toEqual(ARRANGED[node.id as 'n2' | 'n3']);
    }
  });

  it('an agent step already undone when the arrange lands redoes to the arranged positions', async () => {
    agentApply();
    useGraphStore.getState().undo();
    // The arrange won on the backend before this tab's undo reached it ...
    arrangeDone();
    // ... then the undo landed and removed the nodes there too (this tab's own echo).
    sync([mine], [], { edit: { actor: { kind: 'person' }, tab: TAB_ID } });
    expect(useGraphStore.getState().redoStack).toHaveLength(1);
    useGraphStore.getState().redo();
    expect(position('n2')).toEqual(ARRANGED.n2);
    await flush();
    const redone = restores().find((body) => body.action === 'redo')!;
    expect(Object.fromEntries(redone.nodes.map((node) => [node.id, node.position]))).toEqual(ARRANGED);
  });

  it('a tab with no step for the agent edit just takes the positions', () => {
    useGraphStore.setState({ nodes: [{ ...mine }, ...agentNodes(STACKED)] });
    arrangeDone();
    expect(position('n2')).toEqual(ARRANGED.n2);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('a layout write from another window is still its own step', () => {
    agentApply();
    sync([mine, ...agentNodes(ARRANGED)], [], { moved: ['n2', 'n3'], edit: { actor: { kind: 'person' }, tab: 'other-tab-0001' } });
    expect(useGraphStore.getState().undoStack).toHaveLength(2);
  });
});
