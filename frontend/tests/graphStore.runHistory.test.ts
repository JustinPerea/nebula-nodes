import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';

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
});
