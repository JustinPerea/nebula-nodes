import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { setProjectContext } from '../src/lib/projectContext';
import { remapSnapshotIds } from '../src/store/projectFlows';
import {
  RUN_HISTORY_STORAGE_KEY, loadRunHistory, recordNodeLanded, type RunRecord,
} from '../src/lib/runHistory';

/**
 * Round 22 of PR #199, 2b.5 (review 20 RV NIT-2), the tab's side: the tab's
 * run record carries `nodeLandedAt` ({nodeId: epoch ms}), when each node's
 * result (its output, its skip or its failure) landed in this tab for the
 * tab's own run. Nebula compares that, not the run's start plus its length.
 * A renumber moves the keys with the node.
 *
 * And 2a: a run this tab started on this project that is still going makes
 * its World Labs record this project's even when the history no longer has it.
 */

const running = (id: string, nodeIds = ['n1', 'n2']): RunRecord => ({
  id, trigger: 'graph', status: 'running', startedAt: 1,
  snapshot: { nodes: nodeIds.map((nodeId) => ({ id: nodeId, definitionId: 'text-input', params: {}, outputs: {} })), edges: [] },
});
const textNode = (id: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } });
const landed = (runId: string) => useGraphStore.getState().runHistory.find((record) => record.id === runId)?.nodeLandedAt;

describe('recordNodeLanded', () => {
  it('stamps the node on its running record; the latest landing wins; frozen', () => {
    let history = recordNodeLanded([running('r1')], 'r1', 'n1', 1_000);
    history = recordNodeLanded(history, 'r1', 'n2', 2_000);
    history = recordNodeLanded(history, 'r1', 'n1', 3_000);
    expect(history[0].nodeLandedAt).toEqual({ n1: 3_000, n2: 2_000 });
    expect(Object.isFrozen(history[0].nodeLandedAt)).toBe(true);
  });

  it('leaves the history as it was for another run, a node outside the run, a closed record or a bad time', () => {
    const history = [running('r1'), { ...running('r2'), status: 'complete' as const }];
    expect(recordNodeLanded(history, 'r3', 'n1', 1)).toBe(history);
    expect(recordNodeLanded(history, 'r1', 'n9', 1)).toBe(history);
    expect(recordNodeLanded(history, 'r2', 'n1', 1)).toBe(history);
    for (const at of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(recordNodeLanded(history, 'r1', 'n1', at)).toBe(history);
  });

  it('a stored record keeps its stamps through a reload; a malformed stamp goes, never the record', () => {
    const records = [{ ...running('r1'), status: 'complete', nodeLandedAt: { n1: 5_000, n2: 'soon', n3: -4, n4: 7_000 } },
      { ...running('r2'), status: 'complete', nodeLandedAt: 'yesterday' }];
    const payload = JSON.stringify({ version: 1, records });
    const loaded = loadRunHistory({ getItem: () => payload, setItem: () => {}, removeItem: () => {} });
    expect(loaded.map((record) => record.id)).toEqual(['r1', 'r2']);
    expect(loaded[0].nodeLandedAt).toEqual({ n1: 5_000, n4: 7_000 });
    expect(loaded[1].nodeLandedAt).toBeUndefined();
  });

  it('a renumber moves the stamps with the node (remapSnapshotIds)', () => {
    const snapshot = { nodes: [], edges: [], runHistory: [{ ...running('r1', ['local-a']), nodeLandedAt: { 'local-a': 9_000 } }] };
    const moved = remapSnapshotIds(snapshot as never, { 'local-a': 'n4' });
    expect((moved.runHistory as RunRecord[])[0].nodeLandedAt).toEqual({ n4: 9_000 });
  });
});

describe('the tab stamps where its own run’s results land', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    setProjectContext(null);
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2'), textNode('n3')], edges: [], runHistory: [],
      isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); setProjectContext(null); });

  it('an output, a skip and a failure each stamp their node at the time it landed', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeGraph();
    const runId = execute.mock.calls[0][2] as string;
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(11_000);
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'n1',
      outputs: { text: { type: 'Text', value: 'a' } } } as never);
    now.mockReturnValue(12_000);
    useGraphStore.getState().handleExecutionEvent({ type: 'skipped', runId, nodeId: 'n2', reason: 'gate' } as never);
    now.mockReturnValue(13_000);
    useGraphStore.getState().handleExecutionEvent({ type: 'error', runId, nodeId: 'n3', error: 'boom' } as never);
    expect(landed(runId)).toEqual({ n1: 11_000, n2: 12_000, n3: 13_000 });
  });

  it('another tab’s or an agent’s run stamps nothing on this tab’s record', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeGraph();
    const runId = execute.mock.calls[0][2] as string;
    useGraphStore.setState((state) => ({ runHistory: [...state.runHistory, running('foreign', ['n1', 'n2', 'n3'])] }));
    for (const event of [{ type: 'executed', outputs: { text: { type: 'Text', value: 'x' } }, nodeId: 'n1' },
      { type: 'skipped', reason: 'gate', nodeId: 'n2' }, { type: 'error', error: 'boom', nodeId: 'n3' }]) {
      useGraphStore.getState().handleExecutionEvent({ ...event, runId: 'foreign' } as never);
    }
    expect(landed('foreign')).toBeUndefined();
    expect(landed(runId)).toBeUndefined();
  });

  it('…with no run of this tab going either (nothing drops the events first)', () => {
    useGraphStore.setState({ runHistory: [running('foreign', ['n1', 'n2', 'n3'])] });
    for (const event of [{ type: 'executed', outputs: { text: { type: 'Text', value: 'x' } }, nodeId: 'n1' },
      { type: 'skipped', reason: 'gate', nodeId: 'n2' }, { type: 'error', error: 'boom', nodeId: 'n3' }]) {
      useGraphStore.getState().handleExecutionEvent({ ...event, runId: 'foreign' } as never);
    }
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n3')?.data.state).toBe('error');
    expect(landed('foreign')).toBeUndefined();
  });
});

describe('a run this tab started here and still owns is this project’s, history or not', () => {
  const world = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'World', definitionId: 'worldlabs-environment', params: { prompt: 'harbor' }, state: 'idle', outputs: {} } };

  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false,
      providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { useGraphStore.getState().resetExecution(); vi.restoreAllMocks(); setProjectContext(null); });

  it('its record holds the node though the history dropped the run; on another project it doesn’t', async () => {
    setProjectContext({ id: 'delta', revision: 'd' });
    useGraphStore.setState({ nodes: [textNode('t1')] });
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeGraph();
    const runId = execute.mock.calls[0][2] as string;
    // The record leaves the history (as a cap or a load would), the run goes on.
    useGraphStore.setState({ nodes: [world], runHistory: [], isExecuting: false,
      providerRecoveries: [{ runId, nodeId: 'n1', resumeOperationId: 'op-live', existingWorldId: null, durable: true }] });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(false);
    setProjectContext({ id: 'alpha', revision: 'a' });
    expect(useGraphStore.getState().allowCanvasDelete(['n1'])).toBe(true);
  });
});
