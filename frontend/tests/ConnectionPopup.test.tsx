import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { ConnectionPopup } from '../src/components/ConnectionPopup';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const flow = vi.hoisted(() => ({ screenToFlowPosition: vi.fn() }));
const reads = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: reads.apiFetch,
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ screenToFlowPosition: flow.screenToFlowPosition }),
}));
vi.mock('../src/components/ProviderReadinessBadge', () => ({ ProviderReadinessBadge: () => null }));

type GraphState = ReturnType<typeof useGraphStore.getState>;
type PopupOptions = Parameters<ReturnType<typeof useUIStore.getState>['showConnectionPopup']>[0];
const sourceValue = '/outputs/current-logo.png';
const position = { x: 780, y: 280 };
const popupOptions: PopupOptions = { position, nodeId: 'n1', handleId: 'image', handleType: 'source',
  nextStep: { sourceValue, sourceLabel: 'Logo', sourceDefinitionId: 'nano-banana' } };
let previousGraph: GraphState;
let previousUi: ReturnType<typeof useUIStore.getState>;
let addConnected: ReturnType<typeof vi.fn<GraphState['addNodeAndConnect']>>;
let addNode: ReturnType<typeof vi.fn<GraphState['addNode']>>;
let connect: ReturnType<typeof vi.fn<GraphState['onConnect']>>;
let execution: ReturnType<typeof vi.fn>[];
let opener: HTMLButtonElement;
let menuSize: { width: number; height: number };
let observers: FakeResizeObserver[];

class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) { observers.push(this); }
  observe() {}
  disconnect() {}
  notify() { this.callback([], this as unknown as ResizeObserver); }
}

function node(id: string, definitionId = 'nano-banana', x = 100, y = 180): Node<NodeData> {
  return { id, type: 'model-node', position: { x, y }, measured: { width: 240, height: 300 },
    data: { label: id === 'n1' ? 'Logo' : id, definitionId, params: {}, state: 'idle', outputs: {} } };
}

function deferred<Value = string | null>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function openPopup(options: PopupOptions = popupOptions) {
  render(<ConnectionPopup />);
  opener.focus();
  act(() => useUIStore.getState().showConnectionPopup(options));
  act(() => vi.runOnlyPendingTimers());
  expect(screen.getByRole('textbox', { name: 'Search compatible nodes' })).toHaveFocus();
}

function choice(definitionId: string) {
  return within(screen.getByRole('dialog')).getByText(NODE_DEFINITIONS[definitionId].displayName, { exact: true })
    .closest<HTMLButtonElement>('button')!;
}

function searchFor(definitionId: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search compatible nodes' }),
    { target: { value: NODE_DEFINITIONS[definitionId].displayName } });
  return choice(definitionId);
}

