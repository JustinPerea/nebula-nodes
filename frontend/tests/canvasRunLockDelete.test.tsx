import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const flow = vi.hoisted(() => ({
  fitView: vi.fn(), initialized: false,
  internalNodes: new Map<string, { measured: { width?: number; height?: number } }>(),
  fitProp: true,
}));
// The roster store (brought in with the agent mark layer) reads the roster on
// mount and on a graph replacement. The read never answers here: no request
// goes out (tests/setup.ts) and the roster stays empty, with no update after a test.
vi.mock('../src/lib/agentRoster', async (original) => ({
  ...await original<typeof import('../src/lib/agentRoster')>(),
  fetchAgentRoster: () => new Promise(() => {}),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  // Selectors run against an empty 1280x800 flow, fresh each test (tests/helpers/fakeFlowStore.ts).
  const { fakeFlow } = await import('./helpers/fakeFlowStore');
  return {
    ...original,
    ReactFlow: ({ children, fitView }: { children: React.ReactNode; fitView: boolean }) => {
      flow.fitProp = fitView;
      return <div>{children}</div>;
    },
    Background: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useReactFlow: () => ({
      fitView: flow.fitView, viewportInitialized: flow.initialized,
      screenToFlowPosition: (point: unknown) => point,
      // #195's Delete key reads the selection from React Flow (the merge).
      getNodes: () => useGraphStore.getState().nodes,
      getEdges: () => useGraphStore.getState().edges,
    }),
    useInternalNode: (id: string) => flow.internalNodes.get(id),
    useStore: fakeFlow.useStore,
    // Fit view reads the canvas size to frame open proposals' ghosts (useFitCanvasView).
    useStoreApi: fakeFlow.useStoreApi,
  };
});
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/ArrangeController', () => ({ ArrangeController: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { quietConsole, installFakeFlowStore } from './helpers/fakeFlowStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';

/**
 * PR #198 fix round 4, M1 (review 4): React Flow's own Delete key is off
 * while this tab runs something (deleteKeyCode null), so the key was silent.
 * The canvas's shortcut handler now hands it to deleteSelected, which says
 * why the run lock keeps the nodes. The run is a real executeShot, as the
 * app starts it (isExecuting true), not a hand-set activeRuns.
 */

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();

const scene = { id: 'n4', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, selected: false,
  data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
    params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
      shots: [{ id: 's1', prompt: 'a' }, { id: 's2', prompt: 'b' }] } } } } as unknown as Node<NodeData>;
const brief = { id: 'n5', type: 'model-node', position: { x: 300, y: 0 }, selected: true,
  data: { label: 'Brief', definitionId: 'text-input', params: { text: '' }, state: 'idle', outputs: {} } } as unknown as Node<NodeData>;

// The canvas's store-reading layers draw in every test, and a test fails if one
// crashes on the fake store's answers.
installFakeFlowStore();
describe('M1: the Delete key during the tab\'s own run', () => {
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/api/cinema/generate-shot')
      ? json({ status: 'started', runId: 'own-run' }) : json({})));
    resetBackendConnectionForTests();
    // Quiet, but a canvas layer that crashes still fails the test (fakeFlowStore.ts).
    quietConsole();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useUIStore.setState(initialUI, true);
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [scene, brief], edges: [], undoNotice: null, undoStack: [], redoStack: [],
      providerRecoveries: [], providerStartAmbiguities: [], isImportingGraph: false, runHistory: [] } as never);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useGraphStore.getState().resetExecution();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('says "Couldn’t delete “Brief”. Wait for the active run to finish." and keeps the node', async () => {
    await act(async () => {
      void useGraphStore.getState().executeShot('n4', 's2');
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(useGraphStore.getState().isExecuting).toBe(true);
    render(<Canvas />);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    expect(useGraphStore.getState().undoNotice?.text).toBe("Couldn’t delete “Brief”. Wait for the active run to finish.");
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n4', 'n5']);
    act(() => { useGraphStore.setState({ undoNotice: null } as never); });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })); });
    expect(useGraphStore.getState().undoNotice?.text).toBe("Couldn’t delete “Brief”. Wait for the active run to finish.");
  });

  // Merged with #195: the canvas's handler owns the Delete key (React Flow's
  // deleteKeyCode is off), so with no run it deletes the selection through
  // the store, with no run-lock line.
  it('with no run, the key deletes the selection, with no run-lock line', () => {
    render(<Canvas />);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    expect(useGraphStore.getState().undoNotice?.text ?? '').not.toMatch(/active run/);
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toEqual(['n4']);
  });
});
