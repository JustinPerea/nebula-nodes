import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * Placeholders on the canvas (Q125 item 3): the flag is the backend's, so a
 * graphSync without it clears it here; the person's undo and redo send it
 * back as the step had it; and a Run that skipped placeholders says so in
 * GM's line (2026-10-25, verbatim).
 */

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { useGraphStore, watchGraphSyncs } = await import('../src/store/graphStore');
const { wsClient } = await import('../src/lib/wsClient');
const { GRAPH_PARAMS_VERSION } = await import('../src/lib/savedParamsUpgrades');
const { restoreRequest } = await import('../src/lib/canvasUndo');
const api = await import('../src/lib/api');
const { CANVAS_NOTICE_EVENT } = await import('../src/lib/canvasNotice');
const { TAB_ID } = await import('../src/lib/tabId');

const CODEX_FLAG = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false }, at: 1 };

function textNode(id: string, pending?: unknown): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'fog' }, state: 'idle', outputs: {},
      ...(pending ? { pending } : {}) },
  } as Node<NodeData>;
}

function sync(nodes: Node<NodeData>[], extra: Record<string, unknown> = {}) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes), edges: [],
    empty: nodes.length === 0, ...extra };
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: unknown) => void)(event);
}

beforeEach(() => {
  watchGraphSyncs();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], runHistory: [], isExecuting: false,
    backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [] });
  apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
});

describe('the flag comes from the backend', () => {
  it('arrives with a graphSync and leaves with the next one that has none', () => {
    sync([textNode('n1', CODEX_FLAG)]);
    expect(useGraphStore.getState().nodes[0].data.pending).toEqual(CODEX_FLAG);
    sync([textNode('n1')]);
    expect(useGraphStore.getState().nodes[0].data.pending).toBeUndefined();
  });
});

describe("the person's undo and redo", () => {
  it('send the flag as the step had it, or null for none', () => {
    const before = [textNode('n1', CODEX_FLAG)];
    const after = [textNode('n1')];
    const undo = restoreRequest('undo', after, [], before, []);
    expect(undo?.nodes).toEqual([{ id: 'n1', definitionId: 'text-input', pending: CODEX_FLAG }]);
    const redo = restoreRequest('redo', before, [], after, []);
    expect(redo?.nodes).toEqual([{ id: 'n1', definitionId: 'text-input', pending: null }]);
    // A node that comes back whole carries it too.
    const back = restoreRequest('redo', [], [], before, []);
    expect(back?.nodes[0]).toMatchObject({ id: 'n1', pending: CODEX_FLAG });
  });
});

describe('a placeholder the backend made normal', () => {
  const restores: Array<{ nodes: Array<{ id: string; pending?: unknown }> }> = [];
  const nodeById = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id)!;
  const withValue = (node: Node<NodeData>, value: string) =>
    ({ ...node, data: { ...node.data, params: { value } } }) as Node<NodeData>;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    restores.length = 0;
    apiFetchMock.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/graph/restore') restores.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    });
  });

  it("stays normal when the person undoes or redoes an unrelated step", async () => {
    sync([textNode('n1'), textNode('n5', CODEX_FLAG)]);
    // The person's step (on n1) holds the whole canvas, n5's flag with it.
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'a fort' } });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    // Codex says n5 is ready (pending: false; or its run, or the idle rule): no step here.
    sync([withValue(textNode('n1'), 'a fort'), textNode('n5')]);
    expect(nodeById('n5').data.pending).toBeUndefined();
    useGraphStore.getState().undo();
    expect(nodeById('n1').data.params.value).toBe('fog');
    expect(nodeById('n5').data.pending).toBeUndefined();
    useGraphStore.getState().redo();
    expect(nodeById('n5').data.pending).toBeUndefined();
    await flush();
    expect(restores.length).toBeGreaterThan(0);
    for (const body of restores) {
      expect(body.nodes.find((node) => node.id === 'n5')).toBeUndefined();
    }
  });

  it("comes back when the person undoes their own edit that made it normal", async () => {
    sync([textNode('n5', CODEX_FLAG)]);
    useGraphStore.getState().updateNodeData('n5', { params: { value: 'mine now' } });
    // The backend clears it for the person's edit; the sync is this tab's own echo.
    sync([withValue(textNode('n5'), 'mine now')], { edit: { tab: TAB_ID, actor: { kind: 'person' } } });
    expect(nodeById('n5').data.pending).toBeUndefined();
    useGraphStore.getState().undo();
    expect(nodeById('n5').data.pending).toEqual(CODEX_FLAG);
    await flush();
    expect(restores.at(-1)?.nodes.find((node) => node.id === 'n5')?.pending).toEqual(CODEX_FLAG);
  });
});

describe('the Run skip line', () => {
  it("says what Run skipped, in GM's words", async () => {
    useGraphStore.setState({ nodes: [textNode('n1', CODEX_FLAG), textNode('n2')] });
    const notices: string[] = [];
    const listen = (event: Event) => notices.push((event as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(CANVAS_NOTICE_EVENT, listen);
    vi.spyOn(api, 'executeGraph').mockResolvedValue({
      status: 'started', runId: 'r1', pendingSkipped: { count: 1, agents: ['Codex'] },
    } as Awaited<ReturnType<typeof api.executeGraph>>);
    await useGraphStore.getState().executeGraph();
    window.removeEventListener(CANVAS_NOTICE_EVENT, listen);
    expect(notices).toContain('Skipped 1 node Codex is still setting up.');
  });

  it('says it after Run selected and an accepted proposal\'s run (executeCluster)', async () => {
    useGraphStore.setState({ nodes: [textNode('n1', CODEX_FLAG), textNode('n2')] });
    const notices: string[] = [];
    const listen = (event: Event) => notices.push((event as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(CANVAS_NOTICE_EVENT, listen);
    vi.spyOn(api, 'executeGraph').mockResolvedValue({
      status: 'started', runId: 'r3', pendingSkipped: { count: 1, agents: ['Codex'] },
    } as Awaited<ReturnType<typeof api.executeGraph>>);
    await useGraphStore.getState().executeCluster(['n1', 'n2'], { approvalId: 'a1' });
    window.removeEventListener(CANVAS_NOTICE_EVENT, listen);
    expect(notices).toContain('Skipped 1 node Codex is still setting up.');
  });

  it('says nothing when nothing was skipped', async () => {
    useGraphStore.setState({ nodes: [textNode('n2')] });
    const notices: string[] = [];
    const listen = (event: Event) => notices.push((event as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(CANVAS_NOTICE_EVENT, listen);
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started', runId: 'r2' });
    await useGraphStore.getState().executeNode('n2');
    window.removeEventListener(CANVAS_NOTICE_EVENT, listen);
    expect(notices.filter((text) => text.startsWith('Skipped'))).toEqual([]);
  });
});
