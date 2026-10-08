import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
import { clearCinemaScenePersistence, useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';

function spec(prompt: string): CinemaSceneSpec {
  return { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [
    { id: 'a', prompt, output: { status: 'idle' } },
    { id: 'b', prompt: 'Sibling', output: { status: 'idle' } },
  ] };
}
function node(scene: CinemaSceneSpec, id = 'n1'): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: {
    definitionId: 'cinema-scene', label: 'Scene', state: 'idle', params: { scene }, outputs: {},
  } };
}
function current() { return useGraphStore.getState().nodes[0].data.params.scene as CinemaSceneSpec; }
function edit(scene: CinemaSceneSpec) { useGraphStore.getState().updateScene('n1', scene); }
function receive(scene: CinemaSceneSpec) {
  const callback = vi.mocked(wsClient.subscribe).mock.calls[0][0] as (event: ExecutionEvent) => void;
  callback({ type: 'graphSync', empty: false, nodes: [node(scene)], edges: [] });
}
function receiveReplacement(nodes: Node<NodeData>[], edges: Edge[] = []) {
  const callback = vi.mocked(wsClient.subscribe).mock.calls[0][0] as (event: ExecutionEvent) => void;
  callback({ type: 'graphSync', graphReplaced: true, empty: nodes.length === 0, nodes, edges });
}
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve: (status = 200) => resolve({ ok: status < 400, status } as Response) };
}
async function settle() { for (let count = 0; count < 5; count++) await Promise.resolve(); }
function sent(index: number): CinemaSceneSpec {
  return JSON.parse(transport.fetch.mock.calls[index][1].body).params.scene as CinemaSceneSpec;
}

