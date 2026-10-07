import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData, VariantScope } from '../src/types';
import type { RunRecord } from '../src/lib/runHistory';
import type { ExecutionEvent } from '../src/lib/wsClient';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), cancel: vi.fn(), status: vi.fn(),
  subscribe: vi.fn(), fetch: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../src/lib/api', () => ({ executeGraph: boundary.execute, executeNode: boundary.execute,
  generateCinemaShot: vi.fn(), cancelExecution: boundary.cancel, getExecutionStatus: boundary.status,
  acknowledgeProviderStartAmbiguity: vi.fn(), deleteProviderRecovery: vi.fn(),
  promoteCinemaShotVariation: vi.fn(), fetchReplicateSchema: vi.fn(),
  ExecutionStartRejectedError: class extends Error {} }));
vi.mock('../src/lib/backend', () => ({ apiFetch: boundary.apiFetch,
  getCachedBackendBaseUrl: () => 'http://synthetic.invalid',
  rewriteBackendAssetUrls: <T,>(value: T) => value,
  rewriteExecutionAssetUrls: <T,>(value: T) => value }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: boundary.subscribe } }));
vi.mock('../src/lib/jobNotifications', () => ({ notifyJobComplete: vi.fn() }));
vi.mock('../src/store/uiStore', () => ({ useUIStore: { getState: () => ({ settingsCache: { apiKeys: {}, loaded: true } }) } }));

type Store = (typeof import('../src/store/graphStore'))['useGraphStore'];
let store: Store;
let receive: (event: ExecutionEvent) => void;
const output = (text: string) => ({ input: { type: 'Text' as const, value: text } });
const scope = (label: string, index = 0): VariantScope => ({ index, label,
  lineage: [{ source_node_id: 'batch', source_label: 'colors', index, item_label: label }] });
const preview = (id = 'preview', text = 'blue'): Node<NodeData> => ({ id, type: 'model-node',
  position: { x: 0, y: 0 }, data: { label: 'Preview', definitionId: 'preview', params: {},
    state: 'complete', outputs: output(text) } });
function saved(id: string, labels = ['red', 'blue'], nodeId = 'preview'): RunRecord {
  return { id, trigger: 'cluster', startedAt: 1, status: 'complete',
    snapshot: { nodes: [{ id: nodeId, definitionId: 'preview', params: {}, outputs: {} }], edges: [] },
    batchOutputs: { [nodeId]: labels.map(output) },
    batchVariants: { [nodeId]: labels.map((label, index) => scope(label, index)) } };
}
async function boot(records: RunRecord[] = [], nodes = [preview()]) {
  vi.resetModules();
  const { persistRunHistory } = await import('../src/lib/runHistory');
  persistRunHistory(records);
  store = (await import('../src/store/graphStore')).useGraphStore;
  receive = boundary.subscribe.mock.calls.at(-1)![0];
  store.getState().loadGraph(nodes, []);
}
const live = () => store.getState().nodes[0].data;

