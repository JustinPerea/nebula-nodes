import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const flow = vi.hoisted(() => ({
  fitView: vi.fn(), initialized: false,
  internalNodes: new Map<string, { measured: { width?: number; height?: number } }>(),
  fitProp: true,
  props: {} as Record<string, (...args: unknown[]) => void>,
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    ReactFlow: (props: { children: React.ReactNode; fitView: boolean }) => {
      flow.fitProp = props.fitView;
      flow.props = props as unknown as Record<string, (...args: unknown[]) => void>;
      return <div>{props.children}</div>;
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
    useStore: () => 1,
    // Fit view reads the canvas size to frame open proposals' ghosts (useFitCanvasView).
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }), setState: () => {} }),
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
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

/**
 * PR #205 round 3 on the canvas itself:
 * - GM r4 item 4: Cmd+Enter while a wait holds Run says the palette's line
 *   in the key presses' place: "You can run the canvas when the run
 *   finishes." (an import's: "… when the import finishes.").
 * - GM r4 item 3 (review 2 lines NIT-1): a wire dropped on empty canvas
 *   during a run opens the node picker, as with no run; nothing is said.
 */
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const brief = { id: 'n5', type: 'model-node', position: { x: 300, y: 0 }, selected: false,
  data: { label: 'Brief', definitionId: 'text-input', params: { text: '' }, state: 'idle', outputs: {} } } as unknown as Node<NodeData>;
const press = (init: KeyboardEventInit) => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });

describe('PR #205 round 3: the canvas during a run', () => {
  let execute: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useUIStore.setState(initialUI, true);
    execute = vi.fn();
    useGraphStore.setState({ nodes: [brief], edges: [], undoNotice: null, undoStack: [], redoStack: [], isExecuting: false,
      runStarting: false, isImportingGraph: false, executeGraph: execute, providerRecoveries: [], providerStartAmbiguities: [] } as never);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it.each([
    ['this tab\'s run', { isExecuting: true }, 'You can run the canvas when the run finishes.'],
    ['its start', { runStarting: true }, 'You can run the canvas when the run finishes.'],
    ['an import', { isImportingGraph: true }, 'You can run the canvas when the import finishes.'],
  ] as const)('Cmd+Enter during %s: the line, and nothing runs', (_label, state, line) => {
    useGraphStore.setState(state as never);
    render(<Canvas />);
    press({ key: 'Enter', metaKey: true });
    expect(useGraphStore.getState().undoNotice?.text).toBe(line);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Cmd+Enter with nothing waiting runs the canvas and says nothing', () => {
    render(<Canvas />);
    press({ key: 'Enter', metaKey: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  // Review 4 of PR #205, NIT-2 (GM r6 item 6; MCP-SETUP says so): Create's
  // launch doesn't hold Cmd+Enter, as it doesn't the toolbar's Run.
  it('Cmd+Enter during Create\'s launch runs the canvas and says nothing', () => {
    useGraphStore.setState({ createLaunchingIds: ['x'] } as never);
    render(<Canvas />);
    press({ key: 'Enter', metaKey: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('a wire dropped on empty canvas during a run opens the node picker, with no line', () => {
    useGraphStore.setState({ isExecuting: true } as never);
    document.elementsFromPoint = () => [];
    render(<Canvas />);
    act(() => { flow.props.onConnectStart?.({}, { nodeId: 'n5', handleId: 'text', handleType: 'source' }); });
    act(() => { flow.props.onConnectEnd?.({ clientX: 500, clientY: 300, target: document.body }, { toHandle: null, toNode: null, isValid: null }); });
    expect(useUIStore.getState().connectionPopup?.visible).toBe(true);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });
});
