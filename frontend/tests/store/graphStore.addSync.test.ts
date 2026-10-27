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

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
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
  // apiFetch's own error for an unreachable backend, as it comes.
  ['the backend can\'t be reached', () => fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')),
    /Failed to fetch|Nebula's/],
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
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(alerted()).toEqual([couldntAdd('openrouter-universal')]));
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().undoStack).toEqual([]);
    expect(logged()[0]).toMatch(/Failed to fetch|Nebula's/);
  });

  it('with no backend found at all, the tab still works on its own, as before round 12', async () => {
    backendDiscovery.baseUrl = null;
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const id = await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 });
    expect(id).toBeTruthy();
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual([id]);
    expect(alerted()).toEqual([]);
    // The next add on the tab asks again.
    expect(useGraphStore.getState().backendFreshStartPending).toBe(true);
  });
});

describe('a refused create after the sync: the add path\'s own line, and nothing only in this tab', () => {
  it.each(ADDS)('%s', async (_name, definitionId, add) => {
    fetchMock.mockResolvedValueOnce(json({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(json({ detail: 'Graph has protected provider state' }, 409));
    expect(await add({ x: 10, y: 20 })).toBeNull();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alerted()).toEqual([`Couldn't add ${label(definitionId)}. Graph has protected provider state`]);
  });

  it('a dynamic node is taken off the tab again', async () => {
    fetchMock.mockResolvedValueOnce(json({ empty: true, nodes: [], edges: [] }))
      .mockResolvedValueOnce(json({ detail: 'Graph has protected provider state' }, 409));
    useGraphStore.getState().addDynamicNode('openrouter-universal', { x: 10, y: 20 });
    await vi.waitFor(() => expect(alerted()).toEqual([
      `Couldn't add ${label('openrouter-universal')}. Graph has protected provider state`]));
    expect(useGraphStore.getState().nodes).toEqual([]);
  });
});
