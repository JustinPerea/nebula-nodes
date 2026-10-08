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
  const promise = new Promise<{ empty: boolean; nodes: Node<NodeData>[]; edges: [] }>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('initial graph hydration yields to Canvas focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fitView.mockReset().mockResolvedValue(true);
    mocks.fetchGraph.mockReset().mockResolvedValue({ empty: false, nodes: [node()], edges: [] });
    useUIStore.setState(initialUI, true);
    useGraphStore.setState({ nodes: [], edges: [], isExecuting: false,
      providerRecoveries: [], providerStartAmbiguities: [], runHistory: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
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
});