describe('Cinema scene persistence ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearCinemaScenePersistence();
    transport.fetch.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node(spec('Initial'))], edges: [], runHistory: [],
      providerRecoveries: [], providerStartAmbiguities: [], isExecuting: false, isImportingGraph: false,
      undoStack: [], redoStack: [] });
  });
  afterEach(() => {
    clearCinemaScenePersistence();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serializes rapid edits, coalesces to the latest scene, and retains fresh media in the queued write', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    transport.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    edit(spec('First'));
    edit(spec('Second'));
    edit({ ...spec('Latest'), shots: [spec('Latest').shots[0], { id: 'c', prompt: 'Added' }] });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(sent(0).shots[0].prompt).toBe('First');

    const completed = { ...spec('First'), shots: spec('First').shots.map((shot) => shot.id === 'a'
      ? { ...shot, output: { status: 'done' as const, imageUrl: 'https://fixture/new.png' },
        variations: [{ url: 'https://fixture/new.png', seed: 7 }], selectedVariation: 0 } : shot) };
    receive(completed);
    expect(current().shots.map((shot) => shot.id)).toEqual(['a', 'c']);
    expect(current().shots[0]).toMatchObject({ prompt: 'Latest', output: { status: 'done' }, selectedVariation: 0 });
    first.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual(current());
    expect(sent(1).shots[0].variations).toEqual([{ url: 'https://fixture/new.png', seed: 7 }]);
    const ports = (useGraphStore.getState().nodes[0].data as unknown as { dynamicOutputPorts: { id: string }[] }).dynamicOutputPorts;
    expect(ports.map((port) => port.id)).toEqual(['shot_a', 'shot_c']);
    expect(useGraphStore.getState().nodes[0].data.outputs.shot_a.value).toBe('https://fixture/new.png');
    second.resolve();
    await settle();
  });

  it('keeps the latest authoring after HTTP finishes until its matching WebSocket echo arrives', async () => {
    const response = deferredResponse();
    transport.fetch.mockReturnValue(response.promise);
    edit(spec('Saved latest'));
    response.resolve();
    await settle();
    receive(spec('Old echo'));
    expect(current().shots[0].prompt).toBe('Saved latest');
    receive(spec('Saved latest'));
    receive(spec('External next edit'));
    expect(current().shots[0].prompt).toBe('External next edit');
  });

  it('does not let an earlier matching echo or HTTP acknowledgement release a newer edit', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    transport.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    edit(spec('First'));
    receive(spec('First'));
    edit(spec('Latest'));
    first.resolve();
    await settle();
    receive(spec('First'));
    expect(current().shots[0].prompt).toBe('Latest');
    second.resolve();
    await settle();
    receive(spec('First'));
    expect(current().shots[0].prompt).toBe('Latest');
    receive(spec('Latest'));
    receive(spec('External'));
    expect(current().shots[0].prompt).toBe('External');
  });

  it('does not rewind newer runtime media from a recognized stale write echo', async () => {
    const response = deferredResponse();
    transport.fetch.mockReturnValue(response.promise);
    edit(spec('First'));
    edit(spec('Latest'));
    receive({ ...spec('First'), shots: [{ ...spec('First').shots[0],
      output: { status: 'done', imageUrl: 'https://fixture/completed.png' },
      variations: [{ url: 'https://fixture/completed.png', seed: 2 }], selectedVariation: 0 }, spec('First').shots[1]] });
    receive(spec('First'));
    expect(current().shots[0]).toMatchObject({ prompt: 'Latest',
      output: { status: 'done', imageUrl: 'https://fixture/completed.png' }, selectedVariation: 0 });
    expect(current().shots[0].variations).toHaveLength(1);
  });

  it('puts Inspector edits in the same queue and protects them before the debounce fires', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    transport.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    edit(spec('Studio'));
    useGraphStore.getState().updateNodeData('n1', { params: { scene: spec('Inspector') } });
    receive(spec('Studio'));
    expect(current().shots[0].prompt).toBe('Inspector');
    first.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1).shots[0].prompt).toBe('Inspector');
    second.resolve();
    await settle();
  });

  it('aborts and fences old queued writes when the same node ID is explicitly replaced', async () => {
    const old = deferredResponse();
    const replacement = deferredResponse();
    transport.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    edit(spec('Old first'));
    edit(spec('Old queued'));
    const signal = transport.fetch.mock.calls[0][1].signal as AbortSignal;
    clearCinemaScenePersistence();
    useGraphStore.getState().loadGraph([node(spec('Imported'))], []);
    expect(signal.aborted).toBe(true);
    edit(spec('Imported edit'));
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1).shots[0].prompt).toBe('Imported edit');
    expect(current().shots[0].prompt).toBe('Imported edit');
    receive(spec('Old queued'));
    expect(current().shots[0].prompt).toBe('Imported edit');
    replacement.resolve();
    await settle();
  });

  it('cancels debounce ownership so a replaced node cannot receive the prior draft', async () => {
    transport.fetch.mockResolvedValue({ ok: true });
    useGraphStore.getState().updateNodeData('n1', { params: { scene: spec('Queued inspector') } });
    clearCinemaScenePersistence('n1');
    useGraphStore.getState().loadGraph([node(spec('Imported'))], []);
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(current().shots[0].prompt).toBe('Imported');
  });

  it('releases failed persistence to external updates and retries on the next explicit edit', async () => {
    transport.fetch.mockResolvedValueOnce({ ok: false, status: 409 }).mockResolvedValueOnce({ ok: true });
    edit(spec('Rejected'));
    await settle();
    expect(console.warn).toHaveBeenCalled();
    receive(spec('External recovery'));
    expect(current().shots[0].prompt).toBe('External recovery');
    edit(spec('Retry edit'));
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1).shots[0].prompt).toBe('Retry edit');
  });

  it('bounds a missing WebSocket acknowledgement after a successful HTTP save', async () => {
    transport.fetch.mockResolvedValue({ ok: true });
    edit(spec('Saved without echo'));
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    receive(spec('External after reconnect'));
    expect(current().shots[0].prompt).toBe('External after reconnect');
  });

  it('resumes the latest suspended authoring with fresh runtime when an import fails', async () => {
    const old = deferredResponse();
    const resumed = deferredResponse();
    transport.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(resumed.promise);
    edit(spec('First request'));
    edit({ ...spec('Latest draft'), shots: [spec('Latest draft').shots[0], { id: 'c', prompt: 'Added before import' }] });
    const oldSignal = transport.fetch.mock.calls[0][1].signal as AbortSignal;
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    // Import must be allowed to receive authoritative WS state before its
    // HTTP result; the suspended old draft is temporarily not overlaid.
    receive({ ...spec('Server while importing'), shots: [{ ...spec('Server while importing').shots[0],
      output: { status: 'done', imageUrl: 'https://fixture/during-import.png' },
      variations: [{ url: 'https://fixture/during-import.png', seed: 3 }], selectedVariation: 0 },
    spec('Server while importing').shots[1]] });
    expect(current().shots[0].prompt).toBe('Server while importing');
    useGraphStore.getState().releaseGraphImport();
    expect(useGraphStore.getState().isImportingGraph).toBe(false);
    expect(current().shots.map((shot) => shot.id)).toEqual(['a', 'c']);
    expect(current().shots[0]).toMatchObject({ prompt: 'Latest draft',
      output: { imageUrl: 'https://fixture/during-import.png' }, selectedVariation: 0 });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual(current());
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    resumed.resolve();
    await settle();
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });

  it('resumes an unsent Inspector debounce after a failed import without sending during import', async () => {
    transport.fetch.mockResolvedValue({ ok: true });
    useGraphStore.getState().updateNodeData('n1', { params: { scene: spec('Inspector draft') } });
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.fetch).not.toHaveBeenCalled();
    useGraphStore.getState().releaseGraphImport();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(sent(0).shots[0].prompt).toBe('Inspector draft');
  });

  it('discards suspended authoring when the import is accepted with the same node ID', async () => {
    const old = deferredResponse();
    transport.fetch.mockReturnValue(old.promise);
    edit(spec('Old draft'));
    edit(spec('Old queued draft'));
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    receive(spec('Imported scene'));
    useGraphStore.getState().loadGraph([node(spec('Imported scene'))], []);
    useGraphStore.getState().releaseGraphImport();
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(current().shots[0].prompt).toBe('Imported scene');
  });

  it('trusts committed replacement WS and never resumes old drafts when the import HTTP acknowledgement is lost', async () => {
    const old = deferredResponse();
    transport.fetch.mockReturnValue(old.promise);
    const previous = node(spec('Old graph'));
    previous.data.outputs = { shot_a: { type: 'Image', value: 'https://fixture/old.png' } };
    const frontOnly = node(spec('Frontend only'), 'local-node');
    useGraphStore.setState({ nodes: [previous, frontOnly, node(spec('Old sibling'), 'n2')], edges: [
      { id: 'old-edge', source: 'n1', sourceHandle: 'shot_a', target: 'n2', targetHandle: 'prompt' },
    ] });
    edit(spec('Old first request'));
    edit(spec('Old queued draft'));
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    const imported = node(spec('Imported blank scene'));
    imported.position = { x: 800, y: 400 };
    receiveReplacement([imported, node(spec('Imported sibling'), 'n2')]);
    // No loadGraph call: the explicit server commit signal is sufficient.
    useGraphStore.getState().releaseGraphImport();
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(current().shots[0].prompt).toBe('Imported blank scene');
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 800, y: 400 });
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual({});
    expect(useGraphStore.getState().edges).toEqual([]);
  });

  it('treats a committed empty replacement as empty without preserving frontend-only work', async () => {
    const old = deferredResponse();
    transport.fetch.mockReturnValue(old.promise);
    edit(spec('Old pending'));
    useGraphStore.setState((state) => ({ nodes: [...state.nodes, node(spec('Local'), 'local-node')] }));
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    receiveReplacement([]);
    useGraphStore.getState().releaseGraphImport();
    old.resolve();
    await settle();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not restore suspended authoring into a deleted or retyped target', async () => {
    const old = deferredResponse();
    transport.fetch.mockReturnValue(old.promise);
    edit(spec('Old draft'));
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    useGraphStore.setState({ nodes: [{ ...node(spec('Different target')), data: {
      ...node(spec('Different target')).data, definitionId: 'nano-banana', params: {},
    } }] });
    useGraphStore.getState().releaseGraphImport();
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().nodes[0].data.params).toEqual({});
  });

  it('does not resume old scene persistence while a different backend graph is being cleared', async () => {
    const old = deferredResponse();
    transport.fetch.mockReturnValue(old.promise);
    edit(spec('Old draft'));
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    useGraphStore.setState({ backendFreshStartPending: true });
    useGraphStore.getState().releaseGraphImport();
    old.resolve();
    await settle();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    useGraphStore.setState({ backendFreshStartPending: false });
    receive(spec('Fresh server state'));
    expect(current().shots[0].prompt).toBe('Fresh server state');
  });

  it('does not persist frontend-only nodes or run generation while editing', () => {
    useGraphStore.setState({ nodes: [node(spec('Local'), 'frontend-scene')] });
    useGraphStore.getState().updateScene('frontend-scene', spec('Local edit'));
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });
});
