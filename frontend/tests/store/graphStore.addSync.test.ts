import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * Round 12 of PR #114 (GM approved, 2026-10-26): the first add on an empty
 * tab no longer clears the backend's canvas. If the backend has nodes the tab
 * doesn't show (an agent's, or ones this tab missed), the add brings them in
 * through the canvas's normal sync, then adds the node where the person put
 * it. No toast. If that sync fails, the node isn't added (not even locally)
 * and the person reads "Couldn't add “<label>”."; the reason goes to the
 * Agent log. Character, Moodboard and dynamic nodes go the same way, and a
 * failure never leaves the node only in this tab.
 *
 * Before round 12 the add sent DELETE /api/graph?force=true (an agent's work
 * wiped by the person's first drop), and Character/Moodboard/dynamic adds
 * added the node locally on any failure, with only a console line.
 */

// The socket's handlers, so a test can land a graphSync while an add is out.
const transport = vi.hoisted(() => ({ handlers: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: unknown) => void) => { transport.handlers.push(handler); }),
    disconnect: vi.fn() },
}));
const socketSends = (event: Record<string, unknown>) => { for (const handler of transport.handlers) handler(event); };
const backendDiscovery = vi.hoisted(() => ({ baseUrl: 'http://localhost:8000' as string | null }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  getCachedBackendBaseUrl: () => backendDiscovery.baseUrl,
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
const alertMock = noticeSpy();

const { useGraphStore } = await import('../../src/store/graphStore');
// The Agent log listens for nebula:agent-log-entry once loaded, as with the app.
const { useAgentLogStore } = await import('../../src/store/agentLogStore');
const { GRAPH_PARAMS_VERSION } = await import('../../src/lib/savedParamsUpgrades');
const { NODE_DEFINITIONS } = await import('../../src/constants/nodeDefinitions');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { TAB_ID } = await import('../../src/lib/tabId');
const { noteBackendConnection } = await import('../../src/lib/backendConnection');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const agentsNode = {
  id: 'n1', type: 'model-node', position: { x: 400, y: 300 },
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: "the agent's" }, state: 'idle', outputs: {} },
};
const backendHas = (extra: Record<string, unknown> = {}) => json({
  activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION,
  nodes: [agentsNode], edges: [], empty: false, ...extra });
const paths = () => fetchMock.mock.calls.map(([url, init]) =>
  `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url).replace('http://localhost:8000', '')}`);
const alerted = () => alertMock.mock.calls.map(([text]) => text);
const logged = () => useAgentLogStore.getState().entries.map((entry) => entry.message);
const label = (definitionId: string) => NODE_DEFINITIONS[definitionId].displayName;
const couldntAdd = (definitionId: string) => `Couldn't add “${label(definitionId)}”.`;

beforeEach(() => {
  fetchMock.mockReset();
  alertMock.mockClear();
  backendDiscovery.baseUrl = 'http://localhost:8000';
  noteBackendConnection('online');
  setProjectContext({ id: 'A', revision: 'a' });
  useAgentLogStore.getState().clear();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null, isImportingGraph: false } as never);
});

type Add = (position: { x: number; y: number }) => Promise<string | null>;
const ADDS: [string, string, Add][] = [
  ['addNode', 'text-input', (position) => useGraphStore.getState().addNode('text-input', position)],
  ['addCharacterNode', 'character', (position) => useGraphStore.getState().addCharacterNode('ch_1', position)],
  ['addMoodboardNode', 'nebula-moodboard', (position) => useGraphStore.getState().addMoodboardNode('mb_1', position)],
];