describe('Batch preview ownership through real graph store paths', () => {
  beforeEach(async () => {
    vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
    boundary.execute.mockResolvedValue({ status: 'started' });
    boundary.cancel.mockResolvedValue({ status: 'cancelled' });
    boundary.status.mockResolvedValue({ status: 'running' });
    boundary.apiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    boundary.fetch.mockRejectedValue(new Error('Unexpected network request'));
    vi.stubGlobal('fetch', boundary.fetch);
    await boot();
  });
  afterEach(() => { store.getState().resetExecution(); vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('retains cumulative items across per-item executing events and freezes history separately', async () => {
    await store.getState().executeClusterConcurrent(['preview']);
    const runId = store.getState().activeRuns[0].id;
    store.getState().handleExecutionEvent({ type: 'queued', nodeId: 'preview', runId });
    store.getState().handleExecutionEvent({ type: 'executed', nodeId: 'preview', runId,
      outputs: output('red'), batchOutputs: [output('red')], batchVariants: [scope('red')] });
    store.getState().handleExecutionEvent({ type: 'executing', nodeId: 'preview', runId, variant: scope('blue', 1) });
    expect(live().batchOutputs).toHaveLength(1);
    const scopes = [scope('red'), scope('blue', 1)];
    store.getState().handleExecutionEvent({ type: 'executed', nodeId: 'preview', runId,
      outputs: output('blue'), batchOutputs: [output('red'), output('blue')], batchVariants: scopes });
    scopes[0].label = 'changed later';
    expect(live().outputs).toEqual(output('blue'));
    expect(live().batchVariants?.[0].label).toBe('red');
    const record = store.getState().runHistory[0];
    expect(record.batchVariants?.preview[0].label).toBe('red');
    expect(Object.isFrozen(record.batchVariants?.preview[0].lineage)).toBe(true);
    store.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    expect(live().batchOutputs).toHaveLength(2);
    expect(store.getState().runHistory[0].status).toBe('cancelled');
    expect(boundary.execute).toHaveBeenCalledTimes(1);
  });

  it('rehydrates only the matching latest saved scalar result and labels after module reload', async () => {
    await boot([saved('new', ['green', 'blue']), saved('old')]);
    expect(live().batchRunId).toBe('new');
    expect(live().batchVariants?.[0].label).toBe('green');
    expect(boundary.execute).not.toHaveBeenCalled();
    await boot([saved('new', ['green', 'purple']), saved('old')]);
    expect(live().batchOutputs).toBeUndefined();
  });

  it('matches equivalent multi-port outputs independently of object key order', async () => {
    const record = saved('multi');
    const last = { input: { type: 'Text' as const, value: 'blue' },
      meta: { type: 'JSON' as const, value: { a: 1, b: 2 } } };
    record.batchOutputs!.preview[1] = last;
    const reversed = { meta: { value: { b: 2, a: 1 }, type: 'JSON' as const },
      input: { value: 'blue', type: 'Text' as const } };
    await boot([record], [{ ...preview('n2'), id: 'preview', data: { ...preview().data, outputs: reversed } }]);
    expect(live().batchRunId).toBe('multi');
    receive({ type: 'graphSync', empty: false, edges: [], nodes: [{ ...preview(),
      data: { ...preview().data, outputs: last } }] });
    expect(live().batchOutputs).toHaveLength(2);
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it('rejects terminal A node events after reload without rewinding B or its gallery', async () => {
    await boot([saved('B', ['green', 'blue']), saved('A')]);
    for (const event of [
      { type: 'queued', runId: 'A', nodeId: 'preview' },
      { type: 'executing', runId: 'A', nodeId: 'preview' },
      { type: 'executed', runId: 'A', nodeId: 'preview', outputs: output('red'),
        batchOutputs: [output('red')], batchVariants: [scope('red')] },
    ] as ExecutionEvent[]) store.getState().handleExecutionEvent(event);
    expect(live().state).toBe('complete'); expect(live().outputs).toEqual(output('blue'));
    expect(live().batchRunId).toBe('B');
  });

  it('preserves matching/empty graph sync, invalidates a changed server output and repairs Batch renderer', async () => {
    await boot([saved('saved', ['red', 'blue'], 'n2')], [preview('n2')]);
    const sync = (outputs: NodeData['outputs']) => receive({ type: 'graphSync', empty: false, edges: [],
      nodes: [{ ...preview('n2'), data: { ...preview('n2').data, outputs } }] });
    sync(output('blue')); expect(live().batchOutputs).toHaveLength(2);
    sync({}); expect(live().batchOutputs).toHaveLength(2);
    sync(output('purple')); expect(live().batchOutputs).toBeUndefined();
    expect(live().outputs).toEqual(output('purple'));
    receive({ type: 'graphSync', empty: false, edges: [], nodes: [{ ...preview('n2'),
      data: { ...preview('n2').data, definitionId: 'batch', params: { items_text: 'red' }, outputs: {} } }] });
    expect(store.getState().nodes[0].type).toBe('batchNode');
  });

  it('undo/redo preserves the newer gallery, rather than restoring one captured with older params', async () => {
    await boot([saved('A')]);
    store.getState().updateNodeData('preview', { params: { draft: 'edited' } });
    store.getState().handleExecutionEvent({ type: 'executed', runId: 'B', nodeId: 'preview',
      outputs: output('purple'), batchOutputs: [output('green'), output('purple')],
      batchVariants: [scope('green'), scope('purple', 1)] });
    store.getState().undo(); expect(live().outputs).toEqual(output('purple'));
    expect(live().batchRunId).toBe('B'); expect(live().batchVariants?.[0].label).toBe('green');
    store.getState().redo(); expect(live().batchRunId).toBe('B');
  });

  it.each(['duplicateNode', 'duplicateSelected', 'pasteClipboard'] as const)('clears %s copies without changing the source gallery', async (action) => {
    await boot([saved('A')], [{ ...preview(), selected: true }]);
    if (action === 'duplicateNode') store.getState().duplicateNode('preview');
    else if (action === 'duplicateSelected') store.getState().duplicateSelected();
    else { store.getState().copySelected(); store.getState().pasteClipboard(); }
    const copy = store.getState().nodes.find((node) => node.id !== 'preview')!;
    expect(copy.data.outputs).toEqual({}); expect(copy.data.batchOutputs).toBeUndefined();
    expect(copy.data.batchVariants).toBeUndefined(); expect(copy.data.batchRunId).toBeUndefined();
    expect(live().batchOutputs).toHaveLength(2); expect(boundary.execute).not.toHaveBeenCalled();
  });

  it('empty and legacy events replace only their owner collections without retaining stale labels', async () => {
    await store.getState().executeClusterConcurrent(['preview']);
    const runId = store.getState().activeRuns[0].id;
    store.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'preview', outputs: output('red'),
      batchOutputs: [output('red')], batchVariants: [scope('red')] });
    store.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'preview', outputs: output('blue'),
      batchOutputs: [output('red'), output('blue')] });
    expect(live().batchVariants).toBeUndefined();
    expect(store.getState().runHistory[0].batchVariants?.preview).toBeUndefined();
    store.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'preview', outputs: {},
      batchOutputs: [], batchVariants: [] });
    expect(live().batchOutputs).toEqual([]); expect(live().batchVariants).toEqual([]);
  });
});