function confirmConnectedStep(definitionId: string, nodePosition: { x: number; y: number },
  connection: Parameters<GraphState['addNodeAndConnect']>[2]) {
  const id = 'n9';
  useGraphStore.setState((state) => ({
    nodes: [...state.nodes, node(id, definitionId, nodePosition.x, nodePosition.y)],
    edges: [...state.edges, { id: 'next-edge',
      source: connection.newNodeIs === 'source' ? id : connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.newNodeIs === 'target' ? id : connection.target,
      targetHandle: connection.targetHandle }],
  }));
  return id;
}

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 300);
  observers = [];
  menuSize = { width: 320, height: 240 };
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('connection-popup')
      ? new DOMRect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 0,
        Math.min(menuSize.width, window.innerWidth - 16), Math.min(menuSize.height, window.innerHeight - 16))
      : new DOMRect();
  });
  flow.screenToFlowPosition.mockReset().mockImplementation(({ x, y }: { x: number; y: number }) => ({ x: x / 2, y: y / 2 }));
  // Every unexpected request is rejected locally. Lazy readiness tests opt into
  // exact saved-settings/status responses; no real accounts are contacted.
  reads.apiFetch.mockReset().mockRejectedValue(new Error('Unexpected read-only request'));
  addConnected = vi.fn<GraphState['addNodeAndConnect']>().mockResolvedValue(null);
  addNode = vi.fn<GraphState['addNode']>().mockResolvedValue(null);
  connect = vi.fn<GraphState['onConnect']>();
  execution = Array.from({ length: 8 }, () => vi.fn().mockResolvedValue(undefined));
  const source = node('n1');
  source.data.state = 'complete';
  source.data.outputs = { image: { type: 'Image', value: sourceValue } };
  useGraphStore.setState({ nodes: [source, node('n2', 'preview', 440, 180)],
    edges: [{ id: 'prior-edge', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'input' }],
    isExecuting: false, isImportingGraph: false, addNodeAndConnect: addConnected, addNode, onConnect: connect,
    executeGraph: execution[0], executeNode: execution[1], executeShot: execution[2], executeCluster: execution[3],
    executeClusterConcurrent: execution[4], rerunHistoryRecord: execution[5], rerunHistoryWithLatestPaperSource: execution[6],
    retryFailedRun: execution[7],
    runHistory: [{ id: 'prior-run', trigger: 'node', targetNodeId: 'n1', startedAt: 1, status: 'complete',
      snapshot: { nodes: [{ id: 'n1', definitionId: 'nano-banana', params: {}, outputs: {} }], edges: [] },
      resultOutputs: { n1: source.data.outputs } }],
  });
  useUIStore.setState({ selectedNodeId: 'n1', inspectorPinned: false, canvasFocusRequest: null,
    settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'api-token' },
    connectionPopup: { ...popupOptions, visible: false } });
  useUIStore.getState().setInspectorVisible(false);
  useUIStore.getState().setLeftDock('library');
  opener = document.createElement('button');
  opener.textContent = 'Add next step';
  document.body.append(opener);
});

