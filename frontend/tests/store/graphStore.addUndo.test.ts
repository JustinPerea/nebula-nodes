import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * Round 14 of PR #114 (review 13, M1 + M3, and Q2): every add's undo step
 * owns exactly the ids that add created. Its Undo removes those ids and
 * nothing else; Redo puts them back. A sync that brings the backend's nodes
 * into an empty tab, a sync that lands later, or a second add racing the
 * first never widens a step, so Undo never sends an id the step didn't add
 * (the agent's n1 was deleted by the person's Undo in review 13's Q1 and Q5).
 */

const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  getCachedBackendBaseUrl: () => 'http://localhost:8000',
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
noticeSpy();

const { useGraphStore } = await import('../../src/store/graphStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');
const { addDroppedFiles } = await import('../../src/lib/canvasFileDrop');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const agentN1 = { id: 'n1', type: 'model-node', position: { x: 400, y: 300 },
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: "the agent's" }, state: 'idle', outputs: {} } };
const dyn = (id: string, y = 20) => ({ id, type: 'dynamic-node', position: { x: 10, y },
  data: { label: 'x', definitionId: 'openrouter-universal', params: {}, state: 'idle', outputs: {} } });
const ownEcho = { tab: TAB_ID, actor: { kind: 'person' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const restores = () => fetchMock.mock.calls
  .filter(([url]) => String(url).includes('/api/graph/restore'))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { remove?: string[]; nodes?: { id: string }[] });
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);

/** Undo every step, one at a time, answering each restore 200. */
async function undoAll() {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({}));
  const steps = useGraphStore.getState().undoStack.length;
  for (let i = 0; i < steps; i += 1) {
    useGraphStore.getState().undo();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return restores();
}

beforeEach(() => {
  fetchMock.mockReset();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, clipboard: null } as never);
});

describe('two quick dynamic drops on an empty tab whose backend has the agent\'s n1 (review 13, Q1)', () => {
  it('each Undo removes only its own node; n1 is never sent', async () => {
    const exported = deferred<Response>();
    let nextId = 2;
    const backend: Record<string, unknown>[] = [agentN1];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/graph/export')) return exported.promise;
      if (String(url).includes('/api/graph/node')) {
        const id = `n${nextId++}`;
        const { position } = JSON.parse(String(init?.body)) as { position: { y: number } };
        backend.push(dyn(id, position.y));
        // The backend's echo lands before its HTTP answer.
        socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [...backend], edit: ownEcho });
        return json({ id });
      }
      return json({});
    });
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 220 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The first add's read of the backend answers after the second add's create.
    exported.resolve(json({ ...base, empty: false, edges: [], nodes: [agentN1] }));
    await vi.waitFor(() => expect(ids().sort()).toEqual(['n1', 'n2', 'n3']));
    expect(useGraphStore.getState().undoStack).toHaveLength(2);

    const bodies = await undoAll();
    for (const body of bodies) expect(body.remove).not.toContain('n1');
    expect(bodies.map((body) => body.remove)).toEqual([['n2'], ['n3']]);
    expect(ids()).toEqual(['n1']);
  });
});

describe('a dynamic add while an earlier sync failed (review 13, Q2)', () => {
  it('Undo removes only the new card, not the n1 the export brought in', async () => {
    const local = { id: 'local-uuid-1', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [local], backendFreshStartPending: true } as never);
    fetchMock.mockResolvedValueOnce(json({ ...base, empty: false, edges: [], nodes: [agentN1] }));
    fetchMock.mockResolvedValueOnce(json({ id: 'n2' }));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(ids()).toContain('n2'));
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1, dyn('n2')], edit: ownEcho });
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids().sort()).toEqual(['local-uuid-1', 'n1']);
  });
});

