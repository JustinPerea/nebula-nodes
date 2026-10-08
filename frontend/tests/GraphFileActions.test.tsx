import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import type { ExecutionEvent } from '../src/lib/wsClient';

const mocks = vi.hoisted(() => ({
  saveToFile: vi.fn(), loadFromFile: vi.fn(), apiFetch: vi.fn(),
  fitView: vi.fn(), getViewport: vi.fn(), transform: [10, 20, 0.75],
  onSync: null as ((event: ExecutionEvent) => void) | null,
}));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: mocks.saveToFile, loadFromFile: mocks.loadFromFile }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: mocks.apiFetch,
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: mocks.fitView, getViewport: mocks.getViewport,
    screenToFlowPosition: (position: { x: number; y: number }) => position }),
  useStore: () => mocks.transform,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn((handler: (event: ExecutionEvent) => void) => { mocks.onSync = handler; }) } }));

import { GraphFileActions } from '../src/components/GraphFileActions';
import { CommandPalette } from '../src/components/CommandPalette';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { requestGraphLoad, requestGraphSave } from '../src/lib/graphFileActions';
import * as api from '../src/lib/api';

const initialGraph = { ...useGraphStore.getState() };
const initialUI = { ...useUIStore.getState() };
function node(id: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 15, y: 25 }, data: {
    label: id, definitionId: 'nano-banana', params: { seed: 7 }, state: 'complete',
    outputs: { image: { type: 'Image', value: '/api/outputs/fixture.png' } },
  } };
}
const pickedGraph = () => ({ nodes: [node('saved-source')], edges: [], warnings: [],
  viewport: { x: 12, y: 18, zoom: 0.5 } });

beforeEach(() => {
  vi.clearAllMocks();
  useGraphStore.getState().resetExecution();
  useGraphStore.getState().releaseGraphImport();
  mocks.transform = [10, 20, 0.75];
  mocks.getViewport.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });
  mocks.saveToFile.mockResolvedValue(undefined);
  mocks.loadFromFile.mockResolvedValue(pickedGraph());
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ nodes: [node('n8')], edges: [] }), { status: 200 }));
  useGraphStore.setState({ ...initialGraph, nodes: [node('existing')], edges: [],
    isExecuting: false, createLaunchingIds: [], providerStartAmbiguities: [] }, true);
  useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
  vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
});
afterEach(() => {
  useGraphStore.getState().resetExecution();
  useGraphStore.getState().releaseGraphImport();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  vi.restoreAllMocks();
});

