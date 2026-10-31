import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A tab not opened from the link runs over the daily total: the backend
 * makes the run a proposal and answers status "waiting" (backend
 * main._propose_waiting_run). Nothing ran, so nothing on the canvas reads
 * as failed: the nodes go back to idle, the run leaves Run history, and the
 * proposal bar shows it (tests/dailyTotal.test.tsx).
 */

const boundary = vi.hoisted(() => ({
  executeGraph: vi.fn(), executeNode: vi.fn(), generateCinemaShot: vi.fn(),
  cancelExecution: vi.fn(), getExecutionStatus: vi.fn(), apiFetch: vi.fn(),
  connect: vi.fn(), subscribe: vi.fn(), notify: vi.fn(),
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
  settingsCache: { apiKeys: {}, loaded: true }, canvasFocusRequest: null, runCostConfirmUsd: null,
  clearCanvasViewport: vi.fn(), clearCinemaSelectedShots: vi.fn(),
}) } }));

const WAITING = { status: 'waiting', proposalId: 'p_wait', runId: 'ignored', message: 'Waiting…' };

describe('a start the daily total holds', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    boundary.apiFetch.mockRejectedValue(new Error('Unexpected raw API request'));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function store() {
    const { useGraphStore } = await import('../src/store/graphStore');
    useGraphStore.getState().loadGraph([{
      id: 'n1', type: 'textInputNode', position: { x: 0, y: 0 },
      data: { label: 'Writer', definitionId: 'text-input', params: { value: 'hi' }, outputs: {}, state: 'idle' },
    }], [], { allowDuringExecution: true });
    return useGraphStore;
  }

  it('leaves the canvas as it was when the whole graph waits', async () => {
    boundary.executeGraph.mockResolvedValue(WAITING);
    const graph = await store();
    await graph.getState().executeGraph();
    expect(boundary.executeGraph).toHaveBeenCalledOnce();
    const node = graph.getState().nodes.find((candidate) => candidate.id === 'n1')!;
    expect(node.data.state).toBe('idle');
    expect((node.data as { error?: unknown }).error).toBeUndefined();
    expect(graph.getState().isExecuting).toBe(false);
    expect(graph.getState().activeRuns).toEqual([]);
    expect(graph.getState().runHistory).toEqual([]);
  });

  it('does the same for one node', async () => {
    boundary.executeNode.mockResolvedValue(WAITING);
    const graph = await store();
    await graph.getState().executeNode('n1');
    expect(boundary.executeNode).toHaveBeenCalledOnce();
    expect(graph.getState().nodes[0].data.state).toBe('idle');
    expect((graph.getState().nodes[0].data as { error?: unknown }).error).toBeUndefined();
    expect(graph.getState().runHistory).toEqual([]);
  });
});
