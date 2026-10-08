import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../../src/types';
import { freezeRunSnapshot, type RunRecord } from '../../src/lib/runHistory';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), listeners: [] as ((event: unknown) => void)[] }));
vi.mock('../../src/lib/backend', async (original) => ({ ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: (listener: (event: unknown) => void) => { mocks.listeners.push(listener); } } }));
import { CinemaShotPanel } from '../../src/components/cinema-studio/CinemaShotPanel';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { useCinemaMotionStore } from '../../src/store/cinemaMotionStore';
import { sendCinemaShotToMotion, viewCinemaMotionNode } from '../../src/lib/cinemaMotion';

const initial = { ...useGraphStore.getState() };
const uiInitial = { ...useUIStore.getState() };
const endpoint = '/api/cinema/send-to-motion';
function scene(): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [
    { id: 'a', prompt: 'First logo', output: { status: 'done', imageUrl: '/api/outputs/a.png' } },
    { id: 'b', prompt: 'Second logo', output: { status: 'done', imageUrl: '/api/outputs/b.png' } },
  ] };
}
function source(id = 'n1'): Node<NodeData> {
  return { id, type: 'cinemaSceneNode', position: { x: 40, y: 80 }, data: { label: 'Scene', definitionId: 'cinema-scene',
    params: { scene: scene() }, state: 'complete', outputs: { shot_a: { type: 'Image', value: '/api/outputs/a.png' },
      shot_b: { type: 'Image', value: '/api/outputs/b.png' } } } };
}
function result(shotId = 'a', id = 'n2') {
  const node: Node<NodeData> = { id, type: 'model-node', position: { x: 400, y: 80 }, data: { label: 'Veo',
    definitionId: 'veo-3', params: { duration: 8 }, outputs: {}, state: 'idle' } };
  const edge: Edge = { id: `edge-${id}`, source: 'n1', sourceHandle: `shot_${shotId}`, target: id,
    targetHandle: 'image', type: 'typed-edge', data: { dataType: 'Image' } };
  return { node, edge };
}
const response = (value: unknown = result()) => ({ ok: true, json: async () => value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function panel(shotId = 'a', nodeId = 'n1') {
  const current = useGraphStore.getState().nodes.find((node) => node.id === nodeId)!.data.params.scene as CinemaSceneSpec;
  return <CinemaShotPanel cinemaNodeId={nodeId} scene={current} shot={current.shots.find((shot) => shot.id === shotId)!} onChangeShot={vi.fn()} />;
}
const handoffs = () => useCinemaMotionStore.getState().handoffs;
const requests = () => mocks.fetch.mock.calls.filter(([path]) => path === endpoint);

beforeEach(() => {
  mocks.fetch.mockReset();
  useCinemaMotionStore.getState().clear();
  useGraphStore.setState({ ...initial, nodes: [source()], edges: [], activeRuns: [], isExecuting: false, isImportingGraph: false,
    runHistory: [], isShotAdmissionBlocked: () => false });
  useUIStore.setState({ ...uiInitial, viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1', canvasFocusRequest: null });
});
afterEach(() => {
  useCinemaMotionStore.getState().clear();
  useGraphStore.setState(initial, true); useUIStore.setState(uiInitial, true);
  vi.restoreAllMocks(); localStorage.clear();
});

describe('Cinema motion handoff', () => {
  it('keeps pending ownership across panel remount/shot switches and rejects duplicate activation', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const view = render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Send to motion' }));
    expect(screen.getByRole('button', { name: 'Connecting video node…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connecting video node…' })).toHaveAttribute('aria-busy', 'true');
    void sendCinemaShotToMotion('n1', 'a'); expect(requests()).toHaveLength(1);
    view.rerender(panel('b')); expect(screen.getByRole('button', { name: 'Send to motion' })).toBeEnabled();
    view.unmount(); const remounted = render(panel());
    expect(screen.getByRole('button', { name: 'Connecting video node…' })).toBeDisabled();
    await act(async () => { pending.resolve(response()); await pending.promise; });
    expect(screen.getByRole('button', { name: 'View video node' })).toBeEnabled();
    remounted.rerender(panel('b')); expect(screen.queryByRole('button', { name: 'View video node' })).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(2); expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it.each([null, { id: 'n2' }, { ...result(), edge: { ...result().edge, sourceHandle: 'shot_b' } },
    { ...result(), node: { ...result().node, data: { ...result().node.data, definitionId: 'preview' } } }])(
    'never announces success for an unconfirmed reply %#', async (value) => {
      mocks.fetch.mockResolvedValueOnce(response(value)); render(panel());
      fireEvent.click(screen.getByRole('button', { name: 'Send to motion' }));
      await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Retry connection' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'View video node' })).toBeNull();
      expect(useGraphStore.getState().nodes).toHaveLength(1); expect(useGraphStore.getState().edges).toEqual([]);
    });

  it('retains a rejected-request error until explicit retry and sends current artwork', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 409 }); render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Send to motion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('shot changed');
    act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, data: { ...node.data,
      params: { scene: { ...scene(), shots: scene().shots.map((shot) => shot.id === 'a'
        ? { ...shot, output: { status: 'done', imageUrl: '/api/outputs/new.png' } } : shot) } } } })) })));
    mocks.fetch.mockResolvedValueOnce(response()); fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await screen.findByRole('button', { name: 'View video node' });
    expect(JSON.parse(requests()[1][1].body)).toEqual({ nodeId: 'n1', shotId: 'a', expectedImageUrl: '/api/outputs/new.png' });
    expect(requests()).toHaveLength(2);
  });

  it('keeps newer source/target edits, results, unrelated edges and frozen history when HTTP confirms a pair', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const history: RunRecord[] = [{ id: 'saved', trigger: 'node', startedAt: 1, status: 'complete',
      snapshot: freezeRunSnapshot({ nodes: [{ id: 'n1', definitionId: 'cinema-scene', params: { scene: scene() }, outputs: {} }], edges: [] }) }];
    useGraphStore.setState({ runHistory: history });
    const task = sendCinemaShotToMotion('n1', 'a');
    const target = { ...result().node, data: { ...result().node.data, params: { duration: 4, prompt: 'New video prompt' },
      outputs: { video: { type: 'Video' as const, value: '/api/outputs/earlier.mp4' } }, state: 'complete' as const } };
    useGraphStore.setState({ nodes: [{ ...source(), data: { ...source().data, params: { scene: { ...scene(), look: { grain: 0.7 },
      shots: [...scene().shots].reverse().map((shot) => ({ ...shot, prompt: `New ${shot.id}` })) } } } }, target],
      edges: [{ id: 'kept', source: 'n1', sourceHandle: 'shot_b', target: 'n2', targetHandle: 'prompt' }] });
    pending.resolve(response()); await task;
    expect(useGraphStore.getState().nodes[0].data.params.scene).toMatchObject({ look: { grain: 0.7 }, shots: [
      { id: 'b', prompt: 'New b' }, { id: 'a', prompt: 'New a' }] });
    expect(useGraphStore.getState().nodes[1]).toBe(target);
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual(['kept', 'edge-n2']);
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(history[0].snapshot.nodes[0].params.scene).toEqual(scene());
  });

  it('lets lost HTTP acknowledgements recover a confirmed pair without a local duplicate', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('response lost'));
    await sendCinemaShotToMotion('n1', 'a'); expect(handoffs()[0].status).toBe('error');
    mocks.fetch.mockResolvedValueOnce(response()); await sendCinemaShotToMotion('n1', 'a');
    expect(handoffs()[0]).toMatchObject({ status: 'ready', targetId: 'n2' });
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    // Server reuse is separately tested against the actual CLIGraph endpoint.
    expect(requests()).toHaveLength(2);
  });

  it('uses a confirmed graph connection before HTTP settles and never restores it after removal', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const task = sendCinemaShotToMotion('n1', 'a'); const signal = requests()[0][1].signal as AbortSignal;
    useGraphStore.setState({ nodes: [source(), result().node], edges: [result().edge] });
    expect(handoffs()[0]).toMatchObject({ status: 'ready', targetId: 'n2' }); expect(signal.aborted).toBe(true);
    useGraphStore.setState({ nodes: [source()], edges: [] }); expect(handoffs()[0].status).toBe('error');
    pending.resolve(response()); await task;
    expect(useGraphStore.getState().nodes).toHaveLength(1); expect(useGraphStore.getState().edges).toEqual([]);
    viewCinemaMotionNode('n1', 'a'); expect(useUIStore.getState().viewMode).toBe('cinema-editor');
  });

  it('does not restore a pair omitted by newer authoritative sync even when its creation sync was lost', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const task = sendCinemaShotToMotion('n1', 'a');
    // Server committed then deleted the pair, and only its latest sync arrived.
    for (const listener of mocks.listeners) listener({ type: 'graphSync', nodes: [source()], edges: [], empty: false });
    pending.resolve(response()); await task;
    expect(handoffs()[0].status).toBe('error');
    expect(useGraphStore.getState().nodes).toHaveLength(1); expect(useGraphStore.getState().edges).toEqual([]);
  });

  it('drops only the confirmed motion wire removed by canonical sync while both endpoints remain', async () => {
    mocks.fetch.mockResolvedValueOnce(response()); await sendCinemaShotToMotion('n1', 'a');
    useGraphStore.setState((state) => ({ edges: [...state.edges,
      { id: 'optimistic', source: 'n1', sourceHandle: 'shot_b', target: 'n2', targetHandle: 'prompt' }] }));
    for (const listener of mocks.listeners) listener({ type: 'graphSync', nodes: [source(), result().node], edges: [], empty: false });
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual(['optimistic']);
    expect(handoffs()[0].status).toBe('error');
    viewCinemaMotionNode('n1', 'a'); expect(useUIStore.getState().canvasFocusRequest).toBeNull();
  });

  it('does not wire a returned target that has since been retyped', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const task = sendCinemaShotToMotion('n1', 'a');
    const retyped = { ...result().node, data: { ...result().node.data, definitionId: 'text-input' } };
    useGraphStore.setState({ nodes: [source(), retyped] });
    pending.resolve(response()); await task;
    expect(handoffs()[0].status).toBe('error'); expect(useGraphStore.getState().edges).toEqual([]);
    expect(useGraphStore.getState().nodes[1]).toBe(retyped);
  });

  it.each(['shot removed', 'node removed', 'retyped', 'load', 'clear', 'tagged import'] as const)(
    'fences late confirmation after %s even if IDs return', async (action) => {
      const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
      const task = sendCinemaShotToMotion('n1', 'a'); const signal = requests()[0][1].signal as AbortSignal;
      if (action === 'shot removed') useGraphStore.setState({ nodes: [{ ...source(), data: { ...source().data,
        params: { scene: { ...scene(), shots: [scene().shots[1]] } } } }] });
      if (action === 'node removed') useGraphStore.setState({ nodes: [] });
      if (action === 'retyped') useGraphStore.setState({ nodes: [{ ...source(), data: { ...source().data, definitionId: 'preview' } }] });
      if (action === 'load') useGraphStore.getState().loadGraph([source()], []);
      if (action === 'clear') useGraphStore.getState().clearGraph();
      if (action === 'tagged import') for (const listener of mocks.listeners) listener({ type: 'graphSync', graphReplaced: true,
        nodes: [source()], edges: [], empty: false });
      expect(signal.aborted).toBe(true); useGraphStore.setState({ nodes: [source()], edges: [] });
      pending.resolve(response()); await task;
      expect(handoffs()).toEqual([]); expect(useGraphStore.getState().nodes).toHaveLength(1); expect(useGraphStore.getState().edges).toEqual([]);
    });

  it('interrupts an import reservation and recovers only on explicit retry after rejection', async () => {
    const pending = deferred<ReturnType<typeof response>>(); mocks.fetch.mockReturnValueOnce(pending.promise);
    const task = sendCinemaShotToMotion('n1', 'a');
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    expect(handoffs()[0]).toMatchObject({ status: 'error' });
    pending.resolve(response()); await task; expect(useGraphStore.getState().nodes).toHaveLength(1);
    await sendCinemaShotToMotion('n1', 'a'); expect(requests()).toHaveLength(1);
    useGraphStore.getState().releaseGraphImport(); mocks.fetch.mockResolvedValueOnce(response());
    await sendCinemaShotToMotion('n1', 'a'); expect(handoffs()[0].status).toBe('ready');
  });

  it('creates a typed local pair atomically, reuses it, and preserves undo/results/history without HTTP or generation', async () => {
    useGraphStore.setState({ nodes: [source('local-scene')], undoStack: [], redoStack: [] });
    const snapshots: { nodes: number; edges: number }[] = [];
    const unsubscribe = useGraphStore.subscribe((state) => snapshots.push({ nodes: state.nodes.length, edges: state.edges.length }));
    await sendCinemaShotToMotion('local-scene', 'a'); const targetId = handoffs()[0].targetId;
    expect(handoffs()[0].status).toBe('ready'); expect(targetId).toBeTruthy();
    expect(snapshots).not.toContainEqual({ nodes: 2, edges: 0 });
    expect(useGraphStore.getState().edges[0]).toMatchObject({ source: 'local-scene', sourceHandle: 'shot_a',
      target: targetId, targetHandle: 'image', data: { dataType: 'Image' } });
    expect(useGraphStore.getState().nodes[1]).toMatchObject({ position: { x: 400, y: 80 }, data: { state: 'idle', outputs: {} } });
    await sendCinemaShotToMotion('local-scene', 'a'); expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    useGraphStore.getState().undo(); expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(source().data.outputs);
    expect(handoffs()[0].status).toBe('error'); expect(mocks.fetch).not.toHaveBeenCalled(); unsubscribe();
  });

  it('opens the confirmed destination on Canvas and never submits execution', async () => {
    mocks.fetch.mockResolvedValueOnce(response()); render(panel());
    fireEvent.click(screen.getByRole('button', { name: 'Send to motion' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View video node' }));
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', cinemaEditorNodeId: null,
      selectedNodeId: 'n2', canvasFocusRequest: { nodeId: 'n2' } });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n2')?.selected).toBe(true);
    expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual([endpoint]);
    expect(useGraphStore.getState().runHistory).toEqual([]); expect(useGraphStore.getState().activeRuns).toEqual([]);
  });

  it('requires a settled image and blocks handoff during import', async () => {
    useGraphStore.setState({ nodes: [{ ...source(), data: { ...source().data, params: { scene: { ...scene(), shots: [
      { id: 'a', prompt: 'Waiting', output: { status: 'idle' } }] } } } }] });
    const view = render(panel()); expect(screen.getByRole('button', { name: 'Send to motion' })).toBeDisabled();
    await sendCinemaShotToMotion('n1', 'a'); expect(mocks.fetch).not.toHaveBeenCalled();
    act(() => useGraphStore.setState({ nodes: [source()], isImportingGraph: true })); view.rerender(panel());
    expect(screen.getByRole('button', { name: 'Send to motion' })).toBeDisabled();
    await sendCinemaShotToMotion('n1', 'a'); expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['load', 'clear', 'tagged import'] as const)('revokes unmeasured destination focus on %s with reused IDs', async (action) => {
    mocks.fetch.mockResolvedValueOnce(response()); await sendCinemaShotToMotion('n1', 'a');
    viewCinemaMotionNode('n1', 'a'); expect(useUIStore.getState().canvasFocusRequest?.nodeId).toBe('n2');
    if (action === 'load') useGraphStore.getState().loadGraph([source(), result().node], []);
    if (action === 'clear') useGraphStore.getState().clearGraph();
    if (action === 'tagged import') for (const listener of mocks.listeners) listener({ type: 'graphSync', graphReplaced: true,
      nodes: [source(), result().node], edges: [], empty: false });
    expect(useUIStore.getState().canvasFocusRequest).toBeNull(); expect(useUIStore.getState().selectedNodeId).toBeNull();
  });
});
