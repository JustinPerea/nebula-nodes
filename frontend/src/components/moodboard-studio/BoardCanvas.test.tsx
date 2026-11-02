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
type FlowState = { width: number; height: number; transform: [number, number, number]; panZoom?: unknown };
const flow = vi.hoisted(() => ({ props: null as FlowProps | null, setViewport: vi.fn(), fitView: vi.fn(),
  // React Flow's store listeners get the state and the one before it (#209's fit-follow reads both).
  zoom: 1, zoomListeners: new Set<(state: FlowState, previous: FlowState) => void>(),
  fill: null as null | { progress: (imageId: string) => number },
  // Draws the stand-in again on its own, as React Flow does a commit after the board's (the board doesn't render).
  redraw: () => {},
  // Node ids the stand-in leaves out of the page, as React Flow does a commit after the board's own effects.
  hidden: new Set<string>(),
  getNodesBounds: vi.fn<(nodes: unknown[]) => { x: number; y: number; width: number; height: number }>(
    () => ({ x: 0, y: 0, width: 100, height: 100 })) }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const { useContext, useState } = await import('react');
  const { BoardFillContext } = await import('./boardNodes');
  return {
  ...await importOriginal<typeof import('@xyflow/react')>(),
  // The nodes as React Flow draws them (focusable wrappers by id), so focus can land on one.
  ReactFlow: (props: FlowProps) => {
    flow.props = props;
    const [, redraw] = useState(0);
    flow.redraw = () => redraw((n) => n + 1);
    // What a card drawn now would read: which urls are filling, and how far in.
    flow.fill = useContext(BoardFillContext);
    return (
      <div data-testid="flow">
        {props.nodes.filter((node) => !flow.hidden.has(node.id))
          .map((node) => <div key={node.id} className="react-flow__node" data-id={node.id} tabIndex={0} />)}
        {props.children}
      </div>
    );
  },
  Background: () => null,
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 }),
    setViewport: flow.setViewport, fitView: flow.fitView,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }), getNodesBounds: flow.getNodesBounds,
  }),
  useStoreApi: () => ({ getState: () => ({ width: 1000, height: 700, minZoom: 0.1, maxZoom: 2, transform: [0, 0, flow.zoom] }),
    subscribe: (listener: (state: FlowState, previous: FlowState) => void) => { flow.zoomListeners.add(listener); return () => flow.zoomListeners.delete(listener); } }),
  };
});
// The camera's spring, recorded: each move and the cancel it returned.
const spring = vi.hoisted(() => ({ calls: [] as Array<{ to: { x: number; y: number; zoom: number }; cancel: () => void }> }));
vi.mock('../../lib/viewportSpring', async (importOriginal) => ({
  // springProgress is the real one: a filled placeholder's image rides it (GM r5).
  ...await importOriginal<typeof import('../../lib/viewportSpring')>(),
  springViewport: (_from: unknown, to: { x: number; y: number; zoom: number }) => {
    const cancel = vi.fn();
    spring.calls.push({ to, cancel });
    return cancel;
  },
}));

// The edge chip, recorded: the props the board hands it.
type Rect = { x: number; y: number; width: number; height: number };
const chip = vi.hoisted(() => ({ props: null as null | { tiles: unknown; viewOf: () => Rect | null;
  onShow: (rects: Rect[], focus: boolean) => void; onDone: () => void; focusBoard: () => void } }));
vi.mock('./OutsideChip', () => ({
  OutsideChip: (props: NonNullable<typeof chip.props>) => { chip.props = props; return <button type="button">chip</button>; },
}));
import { BoardCanvas, FILL_DECODE_WAIT_MS, KEY_MOVE_SETTLE_MS, type BoardMove, type BoardTarget } from './BoardCanvas';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getViewportForBounds } from '@xyflow/react';
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
let targets: BoardTarget[] = [];
function mount(list = images) {
  return render(<BoardCanvas boardKey="k1" images={list} onMove={(next) => moves.push(next)}
    onDropFiles={(files, target) => { drops.push({ files, at: target.at }); targets.push(target); }} />);
}
const props = () => flow.props!;
const nodeById = (id: string) => props().nodes.find((node) => node.id === id)!;

