import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM - Design, 2026-10-23: "Floating panels stop below the workspace header
 * and the selection toolbar, whichever is lower, plus the same 8 px gap."
 *
 * The toolbar enters with `selection-toolbar-in` (translateY(-6px) scale(0.98)
 * to none), and getBoundingClientRect includes a transform. Measured on the
 * toolbar itself, the line starts about 6 px high and eases down, and a
 * top-clamped Inspector slides with it. The line is the toolbar's layout box:
 * React Flow's Panel around it, which never moves.
 */

vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    // The real Panel (it passes extra props to its div); only the flow is a stand-in.
    ReactFlow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Background: () => null,
    useReactFlow: () => ({ fitView: vi.fn(), viewportInitialized: false, screenToFlowPosition: (point: unknown) => point }),
    useInternalNode: () => undefined,
    useStore: () => 1,
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});
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
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { floatingTopLimit } from '../src/lib/bottomBar';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const node = (id: string, selected = false): Node<NodeData> => ({ id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, state: 'idle', outputs: {} } });

describe('the selection toolbar\'s top line', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useUIStore.setState(initialUI, true);
    useGraphStore.setState({ nodes: [node('n1', true)], edges: [], isExecuting: false });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('is read from the panel\'s layout box, never from the toolbar its entry animation moves', async () => {
    await act(async () => { render(<Canvas />); });
    const toolbar = document.querySelector<HTMLElement>('.selection-toolbar');
    const panel = document.querySelector<HTMLElement>('.selection-toolbar-panel');
    expect(toolbar).not.toBeNull();
    expect(panel?.contains(toolbar!)).toBe(true);
    expect(toolbar!.hasAttribute('data-top-bar')).toBe(false);
    expect(panel!.hasAttribute('data-top-bar')).toBe(true);

    // First frame of the entry: the toolbar is drawn 6 px high (and 0.98
    // scaled), the panel holds its layout box, 92 to 140.
    const rect = (x: number, y: number, width: number, height: number) => new DOMRect(x, y, width, height);
    vi.spyOn(panel!, 'getBoundingClientRect').mockReturnValue(rect(365, 92, 550, 48));
    vi.spyOn(toolbar!, 'getBoundingClientRect').mockReturnValue(rect(370.5, 86.5, 539, 47));
    expect(floatingTopLimit(16)).toBe(148);
  });

  it('with nothing selected the panel is empty and sets no line', async () => {
    useGraphStore.setState({ nodes: [node('n1')] });
    await act(async () => { render(<Canvas />); });
    const panel = document.querySelector<HTMLElement>('.selection-toolbar-panel')!;
    expect(panel.querySelector('.selection-toolbar')).toBeNull();
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(640, 92, 0, 0));
    expect(floatingTopLimit(16)).toBe(16);
  });
});
