import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { RUN_HISTORY_STORAGE_KEY, loadRunHistory } from '../src/lib/runHistory';

const node = (id: string, definitionId: string) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: id, definitionId, params: {}, state: 'idle' as const, outputs: {} },
});

/** Gates (backend execution/gating.py): skipped nodes and withheld ports on the canvas. */
describe('graphStore gate events', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({
      nodes: [node('gate', 'jev-decide'), node('up', 'esrgan-upscale'), node('redo', 'gpt-image-1-edit')],
      edges: [
        { id: 'e1', source: 'gate', sourceHandle: 'on_pass', target: 'up', targetHandle: 'image' },
        { id: 'e2', source: 'gate', sourceHandle: 'on_fail', target: 'redo', targetHandle: 'image' },
      ],
      runHistory: [],
      isExecuting: false,
      isCancelling: false,
    });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'completed' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const data = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.data;

  it('marks a skipped node with its reason, records withheld ports, and keeps the run complete', async () => {
    const execute = vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeGraph();
    const runId = execute.mock.calls[0][2] as string;
    const handle = useGraphStore.getState().handleExecutionEvent;

    handle({ type: 'queued', nodeId: 'redo', runId });
    handle({ type: 'executed', nodeId: 'gate', runId, outputs: { on_pass: { type: 'Image', value: '/api/outputs/a.png' } },
      withheld: { on_fail: 'Jev Decide passed (answered yes, 0.93)' } });
    handle({ type: 'executed', nodeId: 'up', runId, outputs: { image: { type: 'Image', value: '/api/outputs/b.png' } } });
    handle({ type: 'skipped', nodeId: 'redo', runId, reason: 'Jev Decide passed (answered yes, 0.93)', gateNodeId: 'gate' });

    expect(data('gate').withheldPorts).toEqual({ on_fail: 'Jev Decide passed (answered yes, 0.93)' });
    expect(data('up').withheldPorts).toBeUndefined();
    expect(data('redo')).toMatchObject({ state: 'skipped', skipReason: 'Jev Decide passed (answered yes, 0.93)', skipGateNodeId: 'gate' });

    handle({ type: 'graphComplete', runId, duration: 1, nodesExecuted: 2, nodesSkipped: 1 });
    const [record] = useGraphStore.getState().runHistory;
    expect(record.status).toBe('complete');  // a skip is not a failure
    expect(record.skippedNodes).toEqual({ redo: 'Jev Decide passed (answered yes, 0.93)' });
    expect(data('redo').state).toBe('skipped');  // settling leaves skipped nodes alone

    // Persisted, and still a valid record when read back.
    expect(loadRunHistory()[0].skippedNodes).toEqual({ redo: 'Jev Decide passed (answered yes, 0.93)' });
  });

  it('clears the skip and the withheld ports when the node runs again', () => {
    const handle = useGraphStore.getState().handleExecutionEvent;
    handle({ type: 'skipped', nodeId: 'redo', reason: 'Jev Decide passed (answered yes, 0.93)', gateNodeId: 'gate' });
    handle({ type: 'executed', nodeId: 'gate', outputs: {}, withheld: { on_fail: 'x' } });
    handle({ type: 'queued', nodeId: 'redo' });
    handle({ type: 'executing', nodeId: 'gate' });
    expect(data('redo')).toMatchObject({ state: 'queued', skipReason: undefined, skipGateNodeId: undefined });
    expect(data('gate').withheldPorts).toBeUndefined();
  });

  it('ignores a malformed withheld map', () => {
    const handle = useGraphStore.getState().handleExecutionEvent;
    handle({ type: 'executed', nodeId: 'gate', outputs: {}, withheld: ['on_fail'] as unknown as Record<string, string> });
    expect(data('gate').withheldPorts).toBeUndefined();
    handle({ type: 'skipped', nodeId: 'redo', reason: '' });
    expect(data('redo').skipReason).toBe('A gate upstream withheld its input');
  });
});