beforeEach(() => {
  flow.props = null;
  flow.hidden.clear();
  moves = [];
  drops = [];
  targets = [];
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

  // #209 review 4 LOW-2: a drag's end resets the drag, or every arrow-key
  // move after the first mouse drag would show and never be sent.
  for (const how of ['a card drag', 'a selection drag'] as const) {
    it(`after ${how} ends, arrow keys still send their move`, () => {
      vi.useFakeTimers();
      mount();
      act(() => props().onNodesChange([{ type: 'position', id: 'c1', position: { x: 40, y: 0 }, dragging: true }]));
      act(() => {
        if (how === 'a card drag') props().onNodeDragStop({}, nodeById('c1'), [nodeById('c1')]);
        else props().onSelectionDragStop!({}, [nodeById('c1')]);
      });
      expect(moves).toEqual([[{ placement: 'c1', x: 40, y: 0 }]]);
      act(() => props().onNodesChange([{ type: 'position', id: 'c2', position: { x: 525, y: 0 }, dragging: false }]));
      act(() => { vi.advanceTimersByTime(KEY_MOVE_SETTLE_MS); });
      expect(moves).toEqual([[{ placement: 'c1', x: 40, y: 0 }], [{ placement: 'c2', x: 525, y: 0 }]]);
    });
  }
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

describe('where a paste lands (Cmd+V)', () => {
  const mountWithPoint = () => {
    const pasteTarget = { current: null as (() => BoardTarget) | null };
    const pastePoint = { get current() { return pasteTarget.current ? () => pasteTarget.current!().at : null; } };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      pasteTarget={pasteTarget} />);
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 }) as DOMRect;
    return { view, wrapper, pastePoint, pasteTarget };
  };

  it('is the last pointer position over the board, in board coordinates', () => {
    const { wrapper, pastePoint } = mountWithPoint();
    fireEvent.pointerMove(wrapper, { clientX: 100, clientY: 40 });
    fireEvent.pointerMove(wrapper, { clientX: 150, clientY: 60 });
    expect(pastePoint.current?.()).toEqual({ x: 300, y: 120 });
  });

  it('is the middle of the view when the pointer is not over the board', () => {
    const { wrapper, pastePoint } = mountWithPoint();
    expect(pastePoint.current?.()).toEqual({ x: 620, y: 440 });
    fireEvent.pointerMove(wrapper, { clientX: 100, clientY: 40 });
    fireEvent.pointerLeave(wrapper);
    expect(pastePoint.current?.()).toEqual({ x: 620, y: 440 });
  });

  it('carries the view at paste time (the board inside the view insets: no bar measured, so the fallback band), and is not aimed', () => {
    const { pasteTarget } = mountWithPoint();
    // No bar and no notice band on screen: the seen area is the whole view (the window's foot is below it).
    expect(pasteTarget.current?.()).toEqual({ at: { x: 620, y: 440 }, view: { x: 20, y: 40, width: 1200, height: 694 },
      seen: { x: 20, y: 40, width: 1200, height: 694 }, aim: false });
  });

  it('is gone once the board unmounts, so the List view never places a paste', () => {
    const { view, pastePoint } = mountWithPoint();
    view.unmount();
    expect(pastePoint.current).toBeNull();
  });
});

describe('where new tiles go (lib/boardPlacement targets)', () => {
  const sized = (view: ReturnType<typeof mount>) => {
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 }) as DOMRect;
    const bar = view.container.querySelector('[data-bottom-bar]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 25, top: 370, right: 250, bottom: 405, width: 225, height: 35 }) as DOMRect;
    return { wrapper, bar };
  };

  it('a drop is aimed; its view is the board less the toolbar\'s band (lib/boardViewInsets)', () => {
    const view = mount();
    const { wrapper } = sized(view);
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    const drop = createEvent.drop(wrapper, { dataTransfer: { files: [file], types: ['Files'] } });
    Object.defineProperties(drop, { clientX: { value: 100 }, clientY: { value: 40 } });
    fireEvent(wrapper, drop);
    // Screen (10, 20)-(610, 370), doubled by the stand-in screenToFlowPosition. The seen area stops at the
    // chip's floor, the bar's top less its gap (362 on screen, 724 on the board; round 6f).
    expect(targets).toEqual([{ at: { x: 200, y: 80 }, view: { x: 20, y: 40, width: 1200, height: 700 },
      seen: { x: 20, y: 40, width: 1200, height: 684 }, aim: true, band: true }]);
  });

  it('Add images follows the free-spot rule from the middle of the view', () => {
    const view = mount();
    sized(view);
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(targets).toEqual([{ at: { x: 620, y: 440 }, view: { x: 20, y: 40, width: 1200, height: 700 },
      seen: { x: 20, y: 40, width: 1200, height: 684 }, aim: false }]);
  });

  it('the seen area leaves out the notice band above the toolbar, the chip\'s own floor (round 6f, GM r14)', () => {
    const view = mount();
    sized(view);
    // The notice region's reserved band: 60 px tall, so the floor is 370 - 8 - 60 = 302 on screen, 604 on the board.
    const band = document.createElement('div');
    band.setAttribute('data-notice-band', '');
    band.getBoundingClientRect = () => ({ left: 100, top: 302, right: 500, bottom: 362, width: 400, height: 60 }) as DOMRect;
    document.body.appendChild(band);
    try {
      fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
      expect(targets[0].view).toEqual({ x: 20, y: 40, width: 1200, height: 700 });
      expect(targets[0].seen).toEqual({ x: 20, y: 40, width: 1200, height: 564 });
    } finally {
      band.remove();
    }
  });

  it('the toolbar is the board\'s bottom bar: the notice stack sits the gap above its measured top', () => {
    const view = mount();
    sized(view);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe(`${window.innerHeight - 370}px`);
    // The region's foot is that clearance plus the notice gap (styles/noticeRegion.css).
    const css = readFileSync(resolve(__dirname, '../../styles/noticeRegion.css'), 'utf8');
    expect(css).toMatch(/bottom: calc\(var\(--bottom-bar-clearance[^;]*\) \+ var\(--notice-gap\)\);/);
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
  });
});

describe('one view for every framing and placement (#213\'s shared insets)', () => {
  it('Fit, an Update\'s Show, the chip\'s press and placement all use the column less the toolbar\'s band', async () => {
    const tiles = { id: 1, rects: [{ x: 0, y: 0, width: 100, height: 100 }], thumb: null };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={(_f, target) => { targets.push(target); }}
      outside={tiles} onOutsideDone={() => {}} />);
    // The column React Flow measures (1000 x 700), its bar's top 50 px above the bottom.
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }) as DOMRect;
    const bar = view.container.querySelector('[data-bottom-bar]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 15, top: 650, right: 300, bottom: 688, width: 285, height: 38 }) as DOMRect;
    // Every framing here frames the same 100 x 100 bounds, into 1000 x 650 at the column's top left.
    const framed = getViewportForBounds({ x: 0, y: 0, width: 100, height: 100 }, 1000, 650, 0.02, 1, 0.12);
    spring.calls = [];
    fireEvent.click(view.getByRole('button', { name: 'Fit the board' }));
    act(() => useBoardCanvasStore.getState().requestFrame('k1', ['c2']));
    await vi.waitFor(() => expect(spring.calls).toHaveLength(2));
    act(() => { chip.props!.onShow(tiles.rects, false); });
    expect(spring.calls.map((call) => call.to)).toEqual([framed, framed, framed]);
    // Placement's view is that same screen area, (0, 0)-(1000, 650), in board coordinates (the stand-in doubles).
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(targets[0].view).toEqual({ x: 0, y: 0, width: 2000, height: 1300 });
    // The chip judges by the seen area, placement's too: the view above the floor (642 on screen; round 6f).
    expect(targets[0].seen).toEqual({ x: 0, y: 0, width: 2000, height: 1284 });
    expect(chip.props!.viewOf()).toEqual(targets[0].seen);
  });
});

