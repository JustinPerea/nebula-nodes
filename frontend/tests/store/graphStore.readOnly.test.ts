import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * Round 14 of PR #114 (GM: "Blocking it is. Edits are blocked while offline,
 * not queued."). One gate every edit goes through: while Nebula is offline,
 * every edit entry point changes nothing, sends nothing and shows no toast;
 * the banner pulses instead. Review 13 found two that still sent
 * (add-and-connect, M2; a file drop, L6), and round 13's edits made offline
 * were reverted by the reconnect's sync with no word.
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
vi.spyOn(console, 'error').mockImplementation(() => {});
const alertMock = noticeSpy();

const { useGraphStore } = await import('../../src/store/graphStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { noteBackendConnection, resetBackendConnectionForTests, subscribeBlockedEdits } = await import('../../src/lib/backendConnection');
const { addDroppedFiles } = await import('../../src/lib/canvasFileDrop');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const textNode = (id: string, x = 0, selected = false) => ({ id, type: 'model-node', position: { x, y: 0 }, selected,
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'saved' }, state: 'idle', outputs: {} } });
const banana = { id: 'n3', type: 'model-node', position: { x: 0, y: 300 },
  data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} } };
const router = { id: 'n4', type: 'dynamic-node', position: { x: 0, y: 600 },
  data: { label: 'OpenRouter', definitionId: 'openrouter-universal', params: {}, state: 'idle', outputs: {}, isDynamic: true } };
const wire = { id: 'e1', type: 'typed-edge', source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'text' };
const priorStep = { nodes: [], edges: [] };

let blocked = 0;
subscribeBlockedEdits(() => { blocked += 1; });

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ id: 'n9' }));
  alertMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({
    nodes: [textNode('n1', 0, true), textNode('n2', 400), banana, router], edges: [wire],
    undoStack: [priorStep], redoStack: [priorStep], isExecuting: false, backendFreshStartPending: false,
    undoNotice: null, isImportingGraph: false,
    clipboard: { nodes: [textNode('n1')], edges: [], params: { n1: { value: 'saved' } }, source: { projectId: 'A', load: 0 } },
  } as never);
  noteBackendConnection('offline');
  blocked = 0;
});

type Attempt = [string, () => unknown];
const ATTEMPTS: Attempt[] = [
  ['addNode', () => useGraphStore.getState().addNode('text-input', { x: 900, y: 0 })],
  ['addDynamicNode', () => useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 900, y: 0 })],
  ['addCharacterNode', () => useGraphStore.getState().addCharacterNode('ch_1', { x: 900, y: 0 })],
  ['addMoodboardNode', () => useGraphStore.getState().addMoodboardNode('mb_1', { x: 900, y: 0 })],
  ['addNodeAndConnect', () => useGraphStore.getState().addNodeAndConnect('veo-3', { x: 900, y: 0 },
    { source: 'n3', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' })],
  ['param edit', () => useGraphStore.getState().updateNodeData('n1', { params: { value: 'edited offline' } })],
  ['rename', () => useGraphStore.getState().renameNode('n1', 'Renamed offline')],
  ['model change (OpenRouter)', () => useGraphStore.getState().configureOpenRouterModel('n4', 'openai/gpt-5')],
  ['model change (Replicate)', () => useGraphStore.getState().fetchReplicateSchemaAndConfigure('n4', 'owner', 'name')],
  ['move (drag)', () => useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 50, y: 50 }, dragging: true }])],
  ['move (drop)', () => useGraphStore.getState().onNodesChange([{ id: 'n1', type: 'position', position: { x: 50, y: 50 }, dragging: false }])],
  ['connect', () => useGraphStore.getState().onConnect({ source: 'n2', sourceHandle: 'text', target: 'n1', targetHandle: 'text' })],
  ['delete node (keyboard)', () => useGraphStore.getState().onNodesChange([{ id: 'n2', type: 'remove' }])],
  ['delete wire', () => useGraphStore.getState().onEdgesChange([{ id: 'e1', type: 'remove' }])],
  ['deleteSelected', () => useGraphStore.getState().deleteSelected()],
  ['deleteNode', () => useGraphStore.getState().deleteNode('n2')],
  ['paste', () => useGraphStore.getState().pasteClipboard()],
  ['duplicateSelected', () => useGraphStore.getState().duplicateSelected()],
  ['duplicateNode', () => useGraphStore.getState().duplicateNode('n1')],
  ['autoLayoutSelected', () => useGraphStore.getState().autoLayoutSelected()],
  ['autoLayout', () => useGraphStore.getState().autoLayout()],
  ['Clear (store)', () => useGraphStore.getState().clearGraph()],
  ['undo', () => useGraphStore.getState().undo()],
  ['redo', () => useGraphStore.getState().redo()],
  ['file drop', () => addDroppedFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })], { x: 0, y: 0 })],
];

describe('while Nebula is offline, every edit entry point is blocked', () => {
  it.each(ATTEMPTS)('%s: no request, no change, no toast; the banner is asked to pulse', async (_name, attempt) => {
    const before = useGraphStore.getState();
    await attempt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = useGraphStore.getState();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.redoStack).toBe(before.redoStack);
    expect(after.undoNotice).toBeNull();
    expect(alertMock).not.toHaveBeenCalled();
    expect(blocked).toBe(1);
  });

  it('selecting a node still works (not an edit) and nothing is blocked', () => {
    useGraphStore.getState().onNodesChange([{ id: 'n2', type: 'select', selected: true }]);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')?.selected).toBe(true);
    expect(blocked).toBe(0);
  });

  it('a run-state update (no params) still applies', () => {
    useGraphStore.getState().updateNodeData('n1', { state: 'executing' });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.state).toBe('executing');
    expect(blocked).toBe(0);
  });

  it('back online, the same edit goes through', async () => {
    noteBackendConnection('online');
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'edited online' } });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('edited online');
    expect(blocked).toBe(0);
  });
});

// Review 13, M2's second half: an add-and-connect whose answer was lost was
// left "uncertain", and every later add-and-connect was refused until a
// reload. Review 14, nit 3: a reconnect to the same backend process doesn't
// release it (the create may still commit); a restarted backend (a new
// bootId on the socket's first sync) does, when its graph lacks the pair.
describe('an unresolved add-and-connect is released only by a restarted backend', () => {
  const connect = { source: 'n3', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' as const };
  async function loseAnAnswer() {
    noteBackendConnection('online');
    useGraphStore.setState({ nodes: [banana], edges: [] } as never);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-1' });
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect)).toBeNull();
    // Still unresolved: refused without sending.
    fetchMock.mockReset();
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it('the socket reconnects to the same backend: the create still holds', async () => {
    await loseAnAnswer();
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-1' });
    fetchMock.mockReset();
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    expect(fetchMock).not.toHaveBeenCalled();
    // Clean up for later tests: a restarted backend releases it.
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-cleanup' });
  });

  it('the backend restarted (a new bootId) and its graph lacks the pair: add-and-connect sends again', async () => {
    await loseAnAnswer();
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-2' });
    fetchMock.mockResolvedValueOnce(json({ detail: 'nope' }, 409));
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      [expect.stringContaining('/api/graph/node-and-connect')]);
  });

  it('a sync before the reconnect (the old socket) does not release it', async () => {
    await loseAnAnswer();
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-3' });
    fetchMock.mockReset();
    await useGraphStore.getState().addNodeAndConnect('veo-3', { x: 400, y: 0 }, connect);
    expect(fetchMock).not.toHaveBeenCalled();
    socketSends({ type: 'socketReconnected' });
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [banana], bootId: 'boot-cleanup-2' });
  });
});
