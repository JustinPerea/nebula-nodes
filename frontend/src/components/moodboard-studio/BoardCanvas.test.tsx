import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Node, NodeChange } from '@xyflow/react';
import type { MoodboardImage, MoodboardPlacement } from '../../types';

// The Board view's canvas (moodboard canvas PR5), with React Flow replaced by
// a stand-in that keeps the props it was given: the cards sit where the
// server put them, a drag is one move when it ends, and selection lives in
// boardCanvasStore so the side panel (outside the canvas) can read it.

type FlowProps = {
  nodes: Node[];
  onNodesChange: (changes: NodeChange[]) => void;
  onNodeDragStart?: (event: unknown, node: Node, nodes: Node[]) => void;
  onNodeDragStop: (event: unknown, node: Node, nodes: Node[]) => void;
  onSelectionDragStop?: (event: unknown, nodes: Node[]) => void;
  onlyRenderVisibleElements?: boolean;
  deleteKeyCode?: unknown;
  panOnScroll?: boolean;
  selectionOnDrag?: boolean;
  children?: ReactNode;
};
const flow = vi.hoisted(() => ({ props: null as FlowProps | null, setViewport: vi.fn(), fitView: vi.fn(),
  getNodesBounds: vi.fn<(nodes: unknown[]) => { x: number; y: number; width: number; height: number }>(
    () => ({ x: 0, y: 0, width: 100, height: 100 })) }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: (props: FlowProps) => { flow.props = props; return <div data-testid="flow">{props.children}</div>; },
  Background: () => null,
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 }),
    setViewport: flow.setViewport, fitView: flow.fitView,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodesBounds: flow.getNodesBounds,
  }),
  useStoreApi: () => ({ getState: () => ({ width: 1000, height: 700, minZoom: 0.1, maxZoom: 2 }), subscribe: () => () => {} }),
}));
// The camera's spring, recorded: each move and the cancel it returned.
const spring = vi.hoisted(() => ({ calls: [] as Array<{ to: { x: number; y: number; zoom: number }; cancel: () => void }> }));
vi.mock('../../lib/viewportSpring', () => ({
  springViewport: (_from: unknown, to: { x: number; y: number; zoom: number }) => {
    const cancel = vi.fn();
    spring.calls.push({ to, cancel });
    return cancel;
  },
}));

import { BoardCanvas, type BoardMove } from './BoardCanvas';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { CANVAS_INTERACTION_PROPS } from '../../lib/canvasNavigation';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';

const card = (id: string, x: number, y: number, extra: Partial<MoodboardPlacement> = {}): MoodboardPlacement => ({
  id, frameId: null, x, y, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '', ...extra });
const image = (id: string, placements: MoodboardPlacement[], extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements, ...extra });

const images = [
  image('i1', [card('c1', 0, 0)]),
  image('i2', [card('c2', 520, 0)]),
  image('i3', [card('c3', 1040, 0, { w: 312, h: 416 })], { excluded: true }),
];

let moves: BoardMove[][] = [];
let drops: Array<{ files: File[]; at: { x: number; y: number } }> = [];
function mount(list = images) {
  return render(<BoardCanvas boardKey="k1" images={list} onMove={(next) => moves.push(next)}
    onDropFiles={(files, at) => drops.push({ files, at })} />);
}
const props = () => flow.props!;
const nodeById = (id: string) => props().nodes.find((node) => node.id === id)!;