describe('the outside-the-view chip on the board', () => {
  it('shows for the tiles it is given; its press frames them on the board\'s spring', () => {
    const done = vi.fn();
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} outside={tiles} onOutsideDone={done} />);
    expect(chip.props?.tiles).toBe(tiles);
    spring.calls = [];
    act(() => { chip.props!.onShow(tiles.rects, false); });
    expect(spring.calls).toHaveLength(1);
    chip.props!.onDone();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('judges "in view" by placement\'s own view: the board less the toolbar\'s band (review 2, M2)', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={(_f, target) => { targets.push(target); }}
      outside={tiles} onOutsideDone={() => {}} />);
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 }) as DOMRect;
    const bar = view.container.querySelector('[data-bottom-bar]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 25, top: 370, right: 250, bottom: 405, width: 225, height: 35 }) as DOMRect;
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(chip.props!.viewOf()).toEqual({ x: 20, y: 40, width: 1200, height: 684 });
    expect(chip.props!.viewOf()).toEqual(targets[0].seen);
  });

  it('a press from the keyboard sends focus to the board, then to the first tile once drawn, then to its card', async () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const holder = { id: 'placeholder-1', x: 3000, y: 100, width: 300, height: 200, source: { kind: 'file' as const, name: 'a.png' } };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder]} outside={tiles} onOutsideDone={() => {}} />);
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    act(() => { chip.props!.onShow(tiles.rects, true); });
    expect(document.activeElement).toBe(wrapper);
    await act(async () => { await new Promise((done) => window.requestAnimationFrame(() => done(null))); });
    expect(document.activeElement?.getAttribute('data-id')).toBe('placeholder-1');
    // The upload fills it: the placeholder goes and the card takes its spot.
    const filled = [...images, image('i4', [card('new-c4', 3000, 100, { w: 300, h: 200 })])];
    view.rerender(<BoardCanvas boardKey="k1" images={filled} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[]} outside={tiles} onOutsideDone={() => {}} />);
    expect(document.activeElement?.getAttribute('data-id')).toBe('new-c4');
  });

  // Review 4, HIGH-1 and MEDIUM-2: focus on a tile being replaced moves on to
  // what replaces it, never to the page body. React Flow draws the card over
  // the placeholder first, and drops the placeholder's element a commit after
  // the board's own effects (the stand-in's `hidden`).
  describe('focus on a tile as it is replaced', () => {
    const url = '/api/outputs/chat-uploads/river.png';
    const spot = { id: 'placeholder-1', x: 3000, y: 100, width: 300, height: 200, source: { kind: 'file' as const, name: 'river.png' } };
    const newCard = image('i4', [card('new-c4', 3000, 100, { w: 300, h: 200 })], { url });
    const savedCard = image('i4', [card('c4', 3000, 100, { w: 300, h: 200 })], { url });
    const draw = (view: ReturnType<typeof render> | null, list: MoodboardImage[], held: typeof spot[]) => {
      const ui = <BoardCanvas boardKey="k1" images={list} onMove={() => {}} onDropFiles={() => {}} placeholders={held} />;
      if (view) { view.rerender(ui); return view; }
      return render(ui);
    };
    // Every place focus went, so a pass through the body is seen too.
    let trail: string[] = [];
    const log = () => { trail.push(document.activeElement === document.body ? 'BODY' : document.activeElement?.getAttribute('data-id') ?? 'other'); };
    const node = (view: ReturnType<typeof render>, id: string) => view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    const settle = () => act(async () => { await Promise.resolve(); await new Promise((done) => window.requestAnimationFrame(() => done(null))); });

    it('a focused placeholder hands focus to its card as soon as the card is drawn over it, then on to the saved card', async () => {
      trail = [];
      let view = draw(null, images, [spot]);
      act(() => { node(view, 'placeholder-1')!.focus(); });
      log();
      // The upload lands: the card is drawn over its placeholder, which stays while the image fades in.
      view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      log();
      expect(document.activeElement).toBe(node(view, 'new-c4'));
      // The fade ends: the placeholder goes.
      view = draw(view, [...images, newCard], []);
      await settle();
      log();
      // The save answers: the provisional card is swapped for the saved one in one commit.
      view = draw(view, [...images, savedCard], []);
      await settle();
      log();
      expect(document.activeElement).toBe(node(view, 'c4'));
      expect(trail).toEqual(['placeholder-1', 'new-c4', 'new-c4', 'c4']);
    });

    it('when the placeholder\'s element goes before its card is drawn, focus waits on the board (never the body), then takes the card', async () => {
      let view = draw(null, images, [spot]);
      const wrapper = view.container.querySelector('.moodboard-board') as HTMLElement;
      act(() => { node(view, 'placeholder-1')!.focus(); });
      view = draw(view, images, [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      // React Flow drops the placeholder's element a commit after the board's effects ran.
      flow.hidden.add('placeholder-1');
      view = draw(view, images, [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(wrapper);
      view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(node(view, 'new-c4'));
    });

    it('focus on the placeholder past the 10 s follow ends on the card, however long the upload took (GM)', async () => {
      const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
      let view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[spot]} outside={tiles} onOutsideDone={() => {}} />);
      act(() => { chip.props!.onShow(tiles.rects, true); });
      await settle();
      expect(document.activeElement?.getAttribute('data-id')).toBe('placeholder-1');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      try {
        view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
        view = draw(view, [...images, newCard], []);
        await settle();
        expect(document.activeElement).toBe(node(view, 'new-c4'));
      } finally { clock.mockRestore(); }
    });

    it('focus somewhere else stays there: a placeholder or card going never pulls it', async () => {
      let view = draw(null, images, [spot]);
      const control = view.getByLabelText('Zoom in');
      act(() => { control.focus(); });
      view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      view = draw(view, [...images, savedCard], []);
      await settle();
      expect(document.activeElement).toBe(control);
    });

    it('a focused saved card that is removed leaves focus on the board, not the body', async () => {
      let view = draw(null, [...images, savedCard], []);
      act(() => { node(view, 'c4')!.focus(); });
      view = draw(view, images, []);
      await settle();
      expect(document.activeElement).toBe(view.container.querySelector('.moodboard-board'));
    });

    it('a saved card keeps focus while another tile of the same image is drawn', async () => {
      let view = draw(null, [...images, savedCard], []);
      act(() => { node(view, 'c4')!.focus(); });
      const twice = image('i4', [card('c4', 3000, 100, { w: 300, h: 200 }), card('new-c5', 0, 900)], { url });
      view = draw(view, [...images, twice], []);
      await settle();
      expect(document.activeElement).toBe(node(view, 'c4'));
    });

    it('a click on nothing (focus to the body, the tile still there) is left alone', async () => {
      const view = draw(null, images, [spot]);
      const holder = node(view, 'placeholder-1')!;
      act(() => { holder.focus(); });
      act(() => { holder.blur(); });
      draw(view, images, [spot, { ...spot, id: 'placeholder-2', x: 0, y: 900 }]);
      await settle();
      expect(document.activeElement).toBe(document.body);
    });

    // Every element focus landed on, in order (focusin), to see a stop on the board or the placeholder.
    const landed = (view: ReturnType<typeof render>) => {
      const seen: string[] = [];
      const onIn = (event: FocusEvent) => {
        const target = event.target as HTMLElement;
        seen.push(target.classList.contains('moodboard-board') ? 'BOARD' : target.getAttribute('data-id') ?? 'other');
      };
      view.container.addEventListener('focusin', onIn);
      return seen;
    };

    it('a placeholder whose provisional and saved cards are drawn in one commit hands focus to the saved one (review 5, M20)', async () => {
      let view = draw(null, images, [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      act(() => { node(view, 'placeholder-1')!.focus(); });
      const seen = landed(view);
      const both = image('i4', [card('new-c4', 3000, 100, { w: 300, h: 200 }), card('c4', 3000, 100, { w: 300, h: 200 })], { url });
      view = draw(view, [...images, both], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(node(view, 'c4'));
      // Straight there: no stop on the provisional card on the way.
      expect(seen).toEqual(['c4']);
    });

    it('a provisional card swapped for its saved card in one commit goes straight to it, with no stop on the board', async () => {
      let view = draw(null, [...images, newCard], []);
      act(() => { node(view, 'new-c4')!.focus(); });
      const seen = landed(view);
      view = draw(view, [...images, savedCard], []);
      await settle();
      expect(document.activeElement).toBe(node(view, 'c4'));
      expect(seen).toEqual(['c4']);
    });

    it('focus parked on the board waits only a short while: a card drawn after that leaves it on the board', async () => {
      let view = draw(null, images, [spot]);
      const wrapper = view.container.querySelector('.moodboard-board') as HTMLElement;
      act(() => { node(view, 'placeholder-1')!.focus(); });
      flow.hidden.add('placeholder-1');
      view = draw(view, images, [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(wrapper);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
      try {
        view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
        await settle();
        expect(document.activeElement).toBe(wrapper);
      } finally { clock.mockRestore(); }
    });

    it('the card React Flow draws a commit after the board\'s own takes focus at once (the board does not render)', async () => {
      let view = draw(null, images, [spot]);
      const wrapper = view.container.querySelector('.moodboard-board') as HTMLElement;
      act(() => { node(view, 'placeholder-1')!.focus(); });
      flow.hidden.add('placeholder-1');
      flow.hidden.add('new-c4');
      view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(wrapper);
      // Only the stand-in draws: no board render, no focus event; no frame passes either.
      flow.hidden.delete('new-c4');
      act(() => { flow.redraw(); });
      // The observer's callback is a microtask after the stand-in's commit.
      await act(async () => { await Promise.resolve(); });
      expect(document.activeElement).toBe(node(view, 'new-c4'));
    });

    it('with no MutationObserver, focus dropped to nowhere is picked up on the next frames', async () => {
      const Observer = globalThis.MutationObserver;
      vi.stubGlobal('MutationObserver', undefined);
      try {
        let view = draw(null, images, [spot]);
        const wrapper = view.container.querySelector('.moodboard-board') as HTMLElement;
        view = draw(view, images, [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
        act(() => { node(view, 'placeholder-1')!.focus(); });
        // React Flow drops the focused element on its own, and the browser sends focusout to nowhere.
        flow.hidden.add('placeholder-1');
        act(() => { flow.redraw(); });
        act(() => { wrapper.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); });
        await settle();
        await settle();
        expect(document.activeElement).toBe(wrapper);
      } finally { vi.stubGlobal('MutationObserver', Observer); }
    });

    it('once the person moved focus off the tile, its going later never pulls focus back', async () => {
      let view = draw(null, images, [spot]);
      act(() => { node(view, 'placeholder-1')!.focus(); });
      const control = view.getByLabelText('Zoom in');
      act(() => { control.focus(); });
      act(() => { control.blur(); });
      // The placeholder fills and React Flow drops its element in the same commit.
      flow.hidden.add('placeholder-1');
      view = draw(view, [...images, newCard], [{ ...spot, filled: { imageId: 'i4', url } } as typeof spot]);
      await settle();
      expect(document.activeElement).toBe(document.body);
    });

    it('the follow lands on the card, not its placeholder, when both are drawn at the spot', async () => {
      const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
      const filledSpot = { ...spot, filled: { imageId: 'i4', url } } as typeof spot;
      flow.hidden.add('placeholder-1');
      const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[spot]} outside={tiles} onOutsideDone={() => {}} />);
      act(() => { chip.props!.onShow(tiles.rects, true); });
      await settle();
      const seen = landed(view);
      flow.hidden.delete('placeholder-1');
      view.rerender(<BoardCanvas boardKey="k1" images={[...images, newCard]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[filledSpot]} outside={tiles} onOutsideDone={() => {}} />);
      await settle();
      expect(document.activeElement).toBe(node(view, 'new-c4'));
      expect(seen).not.toContain('placeholder-1');
    });
  });

  // Review 3: focus follows the tile only for a while, and never off a control.
  const followSetup = async () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const holder = { id: 'placeholder-1', x: 3000, y: 100, width: 300, height: 200, source: { kind: 'file' as const, name: 'a.png' } };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder]} outside={tiles} onOutsideDone={() => {}} />);
    act(() => { chip.props!.onShow(tiles.rects, true); });
    await act(async () => { await new Promise((done) => window.requestAnimationFrame(() => done(null))); });
    expect(document.activeElement?.getAttribute('data-id')).toBe('placeholder-1');
    const fill = () => view.rerender(<BoardCanvas boardKey="k1" onMove={() => {}} onDropFiles={() => {}}
      images={[...images, image('i4', [card('new-c4', 3000, 100, { w: 300, h: 200 })])]} placeholders={[]} outside={tiles} onOutsideDone={() => {}} />);
    return { view, fill };
  };

  it('focus follows the tile for 10 s only: a fill after that leaves focus where it is', async () => {
    const { view, fill } = await followSetup();
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    act(() => { wrapper.focus(); });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10_001);
    fill();
    expect(document.activeElement).toBe(wrapper);
    clock.mockRestore();
  });

  it('focus never follows the tile off a control the person moved to', async () => {
    const { view, fill } = await followSetup();
    const control = view.getByLabelText('Add images');
    act(() => { control.focus(); });
    expect(document.activeElement).toBe(control);
    fill();
    expect(document.activeElement).toBe(control);
  });

  it('a press with the pointer moves no focus', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} outside={tiles} onOutsideDone={() => {}} />);
    const before = document.activeElement;
    act(() => { chip.props!.onShow(tiles.rects, false); });
    expect(document.activeElement).toBe(before);
  });

  it('Esc on the chip keeps the view exactly: what Esc runs (focus to the board, done) moves no camera', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const onOutsideDone = vi.fn();
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} outside={tiles} onOutsideDone={onOutsideDone} />);
    const before = { springs: spring.calls.length, set: flow.setViewport.mock.calls.length, fit: flow.fitView.mock.calls.length };
    const viewBefore = chip.props!.viewOf();
    act(() => { chip.props!.focusBoard(); chip.props!.onDone(); });
    expect(onOutsideDone).toHaveBeenCalledTimes(1);
    expect({ springs: spring.calls.length, set: flow.setViewport.mock.calls.length, fit: flow.fitView.mock.calls.length }).toEqual(before);
    expect(chip.props!.viewOf()).toEqual(viewBefore);
  });

  it('focusBoard puts focus on the board itself, never the page body', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} outside={tiles} onOutsideDone={() => {}} />);
    act(() => { chip.props!.focusBoard(); });
    expect(document.activeElement).toBe(view.container.querySelector('.moodboard-board'));
  });

  it('a board that can\'t take focus (hidden) hands it to the view switch, never the body (review 5, NIT-6)', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} outside={tiles} onOutsideDone={() => {}} />);
    (view.container.querySelector('.moodboard-board') as HTMLElement).focus = () => {};
    const viewSwitch = document.createElement('button');
    viewSwitch.className = 'moodboard-view-switch__option';
    viewSwitch.setAttribute('aria-checked', 'true');
    document.body.appendChild(viewSwitch);
    try {
      act(() => { chip.props!.focusBoard(); });
      expect(document.activeElement).toBe(viewSwitch);
    } finally { viewSwitch.remove(); }
  });
});

