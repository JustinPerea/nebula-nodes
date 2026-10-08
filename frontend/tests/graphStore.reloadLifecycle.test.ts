import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/lib/runHistory';

const boundary = vi.hoisted(() => ({
  executeGraph: vi.fn(), executeNode: vi.fn(), generateCinemaShot: vi.fn(),
  cancelExecution: vi.fn(), getExecutionStatus: vi.fn(), apiFetch: vi.fn(),
  connect: vi.fn(), subscribe: vi.fn(), notify: vi.fn(), fetch: vi.fn(),
  clearCanvasViewport: vi.fn(), clearCinemaSelectedShots: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  executeGraph: boundary.executeGraph,
  executeNode: boundary.executeNode,
  generateCinemaShot: boundary.generateCinemaShot,
  cancelExecution: boundary.cancelExecution,
  getExecutionStatus: boundary.getExecutionStatus,
  acknowledgeProviderStartAmbiguity: vi.fn(), deleteProviderRecovery: vi.fn(),
  promoteCinemaShotVariation: vi.fn(), fetchReplicateSchema: vi.fn(),
  ExecutionStartRejectedError: class extends Error {},
}));
vi.mock('../src/lib/backend', () => ({
  apiFetch: boundary.apiFetch,
  getCachedBackendBaseUrl: () => 'http://synthetic.invalid',
  rewriteBackendAssetUrls: <T,>(value: T) => value,
  rewriteExecutionAssetUrls: <T,>(value: T) => value,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: boundary.connect, subscribe: boundary.subscribe } }));
vi.mock('../src/lib/jobNotifications', () => ({ notifyJobComplete: boundary.notify }));
vi.mock('../src/store/uiStore', () => ({ useUIStore: { getState: () => ({
  settingsCache: { apiKeys: {}, loaded: true }, canvasFocusRequest: null,
  clearCanvasViewport: boundary.clearCanvasViewport,
  clearCinemaSelectedShots: boundary.clearCinemaSelectedShots,
}) } }));

type Store = (typeof import('../src/store/graphStore'))['useGraphStore'];
let storage: Storage;
let stores: Store[];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() { return values.size; },
  };
}

function createRecord(index = 1): RunRecord {
  const nodeId = `create-node-${index}`;
  return { id: `create-run-${index}`, trigger: 'cluster', status: 'running', startedAt: index,
    startedFreshPaidWorldLabs: false,
    snapshot: { nodes: [{ id: nodeId, definitionId: 'nano-banana', params: { prompt: 'Synthetic saved prompt' }, outputs: {} }], edges: [] },
    createOrigin: { genId: `generation-${index}`, sessionId: 'saved-session', prompt: 'Synthetic saved prompt', ts: index,
      modelNodeIds: [nodeId], allNodeIds: [nodeId] } };
}

function cinemaRecord(): RunRecord {
  return { id: 'cinema-run', trigger: 'shot', status: 'running', startedAt: 3,
    startedFreshPaidWorldLabs: false, targetNodeId: 'cinema-node', cinemaShot: { nodeId: 'cinema-node', shotId: 'shot-a', seed: 7, variations: 3 },
    snapshot: { nodes: [{ id: 'cinema-node', definitionId: 'cinema-scene', params: {
      scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'shot-a', prompt: 'Synthetic saved shot' }] },
    }, outputs: {} }], edges: [] } };
}

async function reloadStore(): Promise<Store> {
  vi.resetModules();
  const { useGraphStore } = await import('../src/store/graphStore');
  stores.push(useGraphStore);
  return useGraphStore;
}

async function boot(records: RunRecord[] = [createRecord(), cinemaRecord()]): Promise<Store> {
  const { persistRunHistory } = await import('../src/lib/runHistory');
  persistRunHistory(records, storage);
  return reloadStore();
}