beforeEach(() => {
  flow.props = null;
  moves = [];
  drops = [];
  useBoardCanvasStore.setState({ selection: {}, viewports: {}, frameRequest: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the cards', () => {
  it('sit where the server placed them, at their saved size, in board order', () => {
    mount();
    expect(props().nodes.map((node) => [node.id, node.position.x, node.position.y, node.width, node.height]))
      .toEqual([['c1', 0, 0, 480, 270], ['c2', 520, 0, 480, 270], ['c3', 1040, 0, 312, 416]]);
    expect(props().nodes.map((node) => (node.data as { number: number }).number)).toEqual([1, 2, 3]);
    expect(nodeById('c3').ariaLabel).toBe('Reference #3, set aside');
  });

  it('use the canvas interaction, render only what is in view, and leave Delete to the Studio', () => {
    mount();
    expect(props()).toMatchObject(CANVAS_INTERACTION_PROPS);
    expect(props().onlyRenderVisibleElements).toBe(true);
    expect(props().deleteKeyCode).toBeNull();
  });

  it('an image with no card yet (not saved) is not drawn', () => {
    mount([image('i1', [card('c1', 0, 0)]), { ...image('i2', []), placements: undefined }]);
    expect(props().nodes.map((node) => node.id)).toEqual(['c1']);
  });

  it('a card that did not change keeps its node, so React Flow skips it', () => {
    const view = mount();
    const before = nodeById('c1');
    view.rerender(<BoardCanvas boardKey="k1" images={[images[0], image('i2', [card('c2', 600, 0)]), images[2]]}
      onMove={() => {}} onDropFiles={() => {}} />);
    expect(nodeById('c1')).toBe(before);
    expect(nodeById('c2').position).toEqual({ x: 600, y: 0 });
  });
});

describe('a drag', () => {
  it('is one move when it ends, never one per frame', () => {
    mount();
    act(() => {
      for (const x of [10, 60, 140.6]) {
        props().onNodesChange([{ type: 'position', id: 'c1', position: { x, y: 39.4 }, dragging: true }]);
      }
    });
    expect(nodeById('c1').position).toEqual({ x: 140.6, y: 39.4 });
    expect(moves).toEqual([]);
    act(() => props().onNodeDragStop({}, nodeById('c1'), [nodeById('c1')]));
    expect(moves).toEqual([[{ placement: 'c1', x: 141, y: 39 }]]);
  });

  it('moves every dragged card in the one step', () => {
    mount();
    act(() => props().onNodesChange([
      { type: 'position', id: 'c1', position: { x: 0, y: 200 }, dragging: true },
      { type: 'position', id: 'c2', position: { x: 520, y: 200 }, dragging: true },
    ]));
    act(() => props().onNodeDragStop({}, nodeById('c1'), [nodeById('c1'), nodeById('c2')]));
    expect(moves).toEqual([[{ placement: 'c1', x: 0, y: 200 }, { placement: 'c2', x: 520, y: 200 }]]);
  });

  it('that ends where it began moves nothing', () => {
    mount();
    act(() => props().onNodesChange([{ type: 'position', id: 'c1', position: { x: 0.3, y: -0.2 }, dragging: true }]));
    act(() => props().onNodeDragStop({}, nodeById('c1'), [nodeById('c1')]));
    expect(moves).toEqual([]);
  });

  it('arrow keys move the selected cards: one move once the keys stop', () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      props().onNodesChange([{ type: 'position', id: 'c2', position: { x: 525, y: 0 }, dragging: false }]);
      props().onNodesChange([{ type: 'position', id: 'c2', position: { x: 530, y: 0 }, dragging: false }]);
    });
    act(() => { vi.advanceTimersByTime(100); });
    expect(moves).toEqual([]);
    act(() => { vi.advanceTimersByTime(600); });
    expect(moves).toEqual([[{ placement: 'c2', x: 530, y: 0 }]]);
  });
});

describe('selection', () => {
  it('is kept per board in boardCanvasStore and drawn on the cards', () => {
    mount();
    act(() => props().onNodesChange([{ type: 'select', id: 'c2', selected: true }]));
    expect(useBoardCanvasStore.getState().selection.k1).toEqual(['c2']);
    expect(nodeById('c2').selected).toBe(true);
    act(() => props().onNodesChange([{ type: 'select', id: 'c2', selected: false }, { type: 'select', id: 'c1', selected: true }]));
    expect(useBoardCanvasStore.getState().selection.k1).toEqual(['c1']);
  });

  it('forgets cards that left the board', () => {
    useBoardCanvasStore.getState().setSelection('k1', ['c1', 'gone']);
    mount();
    expect(useBoardCanvasStore.getState().selection.k1).toEqual(['c1']);
  });
});