afterEach(() => {
  execution.forEach((action) => expect(action).not.toHaveBeenCalled());
  for (const [path, options] of reads.apiFetch.mock.calls) {
    expect(['/api/settings', '/api/krea/connection']).toContain(path);
    expect((options as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
  }
  cleanup();
  opener.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

describe('ConnectionPopup next-step preparation', () => {
  it('reads saved readiness lazily using only settings and Krea-status GETs, with no checks or preparation', async () => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
    reads.apiFetch.mockResolvedValueOnce(response({ apiKeys: { FAL_KEY: '***fixture' }, kreaConnectionMode: 'mcp' }))
      .mockResolvedValueOnce(response({ status: 'connected', tools: ['generate'] }));
    expect(reads.apiFetch).not.toHaveBeenCalled();
    openPopup();
    await act(async () => {});
    expect(reads.apiFetch.mock.calls).toEqual([
      ['/api/settings'], ['/api/krea/connection', { method: 'GET' }],
    ]);
    expect(useUIStore.getState().settingsCache).toMatchObject({ loaded: true,
      apiKeys: { FAL_KEY: '***fixture' }, kreaConnectionMode: 'mcp',
      kreaConnection: { status: 'connected', tools: ['generate'] } });
    expect(addConnected).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search compatible nodes' }), { key: 'Escape' });
    act(() => useUIStore.getState().showConnectionPopup(popupOptions));
    act(() => vi.runOnlyPendingTimers());
    await act(async () => {});
    expect(reads.apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer loaded cache when a saved-settings read completes late', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    reads.apiFetch.mockReturnValueOnce(pending.promise);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
    openPopup();
    act(() => useUIStore.getState().setSettingsCache({ FAL_KEY: '***new-fixture' }, 'api-token'));
    const current = useUIStore.getState().settingsCache;
    await act(async () => { pending.resolve(response({ apiKeys: { FAL_KEY: '***old-fixture' }, kreaConnectionMode: 'mcp' })); });
    expect(useUIStore.getState().settingsCache).toBe(current);
    expect(reads.apiFetch.mock.calls).toEqual([['/api/settings']]);
    expect(addConnected).not.toHaveBeenCalled();
  });

  it('keeps newer account status when a previous Krea-status read completes late', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    reads.apiFetch.mockResolvedValueOnce(response({ apiKeys: {}, kreaConnectionMode: 'mcp' }))
      .mockReturnValueOnce(pending.promise);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
    openPopup();
    await act(async () => {});
    expect(reads.apiFetch).toHaveBeenCalledTimes(2);
    act(() => {
      useUIStore.getState().setSettingsCache({ KREA_API_TOKEN: '***new-fixture' }, 'api-token');
      useUIStore.getState().setKreaConnection({ status: 'disconnected' });
    });
    const current = useUIStore.getState().settingsCache;
    await act(async () => { pending.resolve(response({ status: 'connected', tools: ['generate'] })); });
    expect(useUIStore.getState().settingsCache).toBe(current);
    expect(useUIStore.getState().settingsCache.kreaConnection).toEqual({ status: 'disconnected' });
    expect(addConnected).not.toHaveBeenCalled();
  });

  it('filters the real image catalog by intent and preserves model/provider search', () => {
    openPopup();
    expect(screen.getByText('Prepare a connected node. Run when ready.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Utility/ }));
    expect(choice('preview')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit image' }));
    expect(choice('nano-banana')).toBeVisible();
    expect(screen.queryByText(NODE_DEFINITIONS['veo-3'].displayName, { exact: true })).toBeNull();
    expect(screen.queryByText(NODE_DEFINITIONS.preview.displayName, { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use in video' }));
    expect(choice('veo-3')).toBeVisible();
    expect(screen.queryByText(NODE_DEFINITIONS['nano-banana'].displayName, { exact: true })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search compatible nodes' }),
      { target: { value: 'google animation' } });
    expect(choice('veo-3')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search compatible nodes' }),
      { target: { value: 'model-that-does-not-exist' } });
    expect(screen.getByText('No compatible nodes found')).toBeVisible();
    expect(addConnected).not.toHaveBeenCalled();
  });

  it.each(['changed output', 'alternate batch preview', 'running source'])('rejects a %s before preparing a step', async (kind) => {
    openPopup(kind === 'alternate batch preview'
      ? { ...popupOptions, nextStep: { sourceValue: '/outputs/alternate-logo.png', sourceLabel: 'Logo' } }
      : popupOptions);
    const item = searchFor('veo-3');
    if (kind !== 'alternate batch preview') act(() => useGraphStore.setState((state) => ({
      nodes: state.nodes.map((existing) => existing.id !== 'n1' ? existing : { ...existing,
        data: { ...existing.data, state: kind === 'running source' ? 'executing' : 'complete',
          outputs: { image: { type: 'Image', value: kind === 'changed output' ? '/outputs/new-logo.png' : sourceValue } } } }),
    })));
    await act(async () => { fireEvent.click(item); });
    expect(addConnected).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add next step' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('This result changed');
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
  });

  it('rejects a retyped source even when its node ID, completed state, and result URL are unchanged', async () => {
    openPopup();
    const item = searchFor('veo-3');
    act(() => useGraphStore.setState((state) => ({
      nodes: state.nodes.map((existing) => existing.id !== 'n1' ? existing : { ...existing,
        data: { ...existing.data, definitionId: 'gpt-image-1-generate' } }),
    })));
    await act(async () => { fireEvent.click(item); });
    expect(screen.getByRole('alert')).toHaveTextContent('This result changed');
    expect(addConnected).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
  });

  it('accepts only one repeated click while creation is pending', async () => {
    const pending = deferred();
    addConnected.mockReturnValue(pending.promise);
    openPopup();
    const item = searchFor('veo-3');
    fireEvent.click(item);
    fireEvent.click(item);
    expect(addConnected).toHaveBeenCalledTimes(1);
    expect(item).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Adding connected step');
    expect(screen.getByRole('button', { name: 'Use in video' })).toBeDisabled();
    await act(async () => { pending.resolve(null); });
    expect(item).toBeEnabled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
  });

  it('keeps the picker and original canvas/history intact when no connected node is confirmed', async () => {
    openPopup();
    const before = useGraphStore.getState();
    await act(async () => { fireEvent.click(searchFor('veo-3')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm the connected step');
    expect(screen.getByRole('dialog', { name: 'Add next step' })).toBeVisible();
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(useGraphStore.getState().edges).toBe(before.edges);
    expect(useGraphStore.getState().runHistory).toBe(before.runHistory);
    expect(useUIStore.getState().leftDock).toBe('library');
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(useUIStore.getState().panels.inspector.visible).toBe(false);
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
  });

  it('reports a rejected creation and restores controls for review', async () => {
    addConnected.mockRejectedValue(new Error('Lost connection'));
    openPopup();
    const item = searchFor('veo-3');
    await act(async () => { fireEvent.click(item); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not add the step');
    expect(item).toBeEnabled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
    expect(useUIStore.getState().connectionPopup.visible).toBe(true);
  });

  it('hands a confirmed idle step to Canvas and Inspector while preserving the original result and run', async () => {
    addConnected.mockImplementation(async (definitionId, nodePosition, connection) =>
      confirmConnectedStep(definitionId, nodePosition, connection));
    openPopup();
    const before = useGraphStore.getState();
    await act(async () => { fireEvent.click(searchFor('veo-3')); });
    expect(addConnected).toHaveBeenCalledExactlyOnceWith('veo-3', { x: 440, y: 520 }, {
      source: 'n1', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target',
    });
    expect(addNode).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    const graph = useGraphStore.getState();
    expect(graph.nodes.find((item) => item.id === 'n9')).toMatchObject({ selected: true,
      data: { state: 'idle', outputs: {} } });
    expect(graph.nodes[0].data.outputs).toBe(before.nodes[0].data.outputs);
    expect(graph.edges).toContainEqual(before.edges[0]);
    expect(graph.runHistory).toBe(before.runHistory);
    const ui = useUIStore.getState();
    expect(ui.selectedNodeId).toBe('n9');
    expect(ui.canvasFocusRequest).toMatchObject({ nodeId: 'n9' });
    expect(ui.leftDock).toBeNull();
    expect(ui.panels.inspector.visible).toBe(true);
  });

  it('does not dismiss or focus over a newer picker when an old preparation finishes', async () => {
    const pending = deferred();
    addConnected.mockReturnValue(pending.promise);
    openPopup();
    fireEvent.click(searchFor('veo-3'));
    act(() => useUIStore.getState().showConnectionPopup({ ...popupOptions, position: { x: 20, y: 20 },
      nextStep: { sourceValue, sourceLabel: 'A newer picker' } }));
    act(() => vi.runOnlyPendingTimers());
    const newer = useUIStore.getState().connectionPopup;
    await act(async () => { pending.resolve('n9'); });
    expect(useUIStore.getState().connectionPopup).toBe(newer);
    expect(screen.getByText('From A newer picker · Image')).toBeVisible();
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(useUIStore.getState().panels.inspector.visible).toBe(false);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false');
  });

  it('restores focus to the opener on Escape from search without preparing or running anything', () => {
    openPopup();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search compatible nodes' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(useUIStore.getState().selectedNodeId).toBe('n1');
    expect(addConnected).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
  });

  it.each(['source', 'target'] as const)('bounds a dragged %s picker without changing the original drop destination or wire direction', async (direction) => {
    openPopup({ position, nodeId: 'n1', handleType: direction,
      handleId: direction === 'source' ? 'image' : 'prompt' });
    const dialog = screen.getByRole('dialog', { name: 'Compatible nodes' });
    expect(parseFloat(dialog.style.left) + menuSize.width).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(dialog.style.top) + menuSize.height).toBeLessThanOrEqual(window.innerHeight);
    menuSize.height = 180;
    act(() => observers.forEach((observer) => observer.notify()));
    vi.stubGlobal('innerWidth', 600);
    vi.stubGlobal('innerHeight', 250);
    fireEvent(window, new Event('resize'));
    expect(parseFloat(dialog.style.left) + menuSize.width).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(dialog.style.top) + menuSize.height).toBeLessThanOrEqual(window.innerHeight);
    expect(useUIStore.getState().connectionPopup.position).toEqual(position);
    await act(async () => { fireEvent.click(searchFor(direction === 'source' ? 'nano-banana' : 'text-input')); });
    expect(flow.screenToFlowPosition).toHaveBeenCalledExactlyOnceWith(position);
    expect(addConnected).toHaveBeenCalledExactlyOnceWith(direction === 'source' ? 'nano-banana' : 'text-input',
      { x: 390, y: 140 }, direction === 'source'
        ? { source: 'n1', sourceHandle: 'image', target: '', targetHandle: 'images', newNodeIs: 'target' }
        : { source: '', sourceHandle: 'text', target: 'n1', targetHandle: 'prompt', newNodeIs: 'source' });
    expect(screen.queryByRole('button', { name: 'Use in video' })).toBeNull();
  });
});