describe('the first add on an empty tab syncs the backend\'s nodes in and never clears', () => {
  it.each(ADDS)('%s: brings the agent\'s node in, then adds where the person put it', async (_name, definitionId, add) => {
    fetchMock.mockResolvedValueOnce(backendHas()).mockResolvedValueOnce(json({ id: 'n2' }));
    expect(await add({ x: 10, y: 20 })).toBe('n2');
    expect(paths()).toEqual(['GET /api/graph/export', 'POST /api/graph/node']);
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.definitionId).toBe(definitionId);
    expect(body.position).toEqual({ x: 10, y: 20 });
    // The agent's node is on the canvas, as the backend has it; no toast.
    const nodes = useGraphStore.getState().nodes;
    expect(nodes.map((node) => node.id)).toEqual(['n1']);
    expect(nodes[0].data.params.value).toBe("the agent's");
    expect(nodes[0].position).toEqual({ x: 400, y: 300 });
    expect(alerted()).toEqual([]);
    expect(useGraphStore.getState().backendFreshStartPending).toBe(false);
  });

  it('a dynamic node: the same sync, never a clear', async () => {
    fetchMock.mockResolvedValueOnce(backendHas()).mockResolvedValueOnce(json({ id: 'n2' }));
    const tempId = useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    expect(tempId).toBeTruthy();
    await vi.waitFor(() => expect(useGraphStore.getState().nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']));
    expect(paths()).toEqual(['GET /api/graph/export', 'POST /api/graph/node']);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')!.position).toEqual({ x: 10, y: 20 });
    expect(alerted()).toEqual([]);
  });

  it('a tab with nodes doesn\'t ask at all', async () => {
    useGraphStore.setState({ nodes: [{ ...agentsNode }] as never });
    fetchMock.mockResolvedValueOnce(json({ id: 'n2' }));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBe('n2');
    expect(paths()).toEqual(['POST /api/graph/node']);
  });
});

const SYNC_FAILURES: [string, () => void, RegExp][] = [
  ['the export is refused', () => fetchMock.mockResolvedValueOnce(json({ detail: 'export broke' }, 500)), /export broke/],
  ['the export can\'t be read', () => fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 })),
    /JSON|Unexpected/],
  ['the export is another project\'s', () => fetchMock.mockResolvedValueOnce(backendHas({ workspaceRevision: 'b' })),
    /out of date/],
  ['the export is another params version\'s', () => fetchMock.mockResolvedValueOnce(
    backendHas({ paramsVersion: GRAPH_PARAMS_VERSION + 1 })), /Nebula was updated while this tab was open/],
];

describe('a sync that fails: nothing is added, the person reads GM\'s line, the reason goes to the Agent log', () => {
  for (const [what, fail, reason] of SYNC_FAILURES) {
    it.each(ADDS)(`%s, when ${what}`, async (_name, definitionId, add) => {
      fail();
      expect(await add({ x: 10, y: 20 })).toBeNull();
      expect(useGraphStore.getState().nodes).toEqual([]);
      expect(paths().filter((path) => !path.startsWith('GET'))).toEqual([]);
      expect(alerted()).toEqual([couldntAdd(definitionId)]);
      expect(logged()).toHaveLength(1);
      expect(logged()[0].startsWith(`${couldntAdd(definitionId)} `)).toBe(true);
      expect(logged()[0]).toMatch(reason);
    });
  }

  it('a dynamic node is taken off the tab again', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'export broke' }, 500));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(alerted()).toEqual([couldntAdd('openrouter-universal')]));
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(logged()[0]).toMatch(/export broke/);
  });

  it('with no backend found at all, nothing is added and GM\'s line says so (round 13, GM: local-only adds are refused)', async () => {
    backendDiscovery.baseUrl = null;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alerted()).toEqual(["Couldn't add “Text Input”. Nebula isn't connected yet. Try again once it is."]);
    // The next add on the tab asks again.
    expect(useGraphStore.getState().backendFreshStartPending).toBe(true);
  });

  it.each(ADDS)('%s with no backend found at all: refused the same way, nothing in this tab', async (_name, definitionId, add) => {
    backendDiscovery.baseUrl = null;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await add({ x: 10, y: 20 })).toBeNull();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alerted()).toEqual([`Couldn't add “${label(definitionId)}”. Nebula isn't connected yet. Try again once it is.`]);
  });

  it('a dynamic node with no backend found at all: its card comes off again', async () => {
    backendDiscovery.baseUrl = null;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(alerted()).toEqual([
      `Couldn't add “${label('openrouter-universal')}”. Nebula isn't connected yet. Try again once it is.`]));
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().undoStack).toEqual([]);
  });
});

