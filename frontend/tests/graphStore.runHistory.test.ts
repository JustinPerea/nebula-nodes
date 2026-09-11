import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import {
  RUN_HISTORY_STORAGE_KEY,
  WORLD_LABS_CANCELLATION_NOTE,
  WORLD_LABS_RECOVERY_READY_NOTE,
  WORLD_LABS_RECOVERY_VOLATILE_NOTE,
  WORLD_LABS_RECONNECTING_NOTE,
  type RunRecord,
} from '../src/lib/runHistory';

function worldEnvironmentNode(id = 'world') {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    data: {
      label: 'World Labs Environment',
      definitionId: 'worldlabs-environment',
      params: {},
      state: 'idle' as const,
      outputs: {},
    },
  };
}

/**
 * Store-level lifecycle tests for run-history. The pure transforms are covered in
 * runHistory.test.ts; these guard the integration the verifier flagged: a REST
 * validation_error or a thrown error during apiExecute* must CLOSE the open run
 * record as 'failed' (not leave it stuck on 'running'), otherwise the next run's
 * resetExecution would mis-mark the leaked run 'cancelled' and double-count.
 */
describe('graphStore run-history lifecycle', () => {
  beforeEach(() => {
    // Close any leaked run, then start clean.
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({
      nodes: [],
      edges: [],
      runHistory: [],
      isExecuting: false,
      isCancelling: false,
      providerRecoveryWarning: null,
      uncertainWorldLabsRunId: null,
      providerRecoveries: [],
      providerStartAmbiguities: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the run as failed on a REST validation_error (not stuck running)', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'validation_error' } as never);

    await useGraphStore.getState().executeGraph();

    const { runHistory, isExecuting } = useGraphStore.getState();
    expect(runHistory).toHaveLength(1);
    expect(runHistory[0].status).toBe('failed');
    expect(isExecuting).toBe(false);
  });

  it('closes the run as failed when apiExecute throws', async () => {
    vi.spyOn(api, 'executeGraph').mockRejectedValue(new Error('network down'));

    await useGraphStore.getState().executeGraph();

    const { runHistory } = useGraphStore.getState();
    expect(runHistory).toHaveLength(1);
    expect(runHistory[0].status).toBe('failed');
  });

  it('shows the exact backend capability error on a Canvas node run', async () => {
    const message = 'Gemini Omni capability guardrail: use Veo 3.1 for video extension.';
    vi.spyOn(api, 'executeNode').mockResolvedValue({
      status: 'validation_error',
      errors: [{ nodeId: 'omni', portId: 'prompt', message }],
    });
    useGraphStore.setState({
      nodes: [{
        id: 'omni',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'Gemini Omni Flash',
          definitionId: 'gemini-omni-flash',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });

    await useGraphStore.getState().executeNode('omni');

    const omni = useGraphStore.getState().nodes.find((node) => node.id === 'omni');
    expect(omni?.data.state).toBe('error');
    expect(omni?.data.error).toBe(message);
  });

  it('sends the full visible graph when targeting a downstream World Labs node', async () => {
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    const prompt = {
      id: 'prompt',
      type: 'model-node',
      position: { x: 0, y: 0 },
      data: {
        label: 'Text Input',
        definitionId: 'text-input',
        params: { value: 'a quiet garden' },
        state: 'idle' as const,
        outputs: {},
      },
    };
    const world = worldEnvironmentNode('world');
    const edge = {
      id: 'prompt-to-world',
      source: 'prompt',
      sourceHandle: 'text',
      target: 'world',
      targetHandle: 'prompt',
    };
    useGraphStore.setState({ nodes: [prompt, world], edges: [edge] });

    await useGraphStore.getState().executeNode('world');

    expect(execute).toHaveBeenCalledOnce();
    const [nodes, edges, targetNodeId, runId] = execute.mock.calls[0];
    expect(nodes).toEqual([
      expect.objectContaining({ id: 'prompt', params: { value: 'a quiet garden' } }),
      expect.objectContaining({ id: 'world', definitionId: 'worldlabs-environment' }),
    ]);
    expect(edges).toEqual([expect.objectContaining({
      id: 'prompt-to-world',
      source: 'prompt',
      target: 'world',
    })]);
    expect(targetNodeId).toBe('world');
    expect(runId).toEqual(expect.any(String));
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      id: runId,
      targetNodeId: 'world',
      startedFreshPaidWorldLabs: true,
      status: 'running',
    });
  });

  it('a failed run does not get mis-marked cancelled by the NEXT run (invariant)', async () => {
    const spy = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'validation_error' } as never);

    await useGraphStore.getState().executeGraph();
    await useGraphStore.getState().executeGraph();

    const { runHistory } = useGraphStore.getState();
    // Two distinct records, both failed — the first must NOT have flipped to 'cancelled',
    // and there must be no leaked duplicate.
    expect(runHistory).toHaveLength(2);
    expect(runHistory.every((r) => r.status === 'failed')).toBe(true);
    expect(new Set(runHistory.map((r) => r.id)).size).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('resetExecution mid-run marks the open run cancelled', async () => {
    // Keep the REST call pending so the run stays open after executeGraph returns.
    let resolve!: (v: unknown) => void;
    vi.spyOn(api, 'executeGraph').mockReturnValue(new Promise((r) => { resolve = r; }) as never);

    const p = useGraphStore.getState().executeGraph();
    // The run is now open (apiExecuteGraph hasn't resolved).
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    useGraphStore.getState().resetExecution();
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');

    resolve({ status: 'started' });
    await p;
  });

  it('cancelExecution asks the backend before closing the run', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    const cancel = vi.spyOn(api, 'cancelExecution').mockResolvedValue({
      runId: 'placeholder',
      status: 'cancelled',
    });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    await useGraphStore.getState().cancelExecution();

    expect(cancel).toHaveBeenCalledWith(runId);
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');
  });

  it('keeps the run active when backend cancellation fails', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    vi.spyOn(api, 'cancelExecution').mockRejectedValue(new Error('backend unavailable'));

    await useGraphStore.getState().executeGraph();
    await useGraphStore.getState().cancelExecution();

    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');
  });

  it('keeps a paid run locked while backend cancellation is still settling', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    vi.spyOn(api, 'cancelExecution').mockResolvedValue({
      runId: 'placeholder',
      status: 'cancelling',
    });
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    await useGraphStore.getState().cancelExecution();

    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: true,
    });
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    // The global lock must reject a second paid start until a terminal event,
    // even though the DELETE request itself has already returned.
    await useGraphStore.getState().executeGraph();
    expect(execute).toHaveBeenCalledTimes(1);

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
    });
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');
  });

  it('honors Stop requested before a paid start is admitted by the backend', async () => {
    vi.useFakeTimers();
    try {
      let resolveStart!: (result: api.ExecutionStartResult) => void;
      vi.spyOn(api, 'executeGraph').mockReturnValue(
        new Promise<api.ExecutionStartResult>((resolve) => {
          resolveStart = resolve;
        }),
      );
      const status = vi.spyOn(api, 'getExecutionStatus').mockRejectedValue(
        new Error('Execution status unavailable: HTTP 404.'),
      );
      const cancel = vi.spyOn(api, 'cancelExecution')
        .mockRejectedValueOnce(new Error('Execution status unavailable: HTTP 404.'))
        .mockResolvedValueOnce({
          runId: 'placeholder',
          status: 'cancelling',
        });
      useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

      const starting = useGraphStore.getState().executeGraph();
      const runId = useGraphStore.getState().runHistory[0].id;
      await useGraphStore.getState().cancelExecution();

      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith(runId);
      expect(useGraphStore.getState()).toMatchObject({
        isExecuting: true,
        isCancelling: true,
      });

      // The client-owned run can legitimately be absent until the original
      // POST finishes admission. A 404 must not erase the user's Stop intent.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(status).toHaveBeenCalledWith(runId);
      expect(useGraphStore.getState()).toMatchObject({
        isExecuting: true,
        isCancelling: true,
        uncertainWorldLabsRunId: runId,
      });

      resolveStart({ status: 'started', runId });
      await starting;

      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenLastCalledWith(runId);
      expect(useGraphStore.getState()).toMatchObject({
        isExecuting: true,
        isCancelling: true,
        runHistory: [expect.objectContaining({ id: runId, status: 'running' })],
      });

      useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
      expect(useGraphStore.getState()).toMatchObject({
        isExecuting: false,
        isCancelling: false,
        runHistory: [expect.objectContaining({ id: runId, status: 'cancelled' })],
      });
    } finally {
      useGraphStore.getState().resetExecution();
      vi.useRealTimers();
    }
  });

  it('settles a pending start immediately when the backend cancellation tombstone wins', async () => {
    let rejectStart!: (reason?: unknown) => void;
    vi.spyOn(api, 'executeGraph').mockReturnValue(
      new Promise<api.ExecutionStartResult>((_resolve, reject) => {
        rejectStart = reject;
      }),
    );
    const cancel = vi.spyOn(api, 'cancelExecution').mockResolvedValue({
      runId: 'placeholder',
      status: 'cancelled',
    });
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    const starting = useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    await useGraphStore.getState().cancelExecution();

    expect(cancel).toHaveBeenCalledWith(runId);
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      runHistory: [expect.objectContaining({ id: runId, status: 'cancelled' })],
    });

    rejectStart(new api.ExecutionStartRejectedError('Cancelled before admission.', 409));
    await starting;

    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      runHistory: [expect.objectContaining({ id: runId, status: 'cancelled' })],
    });
  });

  it('clears the stopping state when completion wins the cancellation race', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    let resolveCancel!: (result: api.ExecutionCancellationResult) => void;
    vi.spyOn(api, 'cancelExecution').mockReturnValue(
      new Promise<api.ExecutionCancellationResult>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    const cancelling = useGraphStore.getState().cancelExecution();
    expect(useGraphStore.getState().isCancelling).toBe(true);

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId,
      duration: 1,
      nodesExecuted: 1,
    });
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
    });
    expect(useGraphStore.getState().runHistory[0].status).toBe('complete');

    resolveCancel({ runId, status: 'completed' });
    await cancelling;
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
    });
  });

  it('reconciles an ambiguous paid start by run id and keeps the graph locked', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockRejectedValue(new TypeError('Failed to fetch'));
    const status = vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({
      runId: 'placeholder',
      status: 'running',
    });
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    expect(status).toHaveBeenCalledWith(runId);
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: false,
    });
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    await useGraphStore.getState().executeGraph();
    expect(execute).toHaveBeenCalledTimes(1);

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId,
      duration: 1,
      nodesExecuted: 1,
    });
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('keeps an ambiguous paid start locked until the user confirms a Marble check', async () => {
    vi.spyOn(api, 'executeGraph').mockRejectedValue(new TypeError('connection reset'));
    vi.spyOn(api, 'getExecutionStatus').mockRejectedValue(new Error('backend unavailable'));
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');
    expect(useGraphStore.getState().providerRecoveryWarning).toMatch(/remains locked/i);
    expect(useGraphStore.getState().uncertainWorldLabsRunId).toBe(runId);

    useGraphStore.getState().acknowledgeUncertainWorldLabsRun();

    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
      uncertainWorldLabsRunId: null,
      providerRecoveryWarning: null,
    });
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      status: 'failed',
      statusNote: 'Marble checked; the unconfirmed local run lock was manually cleared.',
    });
  });

  it('unlocks a paid run after a definite HTTP start rejection', async () => {
    vi.spyOn(api, 'executeGraph').mockRejectedValue(
      new api.ExecutionStartRejectedError('Already active', 409),
    );
    const status = vi.spyOn(api, 'getExecutionStatus');
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();

    expect(status).not.toHaveBeenCalled();
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
    });
    expect(useGraphStore.getState().runHistory[0].status).toBe('failed');
  });

  it('does not treat an unrelated World Labs node as part of an ambiguous node start', async () => {
    vi.spyOn(api, 'executeNode').mockRejectedValue(new TypeError('Failed to fetch'));
    const status = vi.spyOn(api, 'getExecutionStatus');
    useGraphStore.setState({
      nodes: [
        worldEnvironmentNode('unrelated-world'),
        {
          id: 'ordinary-target',
          type: 'model-node',
          position: { x: 200, y: 0 },
          data: {
            label: 'Text Input',
            definitionId: 'text-input',
            params: { value: 'hello' },
            state: 'idle',
            outputs: {},
          },
        },
      ],
      edges: [],
    });

    await useGraphStore.getState().executeNode('ordinary-target');

    expect(status).not.toHaveBeenCalled();
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0].status).toBe('failed');
  });

  it('does not retain a paid-start lock for a repeat-safe PLY export', async () => {
    vi.spyOn(api, 'executeGraph').mockRejectedValue(new TypeError('Failed to fetch'));
    const status = vi.spyOn(api, 'getExecutionStatus');
    useGraphStore.setState({
      nodes: [{
        id: 'export',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs World Export',
          definitionId: 'worldlabs-world-export',
          params: { format: 'ply' },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });

    await useGraphStore.getState().executeGraph();

    expect(status).not.toHaveBeenCalled();
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0].status).toBe('failed');
  });

  it('reconciles a persisted running World Labs run before permitting another start', async () => {
    const pending: RunRecord = {
      id: 'world-in-flight',
      trigger: 'node',
      startedAt: 1,
      status: 'running',
      statusNote: WORLD_LABS_RECONNECTING_NOTE,
      targetNodeId: 'world',
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {},
        }],
        edges: [],
      },
    };
    const status = vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({
      runId: pending.id,
      status: 'cancelling',
    });
    useGraphStore.setState({
      nodes: [worldEnvironmentNode()],
      edges: [],
      runHistory: [pending],
      isExecuting: false,
      isCancelling: false,
    });

    await useGraphStore.getState().reconcilePersistedWorldLabsRun();

    expect(status).toHaveBeenCalledWith(pending.id);
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: true,
    });

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId: pending.id });
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('does not relock persisted repeat-safe World Labs runs', async () => {
    const safeRuns: RunRecord[] = [
      {
        id: 'safe-ply',
        trigger: 'node',
        startedAt: 1,
        status: 'running',
        startedFreshPaidWorldLabs: false,
        targetNodeId: 'export',
        snapshot: {
          nodes: [{
            id: 'export',
            definitionId: 'worldlabs-world-export',
            params: { format: 'ply' },
            outputs: {},
          }],
          edges: [],
        },
      },
      {
        id: 'safe-recovery',
        trigger: 'node',
        startedAt: 2,
        status: 'running',
        startedFreshPaidWorldLabs: false,
        targetNodeId: 'world',
        snapshot: {
          nodes: [{
            id: 'world',
            definitionId: 'worldlabs-environment',
            params: { resume_operation_id: 'operation-accepted' },
            outputs: {},
          }],
          edges: [],
        },
      },
    ];
    const status = vi.spyOn(api, 'getExecutionStatus');
    useGraphStore.setState({
      runHistory: safeRuns,
      isExecuting: false,
      isCancelling: false,
    });

    await useGraphStore.getState().reconcilePersistedWorldLabsRun();

    expect(status).not.toHaveBeenCalled();
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: false,
      isCancelling: false,
    });
  });

  it('reconciles a fresh-paid run after its snapshot has been recovery-pinned', async () => {
    const pending: RunRecord = {
      id: 'fresh-then-checkpointed',
      trigger: 'node',
      startedAt: 1,
      status: 'running',
      targetNodeId: 'world',
      startedFreshPaidWorldLabs: true,
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: { resume_operation_id: 'operation-accepted' },
          outputs: {},
        }],
        edges: [],
      },
    };
    const status = vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({
      runId: pending.id,
      status: 'running',
    });
    useGraphStore.setState({
      nodes: [worldEnvironmentNode()],
      edges: [],
      runHistory: [pending],
      isExecuting: false,
      isCancelling: false,
    });

    await useGraphStore.getState().reconcilePersistedWorldLabsRun();

    expect(status).toHaveBeenCalledWith(pending.id);
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: false,
    });

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphCancelled',
      runId: pending.id,
    });
  });

  it('refuses destructive graph and history actions while a run owns the lock', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeGraph();
    const locked = useGraphStore.getState();
    const runId = locked.runHistory[0].id;
    const persistedBefore = window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY);

    locked.loadGraph([], []);
    locked.loadSampleGraph();
    locked.clearGraph();
    locked.clearRunHistory();

    expect(useGraphStore.getState()).toMatchObject({
      nodes: [expect.objectContaining({ id: 'world' })],
      isExecuting: true,
      isCancelling: false,
      runHistory: [expect.objectContaining({ id: runId, status: 'running' })],
    });
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBe(persistedBefore);

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
  });

  it('routes a programmatic concurrent World Labs cluster through tracked execution', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({ nodes: [worldEnvironmentNode()], edges: [] });

    await useGraphStore.getState().executeClusterConcurrent(['world']);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState()).toMatchObject({
      isExecuting: true,
      isCancelling: false,
    });
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      trigger: 'cluster',
      status: 'running',
    });

    const runId = useGraphStore.getState().runHistory[0].id;
    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
  });

  it('records World Labs cancellation truth when the DELETE response arrives first', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    vi.spyOn(api, 'cancelExecution').mockResolvedValue({
      runId: 'placeholder',
      status: 'cancelled',
    });
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });

    await useGraphStore.getState().executeGraph();
    await useGraphStore.getState().cancelExecution();

    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      status: 'cancelled',
      statusNote: WORLD_LABS_CANCELLATION_NOTE,
    });
  });

  it('keeps the same World Labs caveat when graphCancelled arrives before DELETE resolves', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    let resolveCancel!: (result: api.ExecutionCancellationResult) => void;
    const cancelResponse = new Promise<api.ExecutionCancellationResult>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelSpy = vi.spyOn(api, 'cancelExecution').mockReturnValue(cancelResponse);
    useGraphStore.setState({
      nodes: [{
        id: 'export',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs World Export',
          definitionId: 'worldlabs-world-export',
          params: { format: 'glb' },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    const cancelling = useGraphStore.getState().cancelExecution();
    expect(cancelSpy).toHaveBeenCalledWith(runId);

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      status: 'cancelled',
      statusNote: WORLD_LABS_CANCELLATION_NOTE,
    });

    resolveCancel({ runId, status: 'cancelled' });
    await cancelling;
    expect(useGraphStore.getState().runHistory[0].statusNote).toBe(WORLD_LABS_CANCELLATION_NOTE);
  });

  it('pins provider recovery ids on the live node before cancellation settles', () => {
    const runId = 'world-run';
    useGraphStore.setState({
      nodes: [{
        id: 'world-uuid',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: { resume_operation_id: 'old-operation' },
          state: 'executing',
          outputs: {},
        },
      }],
      edges: [],
      runHistory: [{
        id: runId,
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: 'world-uuid',
        snapshot: {
          nodes: [{
            id: 'world-uuid',
            definitionId: 'worldlabs-environment',
            params: {},
            outputs: {},
          }],
          edges: [],
        },
      }],
    });

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    useGraphStore.getState().handleExecutionEvent({
      type: 'providerRecovery',
      runId,
      nodeId: 'world-uuid',
      resumeOperationId: null,
      existingWorldId: 'world_accepted_after_stop',
      durable: true,
      warning: null,
    });

    expect(useGraphStore.getState().nodes[0].data.params).toEqual({
      existing_world_id: 'world_accepted_after_stop',
    });
    expect(useGraphStore.getState().runHistory[0].snapshot.nodes[0].params).toEqual({
      existing_world_id: 'world_accepted_after_stop',
    });
    expect(useGraphStore.getState().runHistory[0].statusNote).toBe(WORLD_LABS_RECOVERY_READY_NOTE);
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toContain(
      'world_accepted_after_stop',
    );
  });

  it('keeps recovery-ready copy when the provider ID arrives before graph cancellation', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({
      nodes: [{
        id: 'world-race',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'executing',
          outputs: {},
        },
      }],
      edges: [],
    });

    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;

    useGraphStore.getState().handleExecutionEvent({
      type: 'providerRecovery',
      runId,
      nodeId: 'world-race',
      resumeOperationId: 'operation_race',
      existingWorldId: null,
      durable: true,
      warning: null,
    });
    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });

    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      status: 'cancelled',
      statusNote: WORLD_LABS_RECOVERY_READY_NOTE,
    });
  });

  it('replaces stale provider recovery params with the one accepted checkpoint', () => {
    useGraphStore.setState({
      nodes: [{
        id: 'export-uuid',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs World Export',
          definitionId: 'worldlabs-world-export',
          params: {
            resume_operation_id: 'operation_old',
            existing_world_id: 'world_old',
            format: 'glb',
          },
          state: 'idle',
          outputs: {},
        },
      }],
      edges: [],
    });

    useGraphStore.getState().handleExecutionEvent({
      type: 'providerRecovery',
      nodeId: 'export-uuid',
      resumeOperationId: 'operation_new',
      existingWorldId: null,
      durable: true,
      warning: null,
    });

    expect(useGraphStore.getState().nodes[0].data.params).toEqual({
      format: 'glb',
      resume_operation_id: 'operation_new',
    });
  });

  it('keeps a live recovery pin and warns prominently when its backend journal write fails', () => {
    useGraphStore.setState({
      nodes: [{
        id: 'world-volatile',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'executing',
          outputs: {},
        },
      }],
      edges: [],
      runHistory: [{
        id: 'volatile-run',
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: 'world-volatile',
        snapshot: {
          nodes: [{
            id: 'world-volatile',
            definitionId: 'worldlabs-environment',
            params: {},
            outputs: {},
          }],
          edges: [],
        },
      }],
    });

    useGraphStore.getState().handleExecutionEvent({
      type: 'providerRecovery',
      runId: 'volatile-run',
      nodeId: 'world-volatile',
      resumeOperationId: 'operation_keep_this_tab_open',
      existingWorldId: null,
      durable: false,
      warning: null,
    });

    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({
      resume_operation_id: 'operation_keep_this_tab_open',
    });
    expect(useGraphStore.getState().runHistory[0].statusNote)
      .toBe(WORLD_LABS_RECOVERY_VOLATILE_NOTE);
    expect(useGraphStore.getState().providerRecoveryWarning)
      .toBe(WORLD_LABS_RECOVERY_VOLATILE_NOTE);

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphCancelled',
      runId: 'volatile-run',
    });
    expect(useGraphStore.getState().runHistory[0].statusNote)
      .toBe(WORLD_LABS_RECOVERY_VOLATILE_NOTE);
  });

  it('hydrates recovery into an empty-canvas reload once and does not repersist an unchanged checkpoint', () => {
    useGraphStore.setState({
      nodes: [],
      edges: [],
      runHistory: [{
        id: 'reload-run',
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: 'world-from-history',
        snapshot: {
          nodes: [{
            id: 'world-from-history',
            definitionId: 'worldlabs-environment',
            params: {},
            outputs: {},
          }],
          edges: [],
        },
      }],
    });
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const checkpoint = {
      runId: 'reload-run',
      nodeId: 'world-from-history',
      resumeOperationId: null,
      existingWorldId: 'world_saved',
    };

    useGraphStore.getState().hydrateProviderRecoveries([checkpoint]);
    const firstHistory = useGraphStore.getState().runHistory;
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(firstHistory[0].snapshot.nodes[0].params).toEqual({ existing_world_id: 'world_saved' });
    expect(firstHistory[0].statusNote).toBe(WORLD_LABS_RECOVERY_READY_NOTE);
    expect(persist).toHaveBeenCalledTimes(1);

    useGraphStore.getState().hydrateProviderRecoveries([checkpoint]);
    expect(useGraphStore.getState().runHistory).toBe(firstHistory);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('protects recovery history and safely re-locks on a delayed checkpoint snapshot', async () => {
    const checkpoint = {
      runId: 'recoverable-run',
      nodeId: 'world-recoverable',
      resumeOperationId: 'operation-saved',
      existingWorldId: null,
      durable: true,
    };
    useGraphStore.setState({
      nodes: [worldEnvironmentNode('world-recoverable')],
      edges: [],
      runHistory: [{
        id: checkpoint.runId,
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: checkpoint.nodeId,
        startedFreshPaidWorldLabs: true,
        snapshot: {
          nodes: [{
            id: checkpoint.nodeId,
            definitionId: 'worldlabs-environment',
            params: {},
            outputs: {},
          }],
          edges: [],
        },
      }],
    });
    useGraphStore.getState().hydrateProviderRecoveries([checkpoint]);
    const persistedBefore = window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY);
    expect(useGraphStore.getState().runHistory[0].snapshot.nodes[0].params).toEqual({
      resume_operation_id: checkpoint.resumeOperationId,
    });

    useGraphStore.getState().clearRunHistory();
    useGraphStore.getState().clearGraph();
    expect(useGraphStore.getState()).toMatchObject({
      nodes: [expect.objectContaining({ id: checkpoint.nodeId })],
      providerRecoveries: [expect.objectContaining(checkpoint)],
      runHistory: [expect.objectContaining({ id: checkpoint.runId })],
    });
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBe(persistedBefore);

    const remove = vi.spyOn(api, 'deleteProviderRecovery').mockResolvedValue(undefined);
    await useGraphStore.getState().deleteProviderRecovery(checkpoint.runId, checkpoint.nodeId);

    expect(remove).toHaveBeenCalledWith(checkpoint.runId, checkpoint.nodeId, checkpoint);
    expect(useGraphStore.getState().providerRecoveries).toEqual([]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({});
    expect(useGraphStore.getState().runHistory[0].snapshot.nodes[0].params).toEqual({});

    // A delayed REST/WS snapshot may predate the DELETE response. Without an
    // unbounded client tombstone, the safe outcome is an over-lock rather than
    // risking suppression of a legitimate future checkpoint that reused IDs.
    useGraphStore.getState().hydrateProviderRecoveries([checkpoint]);
    expect(useGraphStore.getState().providerRecoveries).toEqual([
      expect.objectContaining(checkpoint),
    ]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({
      resume_operation_id: checkpoint.resumeOperationId,
    });

    useGraphStore.getState().clearRunHistory();
    expect(useGraphStore.getState().runHistory).toEqual([
      expect.objectContaining({ id: checkpoint.runId }),
    ]);
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).not.toBeNull();
  });

  it('protects an idle recovered node from structural delete, undo, and redo', () => {
    const protectedNode = {
      ...worldEnvironmentNode('world-protected'),
      selected: true,
    };
    const guardedSnapshot = { nodes: [], edges: [] };
    const checkpoint = {
      runId: 'recoverable-run',
      nodeId: protectedNode.id,
      resumeOperationId: 'operation-saved',
      existingWorldId: null,
      durable: true,
    };
    useGraphStore.setState({
      nodes: [protectedNode],
      edges: [],
      undoStack: [guardedSnapshot],
      redoStack: [guardedSnapshot],
      providerRecoveries: [checkpoint],
      isExecuting: false,
    });

    useGraphStore.getState().deleteNode(protectedNode.id);
    useGraphStore.getState().onNodesChange([{ id: protectedNode.id, type: 'remove' }]);
    useGraphStore.getState().deleteSelected();
    useGraphStore.getState().deleteGeneration([protectedNode.id]);
    useGraphStore.getState().undo();
    useGraphStore.getState().redo();

    expect(useGraphStore.getState()).toMatchObject({
      nodes: [expect.objectContaining({ id: protectedNode.id })],
      undoStack: [guardedSnapshot],
      redoStack: [guardedSnapshot],
      providerRecoveries: [expect.objectContaining(checkpoint)],
      isExecuting: false,
    });
  });

  it('acknowledges only the ambiguity while retaining a captured volatile recovery ID', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const checkpoint = {
      runId: 'ambiguous-run',
      nodeId: 'world-ambiguous',
      resumeOperationId: 'operation-captured-in-tab',
      existingWorldId: null,
      durable: false,
      warning: 'Keep this tab open.',
    };
    const ambiguity = {
      runId: checkpoint.runId,
      nodeId: checkpoint.nodeId,
      kind: 'worldlabs-environment' as const,
      message: 'The paid start may have been accepted.',
      durable: false,
    };
    const source = worldEnvironmentNode(checkpoint.nodeId);
    source.data.params = { resume_operation_id: checkpoint.resumeOperationId };
    useGraphStore.setState({
      nodes: [source],
      edges: [],
      runHistory: [{
        id: checkpoint.runId,
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: checkpoint.nodeId,
        snapshot: {
          nodes: [{
            id: checkpoint.nodeId,
            definitionId: 'worldlabs-environment',
            params: { resume_operation_id: checkpoint.resumeOperationId },
            outputs: {},
          }],
          edges: [],
        },
      }],
      providerRecoveries: [checkpoint],
      providerStartAmbiguities: [ambiguity],
      providerRecoveryWarning: checkpoint.warning,
    });
    const acknowledge = vi.spyOn(api, 'acknowledgeProviderStartAmbiguity')
      .mockResolvedValue(undefined);

    await useGraphStore.getState().acknowledgeProviderStartAmbiguity(
      ambiguity.kind,
      ambiguity.nodeId,
    );

    expect(acknowledge).toHaveBeenCalledWith(
      ambiguity.kind,
      ambiguity.nodeId,
      ambiguity.runId,
    );
    expect(useGraphStore.getState()).toMatchObject({
      providerStartAmbiguities: [],
      providerRecoveries: [expect.objectContaining(checkpoint)],
      providerRecoveryWarning: checkpoint.warning,
      nodes: [expect.objectContaining({
        id: checkpoint.nodeId,
        data: expect.objectContaining({
          params: { resume_operation_id: checkpoint.resumeOperationId },
        }),
      })],
      runHistory: [expect.objectContaining({
        id: checkpoint.runId,
        snapshot: expect.objectContaining({
          nodes: [expect.objectContaining({
            id: checkpoint.nodeId,
            params: { resume_operation_id: checkpoint.resumeOperationId },
          })],
        }),
      })],
    });

    useGraphStore.getState().duplicateNode(checkpoint.nodeId);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().nodes[1].data.params).toEqual({
      resume_operation_id: checkpoint.resumeOperationId,
    });

    // A delayed pre-ACK snapshot safely restores an over-lock. This avoids an
    // unbounded tombstone that could suppress a legitimate reused run ID.
    useGraphStore.getState().hydrateProviderStartAmbiguities([ambiguity]);
    expect(useGraphStore.getState().providerStartAmbiguities).toEqual([
      expect.objectContaining(ambiguity),
    ]);
    useGraphStore.getState().duplicateNode(checkpoint.nodeId);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('overlays a recovery checkpoint onto the live node and a stale clipboard clone', () => {
    const source = {
      ...worldEnvironmentNode('world-source'),
      selected: true,
    };
    useGraphStore.setState({ nodes: [source], edges: [] });
    useGraphStore.getState().copySelected();

    useGraphStore.getState().hydrateProviderRecoveries([{
      runId: 'paid-run',
      nodeId: source.id,
      resumeOperationId: 'operation-accepted',
      existingWorldId: null,
      durable: true,
    }]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({
      resume_operation_id: 'operation-accepted',
    });

    useGraphStore.getState().pasteClipboard();

    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().nodes.map((node) => node.data.params)).toEqual([
      { resume_operation_id: 'operation-accepted' },
      { resume_operation_id: 'operation-accepted' },
    ]);
  });

  it('uses the authoritative recovery checkpoint for both duplicate actions', () => {
    const source = {
      ...worldEnvironmentNode('world-source'),
      selected: true,
    };
    useGraphStore.setState({
      nodes: [source],
      edges: [],
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: source.id,
        resumeOperationId: null,
        existingWorldId: 'world-accepted',
        durable: true,
      }],
    });

    useGraphStore.getState().duplicateSelected();
    useGraphStore.getState().duplicateNode(source.id);

    expect(useGraphStore.getState().nodes).toHaveLength(3);
    expect(useGraphStore.getState().nodes.slice(1).map((node) => node.data.params)).toEqual([
      { existing_world_id: 'world-accepted' },
      { existing_world_id: 'world-accepted' },
    ]);
  });

  it('blocks stale clones for an ambiguous paid-start source with no safe ID', () => {
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const source = {
      ...worldEnvironmentNode('world-source'),
      selected: true,
    };
    useGraphStore.setState({ nodes: [source], edges: [] });
    useGraphStore.getState().copySelected();
    useGraphStore.setState({
      providerStartAmbiguities: [{
        runId: 'paid-run',
        nodeId: source.id,
        kind: 'worldlabs-environment',
        message: 'The paid start may have been accepted.',
        durable: true,
      }],
    });

    useGraphStore.getState().pasteClipboard();
    useGraphStore.getState().duplicateSelected();
    useGraphStore.getState().duplicateNode(source.id);

    expect(useGraphStore.getState().nodes).toEqual([source]);
  });

  it('blocks cloning a blank fresh-paid World node even when this stale tab has no checkpoint', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const source = {
      ...worldEnvironmentNode('world-stale-source'),
      selected: true,
    };
    useGraphStore.setState({ nodes: [source], edges: [] });
    useGraphStore.getState().copySelected();

    useGraphStore.getState().pasteClipboard();
    useGraphStore.getState().duplicateSelected();
    useGraphStore.getState().duplicateNode(source.id);

    expect(useGraphStore.getState().nodes).toEqual([source]);
    expect(alert).toHaveBeenCalledTimes(3);
    expect(alert.mock.calls[0][0]).toContain('separate paid operation');
  });

  it('does not clear a checkpoint that advances while exact deletion is in flight', async () => {
    const operation = {
      runId: 'paid-run',
      nodeId: 'world-node',
      resumeOperationId: 'operation-accepted',
      existingWorldId: null,
      durable: true,
    };
    const world = {
      ...operation,
      resumeOperationId: null,
      existingWorldId: 'world-finished',
    };
    useGraphStore.setState({
      nodes: [worldEnvironmentNode(operation.nodeId)],
      edges: [],
      providerRecoveries: [operation],
    });
    useGraphStore.getState().hydrateProviderRecoveries([operation]);
    let finishDelete!: () => void;
    vi.spyOn(api, 'deleteProviderRecovery').mockImplementation(() => (
      new Promise<void>((resolve) => { finishDelete = resolve; })
    ));

    const pending = useGraphStore.getState().deleteProviderRecovery(
      operation.runId,
      operation.nodeId,
    );
    useGraphStore.getState().hydrateProviderRecoveries([world]);
    finishDelete();
    await pending;

    expect(useGraphStore.getState().providerRecoveries).toEqual([
      expect.objectContaining(world),
    ]);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({
      existing_world_id: world.existingWorldId,
    });
  });

  it('allows a clone that already carries an exact recovery ID', () => {
    const source = worldEnvironmentNode('world-source');
    source.data.params = { resume_operation_id: 'operation-already-present' };
    useGraphStore.setState({ nodes: [source], edges: [] });

    useGraphStore.getState().duplicateNode(source.id);

    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().nodes[1].data.params).toEqual({
      resume_operation_id: 'operation-already-present',
    });
  });

  it('replays a journal-hydrated snapshot with only its accepted World ID', async () => {
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({
      nodes: [],
      edges: [],
      runHistory: [{
        id: 'journal-replay-run',
        trigger: 'node',
        startedAt: 1,
        status: 'cancelled',
        targetNodeId: 'world-journal-replay',
        snapshot: {
          nodes: [{
            id: 'world-journal-replay',
            definitionId: 'worldlabs-environment',
            params: {},
            outputs: {},
          }],
          edges: [],
        },
      }],
    });
    useGraphStore.getState().hydrateProviderRecoveries([{
      runId: 'journal-replay-run',
      nodeId: 'world-journal-replay',
      resumeOperationId: null,
      existingWorldId: 'world_already_accepted',
    }]);

    await useGraphStore.getState().rerunHistoryRecord('journal-replay-run');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual([expect.objectContaining({
      id: 'world-journal-replay',
      params: { existing_world_id: 'world_already_accepted' },
    })]);
  });

  it('graphCancelled closes the matching run and ignores its late events', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({
      nodes: [{
        id: 'n1',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: { label: 'Node', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} },
      }],
      edges: [],
    });
    await useGraphStore.getState().executeGraph();
    const runId = execute.mock.calls[0][2] as string;

    useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');
    expect(useGraphStore.getState().isExecuting).toBe(false);

    useGraphStore.getState().handleExecutionEvent({
      type: 'executed',
      runId,
      nodeId: 'n1',
      outputs: { text: { type: 'Text', value: 'too late' } },
    });
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId,
      duration: 1,
      nodesExecuted: 1,
    });
    const node = useGraphStore.getState().nodes[0];
    expect(node.data.state).toBe('idle');
    expect(node.data.outputs).toEqual({});
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');
  });

  it('ignores a stale scoped completion after reset and a newer run starts', async () => {
    const spy = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);

    await useGraphStore.getState().executeGraph();
    const firstRunId = spy.mock.calls[0][2] as string;
    useGraphStore.getState().resetExecution();
    await useGraphStore.getState().executeGraph();
    const secondRunId = spy.mock.calls[1][2] as string;

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: firstRunId,
      duration: 1,
      nodesExecuted: 0,
    });

    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0]?.id).toBe(secondRunId);
    expect(useGraphStore.getState().runHistory[0]?.status).toBe('running');
  });

  it('reruns a single-node record with its frozen graph and exact original target', async () => {
    const spy = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    useGraphStore.setState({
      nodes: [
        {
          id: 'source',
          type: 'model-node',
          position: { x: 0, y: 0 },
          data: {
            label: 'Source',
            definitionId: 'text-input',
            params: { value: 'original' },
            state: 'idle',
            outputs: {},
          },
        },
        {
          id: 'target',
          type: 'model-node',
          position: { x: 100, y: 0 },
          data: {
            label: 'Target',
            definitionId: 'preview',
            params: { mode: 'saved' },
            state: 'idle',
            outputs: {},
          },
        },
      ],
      edges: [{
        id: 'source-to-target',
        source: 'source',
        sourceHandle: 'text',
        target: 'target',
        targetHandle: 'input',
      }],
    });

    await useGraphStore.getState().executeNode('target');
    const sourceRunId = spy.mock.calls[0][3] as string;
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: sourceRunId,
      duration: 1,
      nodesExecuted: 2,
    });

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((node) => ({
        ...node,
        data: { ...node.data, params: { changedAfterRun: true } },
      })),
      edges: [],
    });

    await useGraphStore.getState().rerunHistoryRecord(sourceRunId);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toEqual([
      expect.objectContaining({ id: 'source', params: { value: 'original' } }),
      expect.objectContaining({ id: 'target', params: { mode: 'saved' } }),
    ]);
    expect(spy.mock.calls[1][1]).toEqual([
      expect.objectContaining({ id: 'source-to-target', source: 'source', target: 'target' }),
    ]);
    expect(spy.mock.calls[1][2]).toBe('target');
    const rerunId = spy.mock.calls[1][3] as string;
    expect(rerunId).not.toBe(sourceRunId);

    const rerun = useGraphStore.getState().runHistory[0];
    expect(rerun).toMatchObject({
      id: rerunId,
      sourceRunId,
      replayAction: 'rerun',
      targetNodeId: 'target',
      status: 'running',
    });

    // A repeated completion for the source run cannot close the new rerun.
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: sourceRunId,
      duration: 2,
      nodesExecuted: 2,
    });
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: rerunId,
      duration: 2,
      nodesExecuted: 2,
    });
  });

  it('retries failed runs with a new isolated run id', async () => {
    const spy = vi.spyOn(api, 'executeGraph')
      .mockResolvedValueOnce({ status: 'validation_error' } as never)
      .mockResolvedValueOnce({ status: 'started' } as never);

    await useGraphStore.getState().executeGraph();
    const failedRunId = spy.mock.calls[0][2] as string;
    expect(useGraphStore.getState().runHistory[0].status).toBe('failed');

    await useGraphStore.getState().retryFailedRun(failedRunId);

    expect(spy).toHaveBeenCalledTimes(2);
    const retryRunId = spy.mock.calls[1][2] as string;
    expect(retryRunId).not.toBe(failedRunId);
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      id: retryRunId,
      sourceRunId: failedRunId,
      replayAction: 'retry-failed',
      status: 'running',
    });
  });

  it('does not use the retry-failed action for a successful record', async () => {
    const spy = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);

    await useGraphStore.getState().executeGraph();
    const runId = spy.mock.calls[0][2] as string;
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId,
      duration: 0.1,
      nodesExecuted: 0,
    });

    await useGraphStore.getState().retryFailedRun(runId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().runHistory).toHaveLength(1);
  });

  it('retries a failed PLY-only export without treating it as a paid start', async () => {
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    const source: RunRecord = {
      id: 'ply-failed',
      trigger: 'node',
      startedAt: 1,
      status: 'failed',
      targetNodeId: 'export',
      snapshot: {
        nodes: [{
          id: 'export',
          definitionId: 'worldlabs-world-export',
          params: { format: 'ply', resolution: '500k' },
          outputs: {},
        }],
        edges: [],
      },
    };
    useGraphStore.setState({ runHistory: [source], isExecuting: false });

    await useGraphStore.getState().retryFailedRun(source.id);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual([expect.objectContaining({
      id: 'export',
      params: { format: 'ply', resolution: '500k' },
    })]);
    expect(execute.mock.calls[0][2]).toBe('export');
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      sourceRunId: source.id,
      replayAction: 'retry-failed',
      startedFreshPaidWorldLabs: false,
      status: 'running',
    });

    const retryRunId = useGraphStore.getState().runHistory[0].id;
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: retryRunId,
      duration: 1,
      nodesExecuted: 1,
    });
  });

  it('reruns recovered environment plus PLY without a second paid operation', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    const source: RunRecord = {
      id: 'recovered-with-ply',
      trigger: 'graph',
      startedAt: 1,
      status: 'cancelled',
      snapshot: {
        nodes: [
          {
            id: 'environment',
            definitionId: 'worldlabs-environment',
            params: { existing_world_id: 'world-accepted' },
            outputs: {},
          },
          {
            id: 'export',
            definitionId: 'worldlabs-world-export',
            params: { format: 'ply' },
            outputs: {},
          },
        ],
        edges: [{
          id: 'world-to-export',
          source: 'environment',
          sourceHandle: 'world',
          target: 'export',
          targetHandle: 'world',
        }],
      },
    };
    useGraphStore.setState({ runHistory: [source], isExecuting: false });

    await useGraphStore.getState().rerunHistoryRecord(source.id);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual(source.snapshot.nodes);
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({
      sourceRunId: source.id,
      replayAction: 'rerun',
      startedFreshPaidWorldLabs: false,
      status: 'running',
    });

    const rerunId = useGraphStore.getState().runHistory[0].id;
    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: rerunId,
      duration: 1,
      nodesExecuted: 2,
    });
  });

  it('refuses store-level replay of failed or cancelled World Labs snapshots', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    const base: RunRecord = {
      id: 'world-failed',
      trigger: 'graph',
      startedAt: 1,
      status: 'failed',
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {},
        }],
        edges: [],
      },
    };
    useGraphStore.setState({
      runHistory: [base, { ...base, id: 'world-cancelled', status: 'cancelled' }],
      isExecuting: false,
    });

    await useGraphStore.getState().retryFailedRun('world-failed');
    await useGraphStore.getState().rerunHistoryRecord('world-failed');
    await useGraphStore.getState().rerunHistoryRecord('world-cancelled');

    expect(execute).not.toHaveBeenCalled();
    expect(useGraphStore.getState().runHistory).toHaveLength(2);
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('clearRunHistory removes both store and persisted history', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'validation_error' } as never);
    await useGraphStore.getState().executeGraph();
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).not.toBeNull();

    useGraphStore.getState().clearRunHistory();

    expect(useGraphStore.getState().runHistory).toEqual([]);
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });
});
