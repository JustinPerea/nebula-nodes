import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';

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
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false });
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

    resolve({ status: 'ok' });
    await p;
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

  it('clearRunHistory removes both store and persisted history', async () => {
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'validation_error' } as never);
    await useGraphStore.getState().executeGraph();
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).not.toBeNull();

    useGraphStore.getState().clearRunHistory();

    expect(useGraphStore.getState().runHistory).toEqual([]);
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });
});