describe('a file drop on an empty tab whose backend has the agent\'s n1 (review 13, Q5)', () => {
  it('Undo removes only the dropped file\'s node', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'up1', nodeId: 'n2' }));
    await addDroppedFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })], { x: 0, y: 0 });
    const textNode = { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, state: 'idle', outputs: {} } };
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1, textNode], edit: ownEcho });
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids()).toEqual(['n1']);
  });

  it('when the echo lands before the upload answers, the step still owns only the dropped node', async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValueOnce(answer.promise);
    const dropping = addDroppedFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })], { x: 0, y: 0 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const textNode = { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, state: 'idle', outputs: {} } };
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1, textNode], edit: ownEcho });
    answer.resolve(json({ id: 'up1', nodeId: 'n2' }));
    await dropping;
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids()).toEqual(['n1']);
  });

  it('a failed upload leaves no step', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'nope' }, 400));
    await addDroppedFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })], { x: 0, y: 0 });
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });
});

describe('a static add (library, Character, Moodboard) is one step that owns its node', () => {
  it('addNode on an empty tab: Undo removes n2 only, Redo puts it back', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...base, empty: false, edges: [], nodes: [agentN1] }));
    fetchMock.mockImplementationOnce(async () => {
      // The echo lands before the HTTP answer, as on the backend.
      socketSends({ type: 'graphSync', ...base, empty: false, edges: [],
        nodes: [agentN1, { ...agentN1, id: 'n2', position: { x: 10, y: 20 }, data: { ...agentN1.data, params: {} } }], edit: ownEcho });
      return json({ id: 'n2' });
    });
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBe('n2');
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids()).toEqual(['n1']);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().redo();
    await vi.waitFor(() => expect(restores()).toHaveLength(1));
    expect(restores()[0].nodes?.map((node) => node.id)).toEqual(['n2']);
    expect(restores()[0].remove).toEqual([]);
    expect(ids().sort()).toEqual(['n1', 'n2']);
  });
});

describe('a stale sync after an add never widens its step', () => {
  it('an agent node arriving by a later sync without an edit marker is not undone with the add', async () => {
    useGraphStore.setState({ nodes: [{ ...agentN1, id: 'n5' }] } as never);
    fetchMock.mockResolvedValueOnce(json({ id: 'n2' }));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(ids()).toContain('n2'));
    // A sync with no edit marker (a reconnect's) brings the agent's n1.
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [{ ...agentN1, id: 'n5' }, agentN1, dyn('n2')] });
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids().sort()).toEqual(['n1', 'n5']);
  });
});

describe('add-and-connect owns its node and its wire', () => {
  it('Undo removes the new node (its wire goes with it) and nothing else', async () => {
    const src = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [src] } as never);
    fetchMock.mockResolvedValueOnce(json({ id: 'n2', definitionId: 'veo-3', connected: true,
      edge: { id: 'e1', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'image', type: 'typed-edge' } }));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 },
      { source: 'n1', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' })).toBe('n2');
    // An agent's node arrives by an unmarked sync after the add.
    socketSends({ type: 'graphSync', ...base, empty: false, nodes: [src, { ...agentN1, id: 'n3' },
      { ...src, id: 'n2', data: { ...src.data, label: 'Veo 3.1', definitionId: 'veo-3' }, position: { x: 400, y: 0 } }],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'image', type: 'typed-edge' }] });
    const bodies = await undoAll();
    expect(bodies.map((body) => body.remove)).toEqual([['n2']]);
    expect(ids().sort()).toEqual(['n1', 'n3']);
    expect(useGraphStore.getState().edges).toEqual([]);
  });
});

describe('paste and duplicate own the copies they made', () => {
  it('Undo of a paste removes only the pasted copies, even after a sync brought an agent node in', () => {
    const local = { id: 'local-1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [local] } as never);
    useGraphStore.getState().copySelected();
    const pasted = useGraphStore.getState().pasteClipboard();
    expect(pasted).toHaveLength(1);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1] });
    useGraphStore.getState().undo();
    expect(ids().sort()).toEqual(['local-1', 'n1']);
  });

  it('Undo of a duplicate removes only the copy', () => {
    const local = { id: 'local-1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [local] } as never);
    useGraphStore.getState().duplicateNode('local-1');
    expect(ids()).toHaveLength(2);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentN1] });
    useGraphStore.getState().undo();
    expect(ids().sort()).toEqual(['local-1', 'n1']);
  });
});
