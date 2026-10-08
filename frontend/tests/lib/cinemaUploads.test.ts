import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../../src/types';
import { freezeRunSnapshot, type RunRecord } from '../../src/lib/runHistory';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/backend', async (original) => ({ ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => fetchMock(...args), backendAssetUrlSync: (url: string) => `http://localhost:8000${url}` }));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../src/lib/cinemaUploads';
import { createCinemaUploadStore, getCinemaUploadIssue, useCinemaUploadStore,
  CINEMA_UPLOAD_STORAGE_KEY, INTERRUPTED_CINEMA_UPLOAD_MESSAGE } from '../../src/store/cinemaUploadStore';
import { useGraphStore } from '../../src/store/graphStore';
import * as api from '../../src/lib/api';
const initial = { ...useGraphStore.getState() };
const nodeId = 'scene-local';
function scene(): CinemaSceneSpec {
  return { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9',
    character: { refImageUrls: ['/api/outputs/original.png'], strength: 0.6, sheetUrl: '/api/outputs/sheet.png' },
    shots: [{ id: 'a', prompt: 'Original A', refImageUrls: [], output: { status: 'done', imageUrl: '/api/outputs/a.png' },
      variations: [{ url: '/api/outputs/a.png', seed: 5 }], selectedVariation: 0 },
    { id: 'b', prompt: 'Original B', output: { status: 'idle' } }] };
}
function cinema(id = nodeId): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, type: 'cinemaSceneNode', data: { label: 'Scene', definitionId: 'cinema-scene',
    params: { scene: scene() }, state: 'complete', outputs: { shot_a: { type: 'Image', value: '/api/outputs/a.png' } } } };
}
const current = () => useGraphStore.getState().nodes.find((node) => node.id === nodeId)!.data.params.scene as CinemaSceneSpec;
const uploads = () => useCinemaUploadStore.getState().uploads;
const image = (name = 'reference.png') => new File(['png'], name, { type: 'image/png' });
const response = (name = 'uploaded.png') => ({ ok: true, json: async () => ({ filePath: `/abs/${name}`, url: `/api/outputs/${name}` }) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const drain = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  useCinemaUploadStore.getState().clear(); useGraphStore.getState().resetExecution();
  useGraphStore.setState({ ...initial, nodes: [cinema()], edges: [], runHistory: [], providerStartAmbiguities: [] });
  localStorage.clear(); fetchMock.mockReset(); vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
});
afterEach(() => { useCinemaUploadStore.getState().clear(); useGraphStore.getState().resetExecution();
  useGraphStore.setState(initial, true); vi.restoreAllMocks(); localStorage.clear(); });