describe('a refused create after the sync: the add path\'s own line, and nothing only in this tab', () => {
  it.each(ADDS)('%s', async (_name, definitionId, add) => {
    fetchMock.mockResolvedValueOnce(json({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(json({ detail: 'Graph has protected provider state' }, 409));
    expect(await add({ x: 10, y: 20 })).toBeNull();
    expect(useGraphStore.getState().nodes).toEqual([]);
    // Round 13 (review 12 item 5): GM's quoted heading on every add path.
    expect(alerted()).toEqual([`Couldn't add “${label(definitionId)}”. Graph has protected provider state`]);
  });

  it('a dynamic node is taken off the tab again', async () => {
    fetchMock.mockResolvedValueOnce(json({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(json({ detail: 'Graph has protected provider state' }, 409));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(alerted()).toEqual([
      `Couldn't add “${label('openrouter-universal')}”. Graph has protected provider state`]));
    expect(useGraphStore.getState().nodes).toEqual([]);
  });
});

// Round 13 of PR #114 (GM) said "Couldn't add “Text Input” while Nebula is
// offline."; round 14 (GM) dropped it: offline is read-only, so an add while
// the banner shows sends nothing and says nothing (the banner pulses;
// graphStore.readOnly.test.ts walks every edit), and an add whose sync finds
// the backend gone reads the add heading, as any failed sync.
describe('an add while Nebula is offline', () => {
  it.each(ADDS)('%s: the backend can\'t be reached during the sync', async (_name, definitionId, add) => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await add({ x: 10, y: 20 })).toBeNull();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alerted()).toEqual([couldntAdd(definitionId)]);
    // The reason still goes to the Agent log, under GM's line.
    expect(logged()[0]).toMatch(/Failed to fetch|Nebula's/);
  });

  it.each(ADDS)('%s: the banner shows offline, so nothing is sent and no toast shows', async (_name, _definitionId, add) => {
    useGraphStore.setState({ nodes: [{ ...agentsNode }] as never });
    noteBackendConnection('offline');
    expect(await add({ x: 10, y: 20 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerted()).toEqual([]);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
  });

  it('a tab that never found a backend while the banner says offline: blocked the same way', async () => {
    backendDiscovery.baseUrl = null;
    noteBackendConnection('offline');
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerted()).toEqual([]);
  });

  it('a dynamic node while offline: no card, no step, no toast', async () => {
    noteBackendConnection('offline');
    expect(useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(alerted()).toEqual([]);
  });
});

// Review 12 (R12-A/B): the add's own read of the backend's graph must never
// overwrite a newer socket sync that landed while that read was out.
const base = { activeProjectId: 'A', workspaceRevision: 'a', paramsVersion: GRAPH_PARAMS_VERSION };
const textNode = (id: string, value: string, position: { x: number; y: number }, outputs = {}) => ({
  id, type: 'model-node', position,
  data: { label: 'Text Input', definitionId: 'text-input', params: { value }, state: Object.keys(outputs).length ? 'complete' : 'idle', outputs } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('a socket sync that lands while the add\'s export is out wins (R12-A/B)', () => {
  it("R12-A: an agent's Clear lands first; the stale export brings nothing back", async () => {
    const exported = deferred<Response>();
    const created = deferred<Response>();
    fetchMock.mockReturnValueOnce(exported.promise).mockReturnValueOnce(created.promise);
    const adding = useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    socketSends({ type: 'graphSync', ...base, empty: true, cleared: true, nodes: [], edges: [] });
    exported.resolve(json({ ...base, empty: false, edges: [],
      nodes: [textNode('n1', 'old', { x: 400, y: 300 }, { text: { type: 'Text', value: 'OLD OUTPUT' } }),
        textNode('n2', 'old two', { x: 400, y: 500 })] }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(useGraphStore.getState().nodes).toEqual([]);
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [textNode('n1', '', { x: 10, y: 20 })] });
    created.resolve(json({ id: 'n1' }));
    expect(await adding).toBe('n1');
    const n1 = useGraphStore.getState().nodes.find((node) => node.id === 'n1')!;
    expect(n1.position).toEqual({ x: 10, y: 20 });
    expect(n1.data.outputs).toEqual({});
  });

  it("R12-B: an agent's delete lands first, then the create is refused; the deleted node stays gone", async () => {
    const exported = deferred<Response>();
    fetchMock.mockReturnValueOnce(exported.promise).mockResolvedValueOnce(json({ detail: 'nope' }, 409));
    const adding = useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [textNode('n1', 'a', { x: 0, y: 0 })] });
    exported.resolve(json({ ...base, empty: false, edges: [],
      nodes: [textNode('n1', 'a', { x: 0, y: 0 }), textNode('n2', 'b', { x: 0, y: 200 })] }));
    expect(await adding).toBeNull();
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
  });

  it('a sync that is not this tab\'s (another project) doesn\'t count: the export still applies', async () => {
    const exported = deferred<Response>();
    fetchMock.mockReturnValueOnce(exported.promise).mockResolvedValueOnce(json({ id: 'n2' }));
    const adding = useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    socketSends({ type: 'graphSync', ...base, workspaceRevision: 'other', empty: true, nodes: [], edges: [] });
    exported.resolve(backendHas());
    expect(await adding).toBe('n2');
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
  });
});

// Review 12 (R12-C): an add's undo step owns only the node it added. On an
// empty tab the add brings the backend's nodes in first; Undo must not take
// those away.
describe('Undo after the first add on an empty tab removes only the new node (R12-C)', () => {
  it('addDynamicNode', async () => {
    fetchMock.mockResolvedValueOnce(backendHas());
    const created = deferred<Response>();
    fetchMock.mockReturnValueOnce(created.promise);
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    created.resolve(json({ id: 'n2' }));
    await vi.waitFor(() => expect(useGraphStore.getState().nodes.some((node) => node.id === 'n2')).toBe(true));
    const made = { id: 'n2', type: 'dynamic-node', position: { x: 10, y: 20 },
      data: { label: 'x', definitionId: 'openrouter-universal', params: {}, state: 'idle', outputs: {} } };
    socketSends({ type: 'graphSync', ...base, empty: false, edges: [], nodes: [agentsNode, made],
      edit: { tab: TAB_ID, actor: { kind: 'person' } } });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    fetchMock.mockResolvedValue(json({}));
    useGraphStore.getState().undo();
    await vi.waitFor(() => expect(paths()).toContain('POST /api/graph/restore'));
    const restore = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/graph/restore'))!;
    const body = JSON.parse(String((restore[1] as RequestInit).body));
    expect(body.remove).toEqual(['n2']);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1']);
  });
});

// Review 12 item 6 (GM: the settling line is fine on other writes as long as
// each leads with its own "Couldn't <action>."): an add refused while a World
// Labs run is still starting.
describe('the World Labs starting line on an add leads with the add\'s own heading', () => {
  it('addNode', async () => {
    useGraphStore.setState({ nodes: [{ ...agentsNode }] as never });
    fetchMock.mockResolvedValueOnce(json({ detail: 'A World Labs run is still starting. Try again in a moment.' }, 409));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toEqual(["Couldn't add “Text Input”. A World Labs run is still starting. Try again in a moment."]);
  });
});