describe('files dropped on the board', () => {
  it('land at the pointer, in board coordinates', () => {
    const view = mount();
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const target = view.container.querySelector('.moodboard-board')!;
    // jsdom has no DragEvent, so the pointer is set on the event by hand.
    const drop = createEvent.drop(target, { dataTransfer: { files: [file, text], types: ['Files'] } });
    Object.defineProperties(drop, { clientX: { value: 100 }, clientY: { value: 40 } });
    fireEvent(target, drop);
    expect(drops).toEqual([{ files: [file], at: { x: 200, y: 80 } }]);
  });
});

describe('the Add images button', () => {
  it('adds the chosen files in the middle of what the person sees', () => {
    const view = mount();
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 }) as DOMRect;
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [file] } });
    // Screen middle (310, 220), doubled by the stand-in screenToFlowPosition.
    expect(drops).toEqual([{ files: [file], at: { x: 620, y: 440 } }]);
  });

  it('is off while files upload', () => {
    const view = render(<BoardCanvas boardKey="k1" images={images} uploading onMove={() => {}} onDropFiles={() => {}} />);
    expect((view.getByLabelText('Add images') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('the camera', () => {
  it('fits the board with Fit and with Shift+1, on a spring', () => {
    spring.calls = [];
    const view = mount();
    fireEvent.click(view.getByRole('button', { name: 'Fit the board' }));
    expect(spring.calls).toHaveLength(1);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true, bubbles: true })); });
    expect(spring.calls).toHaveLength(2);
    expect(spring.calls[1].to).toEqual(spring.calls[0].to);
  });

  it('a new move stops the one still running, so two springs never pull the view', () => {
    spring.calls = [];
    const view = mount();
    fireEvent.click(view.getByRole('button', { name: 'Fit the board' }));
    fireEvent.click(view.getByRole('button', { name: 'Zoom in' }));
    expect(spring.calls[0].cancel).toHaveBeenCalledTimes(1);
    expect(spring.calls[1].cancel).not.toHaveBeenCalled();
  });
});

describe('Show from an Update (Q113 c)', () => {
  it('frames the cards it names on a spring, once, and only on its own board', async () => {
    spring.calls = [];
    mount();
    act(() => useBoardCanvasStore.getState().requestFrame('other', ['c2']));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(spring.calls).toHaveLength(0);
    flow.getNodesBounds.mockClear();
    act(() => useBoardCanvasStore.getState().requestFrame('k1', ['c2']));
    await vi.waitFor(() => expect(spring.calls).toHaveLength(1));
    expect((flow.getNodesBounds.mock.calls[0][0] as Node[]).map((node) => node.id)).toEqual(['c2']);
    expect(useBoardCanvasStore.getState().frameRequest).toBeNull();
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(spring.calls[0].to);
  });

  it('a request made before the Board view mounts (Show from List) frames once it has mounted', async () => {
    spring.calls = [];
    act(() => useBoardCanvasStore.getState().requestFrame('k1', ['c1', 'c2']));
    mount();
    await vi.waitFor(() => expect(spring.calls).toHaveLength(1));
  });
});

describe('the camera, kept for the visit', () => {
  it('a Fit or a zoom button is remembered, so List and back to Board shows the same view', () => {
    spring.calls = [];
    const view = mount();
    fireEvent.click(view.getByRole('button', { name: 'Fit the board' }));
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(spring.calls[0].to);
    fireEvent.click(view.getByRole('button', { name: 'Zoom in' }));
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(spring.calls[1].to);
  });
});

describe('the main canvas', () => {
  it('is never touched: no graph, no canvas camera, no zoomed-out flag', () => {
    const graph = useGraphStore.getState();
    const ui = useUIStore.getState();
    mount();
    act(() => props().onNodesChange([{ type: 'position', id: 'c1', position: { x: 50, y: 50 }, dragging: true }]));
    act(() => props().onNodeDragStop({}, nodeById('c1'), [nodeById('c1')]));
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useUIStore.getState().canvasViewport).toBe(ui.canvasViewport);
    expect(useUIStore.getState().canvasZoomedOut).toBe(ui.canvasZoomedOut);
  });
});