describe('placeholder tiles (GM r4 answer 1)', () => {
  it('sit at their spot and size, never dragged or selected; the empty note stays away', () => {
    const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[{ id: 'placeholder-1', x: 40, y: 60, width: 300, height: 200, source: { kind: 'file', name: 'a.png' } }]} />);
    const node = props().nodes.find((item) => item.id === 'placeholder-1')!;
    expect(node).toMatchObject({ type: 'placeholder', position: { x: 40, y: 60 }, width: 300, height: 200,
      draggable: false, selectable: false, focusable: true, ariaLabel: 'a.png, uploading' });
    // Not selectable, movable or deletable: React Flow's description of those keys is dropped (GM r8 answer 6).
    expect(node.domAttributes).toEqual({ 'aria-describedby': undefined });
    expect(view.container.querySelector('.moodboard-board__empty')).toBeNull();
  });

  it('none: the nodes are just the cards', () => {
    mount();
    expect(props().nodes.map((node) => node.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('is not drawn with nothing outside', () => {
    chip.props = null;
    mount();
    expect(chip.props).toBeNull();
  });
});

describe('the placeholder\'s look and its fill (GM r5)', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/moodboard-board.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  };
  const holder = (extra: object = {}) => ({ id: 'placeholder-1', x: 40, y: 60, width: 300, height: 200,
    source: { kind: 'file' as const, name: 'river-at-dusk.png' }, ...extra });
  const nodeType = (name: string) => (props() as unknown as { nodeTypes: Record<string, (p: { data: unknown }) => ReactNode> }).nodeTypes[name];

  it('a fill at white 0.06, and no CSS border (Chrome snaps a border to whole pixels before the zoom scales it)', () => {
    const own = rule('.moodboard-board__placeholder');
    expect(own).toMatch(/background:\s*rgba\(255, 255, 255, 0\.06\)/);
    expect(own).not.toMatch(/border:|border-width|box-shadow/);
  });

  it('the edge is a dashed SVG stroke at white 0.28, drawn as an SVG rect (no border)', () => {
    render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    const Placeholder = nodeType('placeholder');
    const drawn = render(<>{Placeholder({ data: { label: 'x' } })}</>);
    expect(drawn.container.querySelector('.moodboard-board__placeholder > svg.moodboard-board__placeholder-edge > rect.moodboard-board__placeholder-stroke')).not.toBeNull();
    expect(drawn.container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    const stroke = rule('.moodboard-board__placeholder-stroke');
    expect(stroke).toMatch(/stroke:\s*rgba\(255, 255, 255, 0\.28\)/);
    expect(stroke).toMatch(/fill:\s*none/);
    expect(rule('.moodboard-board__placeholder-edge')).toMatch(/overflow:\s*visible/);
  });

  // The board's CSS scale(zoom) multiplies every board length, the stroke's
  // included: non-scaling-stroke doesn't undo a CSS transform above the SVG in
  // Chrome (live, r4: 2.6 px of ink at zoom 3), so the CSS divides instead.
  const perZoom = (decl: string, name: string) => {
    const found = decl.match(new RegExp(`calc\\(([\\d.]+)px \\/ var\\(--mb-board-zoom, 1\\)\\)`, 'g'));
    expect(found, name).not.toBeNull();
    return found!.map((part) => Number(part.match(/calc\(([\d.]+)px/)![1]));
  };
  it.each([0.25, 1, 3])('at zoom %s the edge is one screen pixel, dashed 4 on 3, inset half a stroke', (zoom) => {
    const stroke = rule('.moodboard-board__placeholder-stroke');
    expect(stroke).not.toMatch(/vector-effect/);
    const decl = (name: string) => stroke.match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*([^;]+);`))![1];
    const screen = (board: number) => (board / zoom) * zoom;
    expect(perZoom(decl('stroke-width'), 'stroke-width').map(screen)).toEqual([1]);
    expect(perZoom(decl('stroke-dasharray'), 'stroke-dasharray').map(screen)).toEqual([4, 3]);
    expect(perZoom(decl('x'), 'x').map(screen)).toEqual([0.5]);
    expect(perZoom(decl('y'), 'y').map(screen)).toEqual([0.5]);
    expect(decl('width')).toBe('calc(100% - 1px / var(--mb-board-zoom, 1))');
    expect(decl('height')).toBe('calc(100% - 1px / var(--mb-board-zoom, 1))');
  });

  it('the board carries the zoom as --mb-board-zoom, from mount and as it changes', () => {
    flow.zoom = 0.25;
    try {
      const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
      const board = view.container.querySelector('.moodboard-board') as HTMLElement;
      expect(board.style.getPropertyValue('--mb-board-zoom')).toBe('0.25');
      for (const zoom of [1, 3]) {
        const state: FlowState = { width: 1000, height: 700, transform: [10, 20, zoom] };
        act(() => { for (const listener of flow.zoomListeners) listener(state, { ...state, transform: [0, 0, 1] }); });
        expect(board.style.getPropertyValue('--mb-board-zoom')).toBe(String(zoom));
      }
    } finally { flow.zoom = 1; }
  });

  it('the label is the file name, top-left, at a filled tile\'s name size (12 screen px)', () => {
    render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    expect(props().nodes.find((node) => node.id === 'placeholder-1')!.data).toEqual({ label: 'river-at-dusk.png' });
    const Placeholder = nodeType('placeholder');
    const drawn = render(<>{Placeholder({ data: { label: 'river-at-dusk.png' } })}</>);
    expect(drawn.container.querySelector('.moodboard-board__placeholder .moodboard-board__placeholder-label')?.textContent).toBe('river-at-dusk.png');
    const label = rule('.moodboard-board__placeholder-label');
    expect(label).toMatch(/font-size:\s*calc\(12px \/ var\(--mb-board-zoom, 1\)\)/);
    expect(label).toMatch(/top:\s*calc\(8px/);
    expect(label).toMatch(/left:\s*calc\(8px/);
  });

  it('the image rides the board\'s spring in, with no CSS transition on it, then the placeholder goes', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const filled = vi.fn();
      const url = '/api/outputs/chat-uploads/a.png';
      const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder()]} onPlaceholdersFilled={filled} />);
      // The card as BoardCardNode draws it while filling (data-fill-id; the mock flow draws no cards).
      const cardEl = document.createElement('div');
      cardEl.className = 'moodboard-card';
      cardEl.dataset.fillId = 'i9';
      view.container.querySelector('.moodboard-board')!.appendChild(cardEl);
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: { imageId: 'i9', url } })]} onPlaceholdersFilled={filled} />);
      const seen: number[] = [];
      for (let frame = 0; frame < 400 && frames.length; frame += 1) {
        const cb = frames.shift()!;
        act(() => { cb(frame * 16); });
        seen.push(Number(cardEl.style.opacity));
        // A card drawn afresh this frame would start at the same opacity.
        if (frames.length) expect(flow.fill!.progress('i9')).toBe(Number(cardEl.style.opacity));
      }
      // Steps between 0 and 1 (a spring, not a swap), ending at 1, then the placeholder is let go once.
      expect(seen.some((value) => value > 0.05 && value < 0.95)).toBe(true);
      expect(seen.at(-1)).toBe(1);
      expect(filled).toHaveBeenCalledTimes(1);
      expect(filled).toHaveBeenCalledWith(['placeholder-1']);
      // Nothing in the CSS times or eases it.
      expect(rule('.moodboard-card[data-fill-id]')).toMatch(/opacity:\s*0/);
      expect(rule('.moodboard-card[data-fill-id]')).not.toMatch(/transition|animation/);
      expect(rule('.moodboard-card')).not.toMatch(/transition|animation/);
    } finally { raf.mockRestore(); caf.mockRestore(); }
  });

  // Review 4, MEDIUM-1: the fill is keyed by the new image's id. Pasting a
  // file the board already shows (the upload dedupes to the same url) fades
  // in the new tile only; the old one is never marked or hidden.
  it('marks only the new image\'s card filling, never an older card showing the same file', () => {
    const url = '/api/outputs/chat-uploads/same.png';
    const old = image('i-old', [card('c-old', 0, 0)], { url });
    const fresh = image('i-new', [card('new-c9', 600, 0)], { url });
    render(<BoardCanvas boardKey="k1" images={[old, fresh]} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder({ x: 600, y: 0, filled: { imageId: 'i-new', url } })]} />);
    const data = (id: string) => props().nodes.find((item) => item.id === id)!.data as { filling: boolean };
    expect(data('c-old').filling).toBe(false);
    expect(data('new-c9').filling).toBe(true);
  });

  it('a fill changes only the filling card\'s node: every other card keeps its node, so React Flow skips it (review 4, LOW-5)', () => {
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    const before = new Map(props().nodes.map((item) => [item.id, item]));
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder({ filled: { imageId: 'i2', url: images[1].url } })]} />);
    const after = new Map(props().nodes.map((item) => [item.id, item]));
    expect(after.get('c1')).toBe(before.get('c1'));
    expect(after.get('c3')).toBe(before.get('c3'));
    expect(after.get('c2')).not.toBe(before.get('c2'));
    expect((after.get('c2')!.data as { filling: boolean }).filling).toBe(true);
    // Another placeholder coming or going changes no card at all.
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder({ filled: { imageId: 'i2', url: images[1].url } }), holder({ id: 'placeholder-2', x: 900 })]} />);
    for (const id of ['c1', 'c2', 'c3']) expect(props().nodes.find((item) => item.id === id)).toBe(after.get(id));
  });

  it('placeholders come first, so the cards are drawn over them (review 4, X16)', () => {
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    expect(props().nodes.map((item) => item.id)).toEqual(['placeholder-1', 'c1', 'c2', 'c3']);
  });

  /** The spring's frames, run by hand. */
  const frameQueue = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { next += 1; frames.set(next, cb); return next; });
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    let t = 0;
    const step = (count: number) => {
      for (let i = 0; i < count && frames.size; i += 1) {
        const [id, cb] = frames.entries().next().value!;
        frames.delete(id);
        t += 16;
        act(() => { cb(t); });
      }
    };
    return { frames, step, restore: () => { raf.mockRestore(); caf.mockRestore(); } };
  };
  const fillCard = (view: ReturnType<typeof render>, imageId: string, img?: HTMLImageElement) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'moodboard-card';
    cardEl.dataset.fillId = imageId;
    if (img) cardEl.appendChild(img);
    view.container.querySelector('.moodboard-board')!.appendChild(cardEl);
    return cardEl;
  };

  it('another placeholder changing mid-fade never restarts the fade (review 4, X13)', async () => {
    const q = frameQueue();
    try {
      const url = '/api/outputs/chat-uploads/a.png';
      const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
      const cardEl = fillCard(view, 'i9');
      const filled = holder({ filled: { imageId: 'i9', url } });
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[filled]} />);
      q.step(8);
      const mid = Number(cardEl.style.opacity);
      expect(mid).toBeGreaterThan(0.1);
      // Every opacity written from here on: a second fade would write its own, from 0.
      const writes: number[] = [];
      let opacity = cardEl.style.opacity;
      Object.defineProperty(cardEl.style, 'opacity', { configurable: true, get: () => opacity,
        set: (value: string) => { opacity = value; writes.push(Number(value)); } });
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[filled, holder({ id: 'placeholder-2', x: 900 })]} />);
      await act(async () => { await Promise.resolve(); });
      q.step(4);
      expect(writes.length).toBeGreaterThan(0);
      expect(Math.min(...writes)).toBeGreaterThanOrEqual(mid);
    } finally { q.restore(); }
  });

  it('a fade is stopped when the board goes, and its progress is let go with its placeholder (review 4, X14, X15)', () => {
    const q = frameQueue();
    try {
      const url = '/api/outputs/chat-uploads/a.png';
      const done = vi.fn();
      const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]}
        onPlaceholdersFilled={done} />);
      fillCard(view, 'i9');
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: { imageId: 'i9', url } })]} onPlaceholdersFilled={done} />);
      q.step(4);
      expect(flow.fill!.progress('i9')).toBeGreaterThan(0);
      // The placeholder goes (the Studio's fallback): its progress goes with it.
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[]} onPlaceholdersFilled={done} />);
      expect(flow.fill!.progress('i9')).toBe(0);
      expect(done).not.toHaveBeenCalled();
      view.unmount();
      q.step(400);
      expect(done).not.toHaveBeenCalled();
    } finally { q.restore(); }
  });

  it('the fade waits for the card\'s image to decode (review 4, NIT-3), and at most FILL_DECODE_WAIT_MS', async () => {
    const url = '/api/outputs/chat-uploads/slow.png';
    let decoded: () => void = () => {};
    const img = document.createElement('img');
    img.decode = () => new Promise<void>((resolve) => { decoded = resolve; });
    const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    const cardEl = fillCard(view, 'i9', img);
    const q = frameQueue();
    try {
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: { imageId: 'i9', url } })]} />);
      q.step(10);
      expect(cardEl.style.opacity).toBe('');
      await act(async () => { decoded(); await Promise.resolve(); });
      q.step(10);
      expect(Number(cardEl.style.opacity)).toBeGreaterThan(0);
    } finally { q.restore(); }
    // An image that never decodes still fades in after the cap.
    vi.useFakeTimers();
    const stuck = document.createElement('img');
    stuck.decode = () => new Promise<void>(() => {});
    const later = render(<BoardCanvas boardKey="k2" images={[]} onMove={() => {}} onDropFiles={() => {}} placeholders={[holder()]} />);
    const stuckCard = fillCard(later, 'i8', stuck);
    later.rerender(<BoardCanvas boardKey="k2" images={[]} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[holder({ filled: { imageId: 'i8', url } })]} />);
    act(() => { vi.advanceTimersByTime(FILL_DECODE_WAIT_MS - 50); });
    expect(stuckCard.style.opacity).toBe('');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(Number(stuckCard.style.opacity)).toBeGreaterThan(0);
  });

  it('under reduced motion the image swaps straight in', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }));
    try {
      const filled = vi.fn();
      const url = '/api/outputs/chat-uploads/a.png';
      const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder()]} onPlaceholdersFilled={filled} />);
      const cardEl = document.createElement('div');
      cardEl.className = 'moodboard-card';
      cardEl.dataset.fillId = 'i9';
      view.container.querySelector('.moodboard-board')!.appendChild(cardEl);
      raf.mockClear();
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: { imageId: 'i9', url } })]} onPlaceholdersFilled={filled} />);
      expect(cardEl.style.opacity).toBe('1');
      expect(filled).toHaveBeenCalledWith(['placeholder-1']);
      expect(raf).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); raf.mockRestore(); }
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

  it('stays live while files upload, with no status of its own (GM): each upload is its placeholder', () => {
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[{ id: 'placeholder-1', x: 40, y: 60, width: 300, height: 200, source: { kind: 'file', name: 'a.png' } }]} />);
    const input = view.getByLabelText('Add images') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.closest('label')!.textContent).toBe('Add images');
    expect(input.closest('label')!.className).not.toMatch(/busy/);
    expect(view.container.textContent).not.toMatch(/Uploading/);
  });
});

describe('an empty board while Nebula is offline (GM r12 2)', () => {
  const hint = 'Drop images here. They land where you drop them.';
  const board = (offline: boolean) => <BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={(files, target) => {
    drops.push({ files, at: target.at }); }} offline={offline} />;

  it('shows only "No references yet", and Add images is off with the offline reason; back online the hint and the button come back', () => {
    const view = render(board(true));
    const input = view.getByLabelText('Add images') as HTMLInputElement;
    expect(view.container.querySelector('.moodboard-board__empty')!.textContent).toBe('No references yet');
    expect(view.queryByText(hint)).toBeNull();
    expect(input.disabled).toBe(true);
    const label = input.closest('label')!;
    expect(label.title).toBe('You can add images when Nebula reconnects.');
    expect(label.hasAttribute('data-offline-disabled')).toBe(true);
    expect(label.className).toContain('moodboard-board__control--disabled');
    view.rerender(board(false));
    expect(view.getByText(hint)).toBeTruthy();
    expect(input.disabled).toBe(false);
    expect(label.title).toBe('Add images to the middle of the view');
    expect(label.hasAttribute('data-offline-disabled')).toBe(false);
    expect(label.className).not.toContain('--disabled');
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(drops).toHaveLength(1);
  });

  it('Y24 (review 8): Fit on a board with no cards but a held spot frames the spot; with neither it does nothing', () => {
    spring.calls.length = 0;
    flow.getNodesBounds.mockClear();
    const held = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[{ id: 'placeholder-1', x: 40, y: 60, width: 300, height: 200, source: { kind: 'file', name: 'a.png' } }]} />);
    fireEvent.click(held.getByLabelText('Fit the board'));
    expect(spring.calls).toHaveLength(1);
    expect(flow.getNodesBounds).toHaveBeenCalledWith([expect.objectContaining({ position: { x: 40, y: 60 } })]);
    held.unmount();
    spring.calls.length = 0;
    const empty = render(board(false));
    fireEvent.click(empty.getByLabelText('Fit the board'));
    expect(spring.calls).toHaveLength(0);
  });

  it('going offline on an empty board takes the hint away', () => {
    const view = render(board(false));
    expect(view.getByText(hint)).toBeTruthy();
    view.rerender(board(true));
    expect(view.queryByText(hint)).toBeNull();
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

  it('Fit frames the held spots too: a placeholder is a card on its way in (GM r8 answer 4)', () => {
    spring.calls = [];
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[{ id: 'placeholder-1', x: 4000, y: 100, width: 300, height: 200, source: { kind: 'file', name: 'a.png' } },
        { id: 'placeholder-2', x: 0, y: 0, width: 0, height: 0, listOnly: true, source: { kind: 'file', name: 'b.png' } }]} />);
    flow.getNodesBounds.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Fit the board' }));
    expect((flow.getNodesBounds.mock.calls[0][0] as Node[]).map((node) => node.id)).toEqual(['c1', 'c2', 'c3', 'placeholder-1']);
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
