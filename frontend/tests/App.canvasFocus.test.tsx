import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const mocks = vi.hoisted(() => ({ fitView: vi.fn(), fetchGraph: vi.fn() }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({ fitView: mocks.fitView }),
}));
vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({ api_keys: {}, krea_connection_mode: 'api-token' }),
  fetchCLIGraph: mocks.fetchGraph,
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/hooks/useCommonsCapability', () => ({ useCommonsCapability: vi.fn() }));
vi.mock('../src/components/Canvas', () => ({ Canvas: () => null }));
vi.mock('../src/components/CanvasTabs', () => ({ CanvasTabs: () => null }));
vi.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: () => null }));
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({ NodeInspectorPopover: () => null }));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../src/components/create-studio/CreateView', () => ({ CreateView: () => null }));
import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
function node(): Node<NodeData> {
  return { id: 'motion', position: { x: 1000, y: 1000 },
    data: { label: 'Motion', definitionId: 'text', params: {}, state: 'idle', outputs: {} } };
}
function deferredGraph() {
  let resolve!: (value: { empty: boolean; nodes: Node<NodeData>[]; edges: [] }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ empty: boolean; nodes: Node<NodeData>[]; edges: [] }>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

type EmptyOutcome = 'empty response' | 'failed request';
async function settleEmptyGraph(graph: ReturnType<typeof deferredGraph>, outcome: EmptyOutcome) {
  await act(async () => {
    if (outcome === 'empty response') graph.resolve({ empty: true, nodes: [], edges: [] });
    else graph.reject(new Error('Fixture backend unavailable'));
    await graph.promise.catch(() => {});
  });
}

describe('initial graph hydration yields to Canvas focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fitView.mockReset().mockResolvedValue(true);
    mocks.fetchGraph.mockReset().mockResolvedValue({ empty: false, nodes: [node()], edges: [] });
    useUIStore.setState(initialUI, true);
    useUIStore.setState({ viewMode: 'canvas', hasOnboarded: false, onboardingActive: false, onboardingStep: 0 });
    useGraphStore.setState({ nodes: [], edges: [], isExecuting: false,
      providerRecoveries: [], providerStartAmbiguities: [], runHistory: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
    vi.restoreAllMocks();
  });

  it('fits the hydrated graph when no explicit handoff occurred', async () => {
    await act(async () => { render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.fitView).toHaveBeenCalledTimes(1);
  });

  it('a scheduled hydration fit cannot replace a handoff that has already completed', async () => {
    await act(async () => { render(<App />); });
    act(() => {
      useUIStore.getState().requestCanvasNodeFocus('motion');
      const request = useUIStore.getState().canvasFocusRequest!;
      useUIStore.getState().clearCanvasNodeFocus(request.requestId);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.fitView).not.toHaveBeenCalled();
  });

  it('a handoff during the pending hydration request also suppresses the eventual fit', async () => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    await act(async () => { render(<App />); });
    act(() => { useUIStore.getState().requestCanvasNodeFocus('motion'); });
    await act(async () => { graph.resolve({ empty: false, nodes: [node()], edges: [] }); await graph.promise; });
    const request = useUIStore.getState().canvasFocusRequest!;
    act(() => { useUIStore.getState().clearCanvasNodeFocus(request.requestId); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.fitView).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes.some(({ id }) => id === 'motion')).toBe(true);
  });

  it('a pre-mount handoff stays authoritative after its request is consumed', async () => {
    useUIStore.getState().requestCanvasNodeFocus('motion');
    await act(async () => { render(<App />); });
    act(() => {
      const request = useUIStore.getState().canvasFocusRequest!;
      useUIStore.getState().clearCanvasNodeFocus(request.requestId);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.fitView).not.toHaveBeenCalled();
  });

  it('does not fit a viewport after App unmounts', async () => {
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<App />); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(mocks.fitView).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('starts first-run onboarding on an untouched empty Canvas after %s', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    await act(async () => { render(<App />); });
    await settleEmptyGraph(graph, outcome);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', onboardingActive: true, onboardingStep: 0, hasOnboarded: false });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mocks.fitView).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('preserves work added while startup waits for %s', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    await act(async () => { render(<App />); });
    const authored = [node()];
    const edges = [{ id: 'retained-edge', source: 'motion', target: 'motion', sourceHandle: 'text', targetHandle: 'text' }];
    act(() => {
      useGraphStore.setState({ nodes: authored, edges });
      useUIStore.getState().setLeftDock('history');
      useUIStore.setState({ selectedNodeId: 'motion', inspectorPinned: true, chatResized: true });
    });
    const panels = useUIStore.getState().panels;
    await settleEmptyGraph(graph, outcome);
    expect(useGraphStore.getState().nodes).toBe(authored);
    expect(useGraphStore.getState().edges).toBe(edges);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', selectedNodeId: 'motion', leftDock: 'history', inspectorPinned: true, chatResized: true, onboardingActive: false });
    expect(useUIStore.getState().panels).toBe(panels);
    expect(reset).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('preserves a newly opened studio while startup waits for %s', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    await act(async () => { render(<App />); });
    act(() => {
      useUIStore.getState().setLeftDock('settings');
      useUIStore.setState({ viewMode: 'create', createSessionId: 'unsent-create-session' });
    });
    const panels = useUIStore.getState().panels;
    await settleEmptyGraph(graph, outcome);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'create', createSessionId: 'unsent-create-session', leftDock: 'settings', onboardingActive: false });
    expect(useUIStore.getState().panels).toBe(panels);
    expect(reset).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('preserves an active optional tour during %s', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    await act(async () => { render(<App />); });
    act(() => {
      useUIStore.getState().startOnboarding();
      useUIStore.getState().nextOnboardingStep();
      useUIStore.getState().nextOnboardingStep();
      useUIStore.getState().setLeftDock('history');
    });
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    const panels = useUIStore.getState().panels;
    await settleEmptyGraph(graph, outcome);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', onboardingActive: true, onboardingStep: 2, leftDock: 'history' });
    expect(useUIStore.getState().panels).toBe(panels);
    expect(reset).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('preserves a completed-tour user’s empty Canvas layout after %s', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    await act(async () => { render(<App />); });
    act(() => {
      useUIStore.setState({ hasOnboarded: true });
      useUIStore.getState().setLeftDock('settings');
    });
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    const panels = useUIStore.getState().panels;
    await settleEmptyGraph(graph, outcome);
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'canvas', hasOnboarded: true, onboardingActive: false, leftDock: 'settings' });
    expect(useUIStore.getState().panels).toBe(panels);
    expect(reset).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each<EmptyOutcome>(['empty response', 'failed request'])('ignores a stale %s after unmount', async (outcome) => {
    const graph = deferredGraph();
    mocks.fetchGraph.mockReturnValue(graph.promise);
    const reset = vi.spyOn(useUIStore.getState(), 'resetPanelsForFreshCanvas');
    const start = vi.spyOn(useUIStore.getState(), 'startOnboarding');
    const view = render(<App />);
    view.unmount();
    await settleEmptyGraph(graph, outcome);
    expect(reset).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(useUIStore.getState().onboardingActive).toBe(false);
  });
});