describe('Cinema reference ownership', () => {
  it('reserves chips before POST and appends only references to the latest scene, retaining outputs/edges/history', async () => {
    const first = deferred<ReturnType<typeof response>>(), second = deferred<ReturnType<typeof response>>();
    const original = scene();
    const history: RunRecord[] = [{ id: 'saved', trigger: 'shot', startedAt: 1, status: 'complete', cinemaShot: { nodeId, shotId: 'a' },
      snapshot: freezeRunSnapshot({ nodes: [{ id: nodeId, definitionId: 'cinema-scene', params: { scene: original }, outputs: {} }], edges: [] }) }];
    const target = { ...cinema('target'), data: { ...cinema().data, definitionId: 'preview', params: {} } };
    const edges = [{ id: 'kept', source: nodeId, sourceHandle: 'shot_a', target: 'target', targetHandle: 'value' }];
    useGraphStore.setState({ nodes: [cinema(), target], edges, runHistory: history });
    fetchMock.mockImplementationOnce(() => { expect(uploads()).toHaveLength(2); return first.promise; }).mockReturnValueOnce(second.promise);
    attachCinemaReferences(nodeId, undefined, [image('first.png'), image('second.png')]);
    useGraphStore.getState().updateScene(nodeId, (latest) => ({ ...latest, base: { model: 'seedream-4-5' }, aspectRatio: '9:16',
      look: { grain: 0.9 }, character: { ...latest.character!, sheetUrl: '/api/outputs/new-sheet.png' },
      shots: [...latest.shots].reverse().map((shot) => shot.id === 'a' ? { ...shot, prompt: 'Newest prompt',
        output: { status: 'done', imageUrl: '/api/outputs/new-result.png' }, variations: [{ url: '/api/outputs/new-result.png', seed: 8 }] } : shot) }));
    const added = useGraphStore.getState().addShot(nodeId); useGraphStore.getState().removeShot(nodeId, 'b');
    second.resolve(response('second.png')); await waitFor(() => expect(current().character?.refImageUrls).toContain('/api/outputs/second.png'));
    first.resolve(response('first.png')); await waitFor(() => expect(uploads()).toEqual([]));
    expect(current()).toMatchObject({ base: { model: 'seedream-4-5' }, aspectRatio: '9:16', look: { grain: 0.9 },
      character: { strength: 0.6, sheetUrl: '/api/outputs/new-sheet.png', refImageUrls: [
        '/api/outputs/original.png', '/api/outputs/second.png', '/api/outputs/first.png'] } });
    expect(current().shots.map((shot) => shot.id)).toEqual(['a', added]);
    expect(current().shots[0]).toMatchObject({ prompt: 'Newest prompt', output: { imageUrl: '/api/outputs/new-result.png' },
      variations: [{ url: '/api/outputs/new-result.png', seed: 8 }], selectedVariation: 0 });
    expect(useGraphStore.getState().edges).toEqual(edges); expect(useGraphStore.getState().runHistory).toBe(history);
    expect(history[0].snapshot.nodes[0].params.scene).toEqual(original);
    expect(api.executeGraph).not.toHaveBeenCalled(); expect(api.generateCinemaShot).not.toHaveBeenCalled();
  });
  it('retains shot ownership when another shot is selected/edited', async () => {
    const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise);
    attachCinemaReferences(nodeId, 'a', [image()]);
    useGraphStore.getState().updateScene(nodeId, (latest) => ({ ...latest, shots: latest.shots.map((shot) => ({ ...shot, prompt: `Edited ${shot.id}` })) }));
    pending.resolve(response()); await waitFor(() => expect(uploads()).toEqual([]));
    expect(current().shots[0]).toMatchObject({ prompt: 'Edited a', refImageUrls: ['/api/outputs/uploaded.png'] });
    expect(current().shots[1]).toMatchObject({ prompt: 'Edited b' }); expect(current().shots[1].refImageUrls).toBeUndefined();
  });
  it.each(['remove', 'removeShot', 'removeNode', 'wrongType', 'clear', 'import'] as const)(
    'ignores a late response after %s even if IDs are restored and fetch ignores abort', async (action) => {
      const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise);
      attachCinemaReferences(nodeId, 'a', [image()]); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
      if (action === 'remove') removeCinemaReferenceUpload(uploads()[0].id);
      if (action === 'removeShot') { useGraphStore.getState().removeShot(nodeId, 'a'); useGraphStore.getState().undo(); }
      if (action === 'removeNode') { useGraphStore.setState({ nodes: [] }); useGraphStore.setState({ nodes: [cinema()] }); }
      if (action === 'wrongType') { useGraphStore.setState({ nodes: [{ ...cinema(), data: { ...cinema().data, definitionId: 'preview' } }] }); useGraphStore.setState({ nodes: [cinema()] }); }
      if (action === 'clear') { useGraphStore.getState().clearGraph(); useGraphStore.getState().undo(); }
      if (action === 'import') useGraphStore.getState().loadGraph([cinema()], []);
      expect(signal.aborted).toBe(true); pending.resolve(response()); await drain();
      expect(current().shots.find((shot) => shot.id === 'a')?.refImageUrls).toEqual([]); expect(uploads()).toEqual([]);
      expect(api.executeGraph).not.toHaveBeenCalled();
    });
  it('keeps pending upload ownership when only run history is cleared', async () => {
    const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise);
    attachCinemaReferences(nodeId, 'a', [image()]);
    useGraphStore.getState().clearRunHistory();
    expect(uploads()).toHaveLength(1); expect(getCinemaUploadIssue(nodeId, 'a')).not.toBeNull();
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
    pending.resolve(response()); await waitFor(() => expect(current().shots[0].refImageUrls).toEqual(['/api/outputs/uploaded.png']));
    expect(api.generateCinemaShot).not.toHaveBeenCalled();
  });
  it('keeps per-file HTTP errors actionable, retains successful references and retries explicitly', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 415, json: async () => ({ detail: 'Invalid image bytes' }) }).mockResolvedValueOnce(response());
    attachCinemaReferences(nodeId, 'a', [image('bad.png'), image('good.png')]); await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()[0]).toMatchObject({ name: 'bad.png', status: 'error', error: 'Invalid image bytes', canRetry: true });
    expect(current().shots[0].refImageUrls).toEqual(['/api/outputs/uploaded.png']); expect(getCinemaUploadIssue(nodeId, 'a')).toContain('Retry or remove');
    fetchMock.mockResolvedValueOnce(response()); retryCinemaReferenceUpload(uploads()[0].id); expect(uploads()[0].status).toBe('uploading');
    await waitFor(() => expect(uploads()).toEqual([])); expect(current().shots[0].refImageUrls).toEqual(['/api/outputs/uploaded.png']);
    expect(api.generateCinemaShot).not.toHaveBeenCalled();
  });
  it('interrupts on import reservation but permits explicit retry after an unsuccessful import', async () => {
    const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise);
    attachCinemaReferences(nodeId, 'a', [image()]); const id = uploads()[0].id;
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true); expect(uploads()[0]).toMatchObject({ status: 'error', canRetry: true });
    pending.resolve(response('old.png')); await drain(); expect(current().shots[0].refImageUrls).toEqual([]);
    retryCinemaReferenceUpload(id); expect(fetchMock).toHaveBeenCalledTimes(1); useGraphStore.getState().releaseGraphImport();
    fetchMock.mockResolvedValueOnce(response('retry.png')); retryCinemaReferenceUpload(id);
    await waitFor(() => expect(current().shots[0].refImageUrls).toEqual(['/api/outputs/retry.png']));
  });
  it('keeps restored interruption metadata through persisted-owner terminal settlement before graph hydration', async () => {
    const { persistRunHistory } = await import('../../src/lib/runHistory');
    persistRunHistory([{ id: 'old-terminal', trigger: 'shot', startedAt: 1, status: 'running', targetNodeId: nodeId,
      cinemaShot: { nodeId, shotId: 'a' },
      snapshot: freezeRunSnapshot({ nodes: [{ id: nodeId, definitionId: 'cinema-scene', params: { scene: scene() }, outputs: {} }], edges: [] }) }]);
    useCinemaUploadStore.getState().setUploads(() => [{ id: 'restored', attempt: 'old', nodeId, shotId: 'a', name: 'pending.png', status: 'error', canRetry: false }]);
    vi.resetModules();
    const { useGraphStore: restoredGraph } = await import('../../src/store/graphStore');
    const { useCinemaUploadStore: restoredUploads } = await import('../../src/store/cinemaUploadStore');
    try {
      expect(restoredGraph.getState().nodes).toEqual([]);
      expect(restoredGraph.getState().activeRuns).toEqual([expect.objectContaining({ id: 'old-terminal', status: 'uncertain' })]);
      const emptyBeforeSettlement = restoredGraph.getState().nodes;
      restoredGraph.getState().hydrateExecutionStatuses([{ runId: 'old-terminal', status: 'completed' }]);
      expect(restoredGraph.getState().nodes).not.toBe(emptyBeforeSettlement);
      expect(restoredGraph.getState().activeRuns).toEqual([]);
      expect(restoredGraph.getState().runHistory[0]).toMatchObject({ id: 'old-terminal', status: 'complete' });
      expect(restoredUploads.getState().uploads).toHaveLength(1);
      restoredGraph.getState().loadGraph([cinema()], [], { preserveCinemaUploads: true });
      expect(restoredUploads.getState().uploads).toHaveLength(1);
      restoredGraph.getState().loadGraph([], [], { preserveCinemaUploads: true });
      expect(restoredUploads.getState().uploads).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restoredGraph.getState().resetExecution();
      restoredUploads.getState().clear();
      vi.resetModules();
    }
  });
  it('reloads interrupted metadata without automatic requests, File objects or graph recipe changes', () => {
    const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }, store = createCinemaUploadStore(storage);
    store.getState().setUploads(() => [{ id: 'reload', attempt: 'old', nodeId, shotId: 'a', name: 'draft.png', status: 'uploading', canRetry: true }]);
    storage.getItem.mockReturnValue(storage.setItem.mock.calls[0][1]); const restored = createCinemaUploadStore(storage);
    expect(restored.getState().uploads[0]).toMatchObject({ status: 'error', canRetry: false, error: INTERRUPTED_CINEMA_UPLOAD_MESSAGE });
    expect(storage.setItem.mock.calls[0][0]).toBe(CINEMA_UPLOAD_STORAGE_KEY); expect(storage.setItem.mock.calls[0][1]).not.toContain('canRetry');
    useCinemaUploadStore.setState({ uploads: restored.getState().uploads });
    useGraphStore.getState().loadGraph([cinema()], [], { preserveCinemaUploads: true }); retryCinemaReferenceUpload('reload');
    expect(fetchMock).not.toHaveBeenCalled(); expect(getCinemaUploadIssue(nodeId, 'a')).toContain('Retry or remove');
    expect(JSON.stringify(useGraphStore.getState().nodes)).not.toContain('reload'); removeCinemaReferenceUpload('reload');
    expect(getCinemaUploadIssue(nodeId, 'a')).toBeNull();
  });
});
describe('Cinema current-recipe admission', () => {
  it.each(['graph', 'node', 'downstream', 'cluster', 'concurrent', 'shot'] as const)(
    'blocks %s before queue/history mutation for pending and failed references', async (entry) => {
      const downstream = { ...cinema('downstream'), data: { ...cinema().data, definitionId: 'veo-3', params: {} } }, nodes = [cinema(), downstream];
      useGraphStore.setState({ nodes, edges: [{ id: 'motion', source: nodeId, target: 'downstream', sourceHandle: 'shot_a', targetHandle: 'image' }] });
      for (const status of ['uploading', 'error'] as const) {
        useCinemaUploadStore.getState().setUploads(() => [{ id: status, attempt: status, nodeId, name: 'pending.png', status, canRetry: false }]);
        const store = useGraphStore.getState();
        if (entry === 'graph') await store.executeGraph(); if (entry === 'node') await store.executeNode(nodeId);
        if (entry === 'downstream') await store.executeNode('downstream'); if (entry === 'cluster') await store.executeCluster([nodeId]);
        if (entry === 'concurrent') await store.executeClusterConcurrent([nodeId]); if (entry === 'shot') await store.executeShot(nodeId, 'a');
        expect(api.executeGraph).not.toHaveBeenCalled(); expect(api.executeNode).not.toHaveBeenCalled(); expect(api.generateCinemaShot).not.toHaveBeenCalled();
        expect(useGraphStore.getState().runHistory).toEqual([]); expect(useGraphStore.getState().activeRuns).toEqual([]); expect(useGraphStore.getState().nodes).toBe(nodes);
      }
    });
  it('allows independent sibling shots and unrelated targets, while shared references block every shot', async () => {
    const other = { ...cinema('other'), data: { ...cinema().data, definitionId: 'nano-banana', params: {} } };
    useGraphStore.setState({ nodes: [cinema(), other] });
    useCinemaUploadStore.getState().setUploads(() => [{ id: 'a', attempt: 'a', nodeId, shotId: 'a', name: 'a.png', status: 'uploading', canRetry: false }]);
    expect(useGraphStore.getState().isShotAdmissionBlocked(nodeId, 'a')).toBe(true); expect(useGraphStore.getState().isShotAdmissionBlocked(nodeId, 'b')).toBe(false);
    await useGraphStore.getState().executeShot(nodeId, 'b'); expect(api.generateCinemaShot).toHaveBeenCalledTimes(1); useGraphStore.getState().resetExecution();
    await useGraphStore.getState().executeNode('other'); expect(api.executeNode).toHaveBeenCalledTimes(1); useGraphStore.getState().resetExecution();
    useCinemaUploadStore.getState().setUploads(() => [{ id: 'shared', attempt: 'shared', nodeId, name: 'shared.png', status: 'error', canRetry: false }]);
    expect(useGraphStore.getState().isShotAdmissionBlocked(nodeId, 'a')).toBe(true); expect(useGraphStore.getState().isShotAdmissionBlocked(nodeId, 'b')).toBe(true);
  });
  it('explicitly replays frozen history independently of unresolved current-draft references', async () => {
    const snapshot = freezeRunSnapshot({ nodes: [{ id: nodeId, definitionId: 'cinema-scene', params: { scene: scene() }, outputs: {} }], edges: [] });
    const saved: RunRecord = { id: 'saved', trigger: 'shot', status: 'complete', startedAt: 1, snapshot, cinemaShot: { nodeId, shotId: 'a' } };
    useGraphStore.setState({ runHistory: [saved] });
    useCinemaUploadStore.getState().setUploads(() => [{ id: 'draft', attempt: 'draft', nodeId, name: 'new.png', status: 'uploading', canRetry: false }]);
    await useGraphStore.getState().rerunHistoryRecord('saved'); expect(api.generateCinemaShot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.generateCinemaShot).mock.calls[0][0]).toEqual(snapshot.nodes);
    expect(useGraphStore.getState().runHistory.find((record) => record.id === 'saved')).toBe(saved);
  });
});