describe('ordinary execution ownership after browser reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    storage = memoryStorage();
    stores = [];
    vi.stubGlobal('localStorage', storage);
    boundary.fetch.mockRejectedValue(new Error('Unexpected real network request'));
    vi.stubGlobal('fetch', boundary.fetch);
    boundary.apiFetch.mockRejectedValue(new Error('Unexpected raw API request'));
    boundary.getExecutionStatus.mockImplementation(async (runId: string) => ({ runId, status: 'running' }));
    boundary.cancelExecution.mockImplementation(async (runId: string) => ({ runId, status: 'cancelled' }));
  });

  afterEach(() => {
    for (const store of stores) store.getState().resetExecution();
    vi.clearAllTimers();
    expect(boundary.fetch).not.toHaveBeenCalled();
    expect(boundary.apiFetch).not.toHaveBeenCalled();
    expect(boundary.executeGraph).not.toHaveBeenCalled();
    expect(boundary.executeNode).not.toHaveBeenCalled();
    expect(boundary.generateCinemaShot).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reimports both scoped owners with immutable metadata, Create capacity and Stop IDs', async () => {
    const store = await boot();
    expect(store.getState().isExecuting).toBe(true);
    expect(store.getState().activeRuns).toEqual([
      expect.objectContaining({ id: 'create-run-1', nodeIds: ['create-node-1'], kind: 'graph', status: 'uncertain' }),
      expect.objectContaining({ id: 'cinema-run', nodeId: 'cinema-node', shotId: 'shot-a', kind: 'cinema-shot', status: 'uncertain' }),
    ]);
    expect(store.getState().runHistory.every((run) => run.status === 'running')).toBe(true);
    expect(Object.isFrozen(store.getState().runHistory[0].createOrigin?.modelNodeIds)).toBe(true);
    expect(Object.isFrozen(store.getState().runHistory[1].cinemaShot)).toBe(true);
    expect(store.getState().reserveCreateGeneration('new-generation')).toBe(true);
    expect(store.getState().reserveCreateGeneration('over-cap')).toBe(false);
    store.getState().releaseCreateGeneration('new-generation');
    await store.getState().cancelExecution();
    expect(boundary.cancelExecution.mock.calls.map(([runId]) => runId).sort()).toEqual(['cinema-run', 'create-run-1']);
    expect(store.getState().runHistory.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
    expect(store.getState().isExecuting).toBe(false);
  });

  it('retains two active Create slots through module reset and blocks further admission', async () => {
    const store = await boot([createRecord(1), createRecord(2)]);
    expect(store.getState().reserveCreateGeneration('third')).toBe(false);
    const reloaded = await reloadStore();
    expect(reloaded.getState().activeRuns.map((run) => run.id)).toEqual(['create-run-1', 'create-run-2']);
    expect(reloaded.getState().reserveCreateGeneration('third')).toBe(false);
    await reloaded.getState().cancelRun('create-run-1');
    expect(reloaded.getState().reserveCreateGeneration('third')).toBe(true);
  });

  it('queries every restored owner, retains running state and polls without restarting work', async () => {
    const store = await boot();
    await store.getState().reconcilePersistedWorldLabsRun();
    expect(boundary.getExecutionStatus.mock.calls.map(([runId]) => runId).sort()).toEqual(['cinema-run', 'create-run-1']);
    expect(store.getState().activeRuns.every((run) => run.status === 'running')).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(boundary.getExecutionStatus).toHaveBeenCalledTimes(4);
    expect(store.getState().runHistory.every((run) => run.status === 'running')).toBe(true);
  });

  it('restored Cinema ownership blocks duplicate shot submission after graph hydration', async () => {
    const record = cinemaRecord();
    const store = await boot([record]);
    store.getState().loadGraph(record.snapshot.nodes.map((node) => ({
      id: node.id, type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { label: 'Synthetic Cinema', definitionId: node.definitionId, params: node.params, outputs: {}, state: 'idle' },
    })), [], { allowDuringExecution: true });
    expect(boundary.clearCanvasViewport).toHaveBeenCalledOnce();
    expect(boundary.clearCinemaSelectedShots).toHaveBeenCalledOnce();
    await store.getState().executeShot('cinema-node', 'shot-a');
    expect(boundary.generateCinemaShot).not.toHaveBeenCalled();
    expect(store.getState().activeRuns[0].id).toBe('cinema-run');
  });

  it('restores backend cancelling state and settles it only at terminal confirmation', async () => {
    boundary.getExecutionStatus.mockImplementation(async (runId: string) => ({ runId, status: 'cancelling' }));
    const store = await boot([cinemaRecord()]);
    await store.getState().reconcilePersistedWorldLabsRun();
    expect(store.getState().activeRuns[0].status).toBe('cancelling');
    expect(store.getState().isCancelling).toBe(true);
    expect(store.getState().isExecuting).toBe(true);
    boundary.getExecutionStatus.mockImplementation(async (runId: string) => ({ runId, status: 'cancelled' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().runHistory[0].status).toBe('cancelled');
    expect(store.getState().isCancelling).toBe(false);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('settles only the owner confirmed %s and persists its terminal verdict', async (status) => {
    boundary.getExecutionStatus.mockImplementation(async (runId: string) => ({ runId, status: runId === 'create-run-1' ? status : 'running' }));
    const store = await boot();
    await store.getState().reconcilePersistedWorldLabsRun();
    expect(store.getState().runHistory[0].status).toBe(status === 'completed' ? 'complete' : status);
    expect(store.getState().activeRuns.map((run) => run.id)).toEqual(['cinema-run']);
    expect(store.getState().isExecuting).toBe(true);
    const reloaded = await reloadStore();
    expect(reloaded.getState().activeRuns.map((run) => run.id)).toEqual(['cinema-run']);
    expect(reloaded.getState().runHistory[0].status).toBe(status === 'completed' ? 'complete' : status);
  });

  it.each(['missing execution', 'unavailable status'])('keeps an unknown owner locked after %s until a confirmed terminal result', async (message) => {
    boundary.getExecutionStatus.mockRejectedValue(new Error(message));
    const store = await boot();
    await store.getState().reconcilePersistedWorldLabsRun();
    expect(store.getState().activeRuns).toHaveLength(2);
    expect(store.getState().activeRuns.every((run) => run.status === 'uncertain')).toBe(true);
    expect(store.getState().runHistory.every((run) => run.status === 'running')).toBe(true);
    expect(store.getState().isExecuting).toBe(true);
    boundary.getExecutionStatus.mockImplementation(async (runId: string) => ({ runId, status: 'cancelled' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().activeRuns).toEqual([]);
    expect(store.getState().isExecuting).toBe(false);
    expect(store.getState().runHistory.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('retains Stop intent during unavailable status and retries the same restored run ID', async () => {
    boundary.cancelExecution.mockRejectedValueOnce(new Error('Synthetic Stop acknowledgement lost'));
    boundary.getExecutionStatus.mockRejectedValueOnce(new Error('Synthetic status unavailable'));
    const store = await boot([createRecord()]);
    await store.getState().cancelRun('create-run-1');
    expect(store.getState().activeRuns[0].status).toBe('cancelling');
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getState().activeRuns[0].status).toBe('cancelling');
    await vi.advanceTimersByTimeAsync(2000);
    expect(boundary.cancelExecution.mock.calls.map(([runId]) => runId)).toEqual(['create-run-1', 'create-run-1']);
    expect(store.getState().runHistory[0].status).toBe('cancelled');
    expect(store.getState().activeRuns).toEqual([]);
  });
});
