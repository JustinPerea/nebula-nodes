import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * Round 15 of PR #114 (review 14, M1 and M2). Runs are the paid path, so a
 * run is an edit while Nebula is offline: every run entry is refused before
 * anything is marked (no "Queued", no Stop, no request). So are the other
 * writes the store makes outside the canvas edits (Create's cluster, the
 * video edit node, Forget ID, the two unlocks), proposal Accept and Reject,
 * and a false offline (the banner showing while the backend answers) must
 * never start a run. And a start whose answer was lost, for a run the
 * backend doesn't know (404), ends instead of staying on "Stop".
 */

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
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
const { useCanvasProposalsStore } = await import('../../src/store/canvasProposalsStore');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { noteBackendConnection, resetBackendConnectionForTests, subscribeBlockedEdits, isOfflineRefusal } =
  await import('../../src/lib/backendConnection');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const text = (id: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Brief', definitionId: 'text-input', params: { value: 'saved' }, state: 'idle', outputs: {} } });
const sent = () => fetchMock.mock.calls.map(([url, init]) =>
  `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
const record = { id: 'r1', trigger: 'graph', startedAt: 1, finishedAt: 2, status: 'failed',
  snapshot: { nodes: [text('n1')], edges: [] } };

let blocked = 0;
subscribeBlockedEdits(() => { blocked += 1; });

beforeEach(() => {
  fetchMock.mockReset();
  // The backend is up and answers everything (a false offline, too).
  fetchMock.mockImplementation(async () => json({ status: 'started' }));
  alertMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [text('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null, isImportingGraph: false, runHistory: [record] } as never);
  blocked = 0;
});

type Attempt = [string, () => unknown];
const RUNS: Attempt[] = [
  ['executeGraph (bottom Run, Cmd+Enter)', () => useGraphStore.getState().executeGraph()],
  ['executeNode (Run This Node)', () => useGraphStore.getState().executeNode('n1')],
  ['executeCluster (selection Run)', () => useGraphStore.getState().executeCluster(['n1'])],
  ['executeClusterConcurrent (Create)', () => useGraphStore.getState().executeClusterConcurrent(['n1'])],
  ['executeShot', () => useGraphStore.getState().executeShot('n1', 's1')],
  ['rerunHistoryRecord', () => useGraphStore.getState().rerunHistoryRecord('r1')],
  ['rerunHistoryWithLatestPaperSource', () => useGraphStore.getState().rerunHistoryWithLatestPaperSource('r1')],
  ['retryFailedRun', () => useGraphStore.getState().retryFailedRun('r1')],
];
const WRITES: Attempt[] = [
  ['authorGenerationCluster (Create)', () => useGraphStore.getState().authorGenerationCluster({ definitionId: 'nano-banana',
    prompt: 'a', refPaths: [], quantity: 1, params: {}, layoutOrigin: { x: 0, y: 0 }, sessionId: 's', genId: 'g' } as never)],
  ['getOrCreateEditNodeDownstream', () => useGraphStore.getState().getOrCreateEditNodeDownstream('n1')],
  ['deleteProviderRecovery (Forget ID)', () => useGraphStore.getState().deleteProviderRecovery('r1', 'n1')],
  ['acknowledgeProviderStartAmbiguity (unlock)', () => useGraphStore.getState().acknowledgeProviderStartAmbiguity('worldlabs-environment' as never, 'n1')],
  ['acknowledgeUncertainWorldLabsRun (unlock)', () => useGraphStore.getState().acknowledgeUncertainWorldLabsRun()],
];

describe('while offline, every run is refused before it starts', () => {
  it.each(RUNS)('%s: no request, no Queued, no Stop, no toast; the banner pulses', async (_name, attempt) => {
    noteBackendConnection('offline');
    const before = useGraphStore.getState();
    await attempt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = useGraphStore.getState();
    expect(sent()).toEqual([]);
    expect(after.isExecuting).toBe(false);
    expect(after.nodes).toBe(before.nodes);
    expect(after.runHistory).toBe(before.runHistory);
    expect(after.activeRuns).toEqual(before.activeRuns);
    expect(alertMock).not.toHaveBeenCalled();
    expect(after.undoNotice).toBeNull();
    expect(blocked).toBe(1);
  });

  it('a false offline (the backend answers, the banner shows): Run sends nothing and marks nothing', async () => {
    noteBackendConnection('offline');
    await useGraphStore.getState().executeGraph();
    await useGraphStore.getState().executeCluster(['n1']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toEqual([]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().nodes[0].data.state).toBe('idle');
  });

  it('back online, Run starts as before', async () => {
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await useGraphStore.getState().executeGraph();
    expect(sent()).toContain('POST /api/execute');
  });
});

describe('while offline, the store\'s other writes are refused', () => {
  it.each(WRITES)('%s: no request, no change, no toast', async (_name, attempt) => {
    noteBackendConnection('offline');
    const before = useGraphStore.getState();
    let thrown: unknown = null;
    try { await attempt(); } catch (error) { thrown = error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toEqual([]);
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(alertMock).not.toHaveBeenCalled();
    expect(thrown === null || isOfflineRefusal(thrown)).toBe(true);
    expect(blocked).toBe(1);
  });

  it('proposal Accept and Reject send nothing and show no error', async () => {
    useCanvasProposalsStore.getState().open({ id: 'p1', status: 'open', agent: { id: 'a', name: 'Codex', color: '#fff', verified: false },
      note: 'x', createdAt: Date.now(), expiresAt: Date.now() + 600000, nodes: [], edges: [], params: [], run: [] } as never, 'key', {});
    fetchMock.mockClear();
    noteBackendConnection('offline');
    await useCanvasProposalsStore.getState().accept('p1');
    await useCanvasProposalsStore.getState().reject('p1');
    expect(sent()).toEqual([]);
    expect(Object.values(useCanvasProposalsStore.getState().errors ?? {}).filter(Boolean)).toEqual([]);
    expect(blocked).toBeGreaterThanOrEqual(1);
  });
});

describe('a start whose answer was lost, for a run the backend does not know', () => {
  it('ends (not stuck on Stop) when the status check answers 404', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/api/execute')) throw new TypeError('Failed to fetch');
      if (String(url).includes('/api/executions/')) return json({ detail: 'Unknown run' }, 404);
      return json({});
    });
    await useGraphStore.getState().executeGraph();
    await vi.waitFor(() => expect(useGraphStore.getState().isExecuting).toBe(false));
    expect(useGraphStore.getState().uncertainWorldLabsRunId).toBeNull();
  });
});