function paletteCommand(name: string) {
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  fireEvent.change(screen.getByRole('textbox', { name: '' }), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('workspace-independent graph file actions', () => {
  it.each(['create', 'cinema-editor', 'editor', 'remotion-editor'] as const)('routes standard Save/Open shortcuts in %s', async (viewMode) => {
    useUIStore.setState({ viewMode });
    render(<GraphFileActions />);
    fireEvent.keyDown(document, { key: 's', metaKey: true });
    await waitFor(() => expect(mocks.saveToFile).toHaveBeenCalledOnce());
    fireEvent.keyDown(document, { key: 'o', ctrlKey: true });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledOnce());
    expect(mocks.loadFromFile).toHaveBeenCalledOnce();
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });

  it('yields to the existing Canvas shortcut without opening duplicate dialogs', async () => {
    render(<><GraphFileActions /><div data-testid="canvas-key-target" tabIndex={0} onKeyDown={(event) => {
      if (event.metaKey && event.key === 's') {
        event.preventDefault();
        requestGraphSave();
      }
    }} /></>);
    fireEvent.keyDown(screen.getByTestId('canvas-key-target'), { key: 's', metaKey: true });
    await waitFor(() => expect(mocks.saveToFile).toHaveBeenCalledOnce());
  });

  it.each(['create', 'cinema-editor'] as const)('saves from %s without mounting a Canvas Toolbar', async (viewMode) => {
    useUIStore.getState().setCanvasViewport({ x: 10, y: 20, zoom: 0.75 });
    const rendered = render(<><GraphFileActions /><CommandPalette /></>);
    act(() => useUIStore.setState({ viewMode }));
    // Simulate ReactFlow resetting its transform after Canvas unmount.
    mocks.transform = [0, 0, 1];
    mocks.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 1 });
    rendered.rerender(<><GraphFileActions /><CommandPalette /></>);
    paletteCommand('Save graph');
    await waitFor(() => expect(mocks.saveToFile).toHaveBeenCalledOnce());
    expect(mocks.saveToFile).toHaveBeenCalledWith([node('existing')], [], { x: 10, y: 20, zoom: 0.75 });
    expect(useUIStore.getState().viewMode).toBe(viewMode);
  });

  it('saves the live Canvas camera when disabled Commons falls back to Canvas', async () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: false });
    useUIStore.getState().setCanvasViewport({ x: -50, y: 40, zoom: 0.5 });
    render(<GraphFileActions />);
    await act(async () => { requestGraphSave(); });
    expect(mocks.saveToFile).toHaveBeenCalledWith([node('existing')], [], { x: 10, y: 20, zoom: 0.75 });
  });

  it.each(['create', 'cinema-editor'] as const)('loads from %s only after atomic backend confirmation', async (viewMode) => {
    useUIStore.getState().setCanvasViewport({ x: -640, y: 380, zoom: 0.48 });
    useUIStore.getState().setCinemaSelectedShot('existing', 'shot-2');
    useUIStore.setState({ viewMode, cinemaEditorNodeId: 'existing', editorTargetNodeId: 'old-editor',
      selectedNodeId: 'existing', selectedTrackItemId: 'old-track', isPlaying: true });
    let resolveImport!: (response: Response) => void;
    mocks.apiFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveImport = resolve; }));
    render(<><GraphFileActions /><CommandPalette /></>);
    paletteCommand('Load graph');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledOnce());
    expect(useGraphStore.getState().nodes[0].id).toBe('existing');
    expect(useUIStore.getState().viewMode).toBe(viewMode);
    const [url, request] = mocks.apiFetch.mock.calls[0];
    expect(url).toBe('/api/graph/import');
    expect(JSON.parse(request.body)).toEqual({ nodes: [{ id: 'saved-source', definitionId: 'nano-banana',
      params: { seed: 7 }, outputs: node('saved-source').data.outputs, position: { x: 15, y: 25 } }], edges: [] });
    await act(async () => { resolveImport(new Response(JSON.stringify({ nodes: [node('n8')], edges: [] }), { status: 200 })); });
    await waitFor(() => expect(useUIStore.getState().viewMode).toBe('canvas'));
    expect(useGraphStore.getState().nodes[0].id).toBe('n8');
    expect(useGraphStore.getState().isImportingGraph).toBe(false);
    expect(useUIStore.getState()).toMatchObject({ cinemaEditorNodeId: null, editorTargetNodeId: null,
      selectedNodeId: null, selectedTrackItemId: null, isPlaying: false,
      canvasViewport: null, cinemaSelectedShotIds: {} });
    expect(useGraphStore.getState().runHistory).toBe(initialGraph.runHistory);
  });

  it('preserves graph and workspace on picker cancellation or backend rejection', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    useUIStore.setState({ viewMode: 'create' });
    mocks.loadFromFile.mockResolvedValueOnce(null);
    render(<GraphFileActions />);
    await act(async () => { requestGraphLoad(); });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    mocks.apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Fixture import rejected' }), { status: 400 }));
    await act(async () => { requestGraphLoad(); });
    expect(alert).toHaveBeenCalledWith('Fixture import rejected');
    expect(useGraphStore.getState().nodes[0].id).toBe('existing');
    expect(useUIStore.getState().viewMode).toBe('create');
    expect(useGraphStore.getState().isImportingGraph).toBe(false);
  });

  it.each(['navigation', 'return', 'focus', 'replacement'] as const)('a delayed import fit yields to later %s', async (action) => {
    vi.useFakeTimers();
    try {
      const view = render(<GraphFileActions />);
      await act(async () => { requestGraphLoad(); });
      expect(useGraphStore.getState().nodes[0].id).toBe('n8');
      act(() => {
        if (action === 'navigation' || action === 'return') {
          useUIStore.getState().enterCreateView();
          if (action === 'return') useUIStore.getState().exitCreateView();
        }
        else if (action === 'focus') {
          useUIStore.getState().requestCanvasNodeFocus('n8');
          useUIStore.getState().clearCanvasNodeFocus(useUIStore.getState().canvasFocusRequest!.requestId);
        } else useGraphStore.getState().clearGraph();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(mocks.fitView).not.toHaveBeenCalled();
      view.unmount();
    } finally { vi.useRealTimers(); }
  });

  it.each(['execution', 'preparation', 'import'] as const)('blocks file I/O during %s ownership', async (owner) => {
    useGraphStore.setState(owner === 'execution' ? { isExecuting: true }
      : owner === 'import' ? { isImportingGraph: true } : { createLaunchingIds: ['preparing'] });
    useUIStore.setState({ viewMode: 'create' });
    render(<><GraphFileActions /><CommandPalette /></>);
    await act(async () => { requestGraphSave(); requestGraphLoad(); });
    expect(mocks.saveToFile).not.toHaveBeenCalled();
    expect(mocks.loadFromFile).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByRole('button', { name: 'Save graph' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load graph' })).toBeDisabled();
  });

  it.each(['execution', 'preparation'] as const)('rechecks %s ownership acquired while the picker was open', async (owner) => {
    let resolvePicker!: (graph: ReturnType<typeof pickedGraph>) => void;
    mocks.loadFromFile.mockReturnValue(new Promise((resolve) => { resolvePicker = resolve; }));
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'existing' });
    render(<GraphFileActions />);
    act(() => requestGraphLoad());
    useGraphStore.setState(owner === 'execution' ? { isExecuting: true } : { createLaunchingIds: ['preparing'] });
    await act(async () => resolvePicker(pickedGraph()));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes[0].id).toBe('existing');
    expect(useUIStore.getState().viewMode).toBe('cinema-editor');
  });

  it('prevents duplicate dialogs and unregisters listeners under StrictMode', async () => {
    let resolveSave!: () => void;
    mocks.saveToFile.mockReturnValue(new Promise<void>((resolve) => { resolveSave = resolve; }));
    const rendered = render(<StrictMode><GraphFileActions /></StrictMode>);
    act(() => { requestGraphSave(); requestGraphSave(); requestGraphLoad(); });
    expect(mocks.saveToFile).toHaveBeenCalledOnce();
    expect(mocks.loadFromFile).not.toHaveBeenCalled();
    await act(async () => resolveSave());
    rendered.unmount();
    act(() => { requestGraphSave(); requestGraphLoad(); });
    expect(mocks.saveToFile).toHaveBeenCalledOnce();
    expect(mocks.loadFromFile).not.toHaveBeenCalled();
  });

  it('fences every generation admission across real graphSync before the import response', async () => {
    const scene = { ...node('n1'), data: { ...node('n1').data, definitionId: 'cinema-scene',
      params: { scene: { shots: [{ id: 'a', prompt: 'fixture' }] } } } };
    const previousEdges = [{ id: 'previous-wire', source: 'n1', sourceHandle: 'shot_a', target: 'n2', targetHandle: 'images' }];
    useGraphStore.setState({ nodes: [scene, node('n2')], edges: previousEdges });
    const store = useGraphStore.getState();
    const origin = { genId: 'saved-generation', sessionId: 'fixture-session', prompt: 'fixture', ts: 1,
      modelNodeIds: ['n2'], allNodeIds: ['n2'] };
    expect(store.reserveCreateGeneration(origin.genId)).toBe(true);
    await store.executeClusterConcurrent(['n2'], origin);
    const source = useGraphStore.getState().runHistory[0];
    store.hydrateExecutionStatuses([{ runId: source.id, status: 'failed' }]);
    const previousHistory = useGraphStore.getState().runHistory;
    const previousNodes = useGraphStore.getState().nodes;
    vi.mocked(api.executeGraph).mockClear();
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    let resolveImport!: (response: Response) => void;
    mocks.apiFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveImport = resolve; }));
    render(<GraphFileActions />);
    act(() => requestGraphLoad());
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledOnce());
    expect(useGraphStore.getState()).toMatchObject({ isImportingGraph: true, isExecuting: false, activeRuns: [] });
    expect(store.reserveGraphImport()).toBe(false);
    expect(store.reserveCreateGeneration('blocked-preparation')).toBe(false);
    expect(store.isShotAdmissionBlocked('n1', 'a')).toBe(true);
    await act(async () => {
      await store.executeGraph();
      await store.executeNode('n2');
      await store.executeCluster(['n2']);
      await store.executeClusterConcurrent(['n2']);
      await store.executeShot('n1', 'a');
      await store.rerunHistoryRecord(source.id);
      await store.retryFailedRun(source.id);
      await expect(store.authorGenerationCluster({ definitionId: 'nano-banana', prompt: 'fixture', params: {},
        refPaths: [], quantity: 1, layoutOrigin: { x: 0, y: 0 }, genId: 'blocked', sessionId: 'fixture-session' }))
        .rejects.toThrow('Wait for the graph import to finish.');
    });
    expect(api.executeGraph).not.toHaveBeenCalled();
    expect(api.executeNode).not.toHaveBeenCalled();
    expect(api.generateCinemaShot).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toBe(previousNodes);
    expect(useGraphStore.getState().edges).toBe(previousEdges);
    expect(useGraphStore.getState().runHistory).toBe(previousHistory);

    // The real import route broadcasts graphSync after its commit but before
    // returning HTTP. Exercise the subscribed merge handler, not a setState stub.
    const importedNodes = [node('n8'), node('n9')];
    const importedEdges = [{ id: 'imported-wire', source: 'n8', sourceHandle: 'image', target: 'n9', targetHandle: 'images' }];
    act(() => mocks.onSync!({ type: 'graphSync', nodes: importedNodes, edges: importedEdges, empty: false }));
    expect(useGraphStore.getState().nodes.map((entry) => entry.id)).toEqual(['n8', 'n9']);
    expect(useGraphStore.getState().edges).toEqual(importedEdges);
    expect(useGraphStore.getState().isImportingGraph).toBe(true);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    await act(async () => { await store.executeNode('n8'); await store.executeClusterConcurrent(['n8']); });
    expect(api.executeGraph).not.toHaveBeenCalled();
    expect(api.executeNode).not.toHaveBeenCalled();
    expect(useGraphStore.getState().runHistory).toBe(previousHistory);
    expect(mocks.fitView).not.toHaveBeenCalled();
    await act(async () => resolveImport(new Response(JSON.stringify({ nodes: importedNodes, edges: importedEdges }), { status: 200 })));
    expect(useGraphStore.getState()).toMatchObject({ nodes: importedNodes, edges: importedEdges,
      isImportingGraph: false, isExecuting: false, activeRuns: [] });
    expect(useGraphStore.getState().runHistory).toBe(previousHistory);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', cinemaEditorNodeId: null });
    await act(async () => { await store.executeNode('n8'); });
    expect(api.executeNode).toHaveBeenCalledOnce();
  });

  it.each(['execution', 'preparation'] as const)('preserves the workspace when %s acquires ownership before the import response', async (owner) => {
    let resolveImport!: (response: Response) => void;
    mocks.apiFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveImport = resolve; }));
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'existing' });
    render(<GraphFileActions />);
    act(() => requestGraphLoad());
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledOnce());
    useGraphStore.setState(owner === 'execution' ? { isExecuting: true } : { createLaunchingIds: ['preparing'] });
    await act(async () => { resolveImport(new Response(JSON.stringify({ nodes: [node('n8')], edges: [] }), { status: 200 })); });
    expect(useGraphStore.getState().nodes[0].id).toBe('existing');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'existing' });
    expect(mocks.fitView).not.toHaveBeenCalled();
  });
});
