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
  zoom: 1, zoomListeners: new Set<(state: { transform: [number, number, number] }) => void>(),
  fill: null as null | { has: (url: string) => boolean; progress: (url: string) => number },
  getNodesBounds: vi.fn<(nodes: unknown[]) => { x: number; y: number; width: number; height: number }>(
    () => ({ x: 0, y: 0, width: 100, height: 100 })) }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const { useContext } = await import('react');
  const { BoardFillContext } = await import('./boardNodes');
  return {
  ...await importOriginal<typeof import('@xyflow/react')>(),
  // The nodes as React Flow draws them (focusable wrappers by id), so focus can land on one.
  ReactFlow: (props: FlowProps) => {
    flow.props = props;
    // What a card drawn now would read: which urls are filling, and how far in.
    flow.fill = useContext(BoardFillContext);
    return (
      <div data-testid="flow">
        {props.nodes.map((node) => <div key={node.id} className="react-flow__node" data-id={node.id} tabIndex={0} />)}
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
    subscribe: (listener: (state: { transform: [number, number, number] }) => void) => { flow.zoomListeners.add(listener); return () => flow.zoomListeners.delete(listener); } }),
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
import { BoardCanvas, type BoardMove, type BoardTarget } from './BoardCanvas';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('carries the view at paste time (the board less the inset), and is not aimed', () => {
    const { pasteTarget } = mountWithPoint();
    expect(pasteTarget.current?.()).toEqual({ at: { x: 620, y: 440 }, view: { x: 52, y: 72, width: 1136, height: 736 }, aim: false });
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

  it('a drop is aimed; its view is the board less the inset and the toolbar', () => {
    const view = mount();
    const { wrapper } = sized(view);
    const file = new File(['x'], 'ref.png', { type: 'image/png' });
    const drop = createEvent.drop(wrapper, { dataTransfer: { files: [file], types: ['Files'] } });
    Object.defineProperties(drop, { clientX: { value: 100 }, clientY: { value: 40 } });
    fireEvent(wrapper, drop);
    // Screen (26, 36)-(594, 354), doubled by the stand-in screenToFlowPosition.
    expect(targets).toEqual([{ at: { x: 200, y: 80 }, view: { x: 52, y: 72, width: 1136, height: 636 }, aim: true }]);
  });

  it('Add images follows the free-spot rule from the middle of the view', () => {
    const view = mount();
    sized(view);
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(targets).toEqual([{ at: { x: 620, y: 440 }, view: { x: 52, y: 72, width: 1136, height: 636 }, aim: false }]);
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

  it('judges "in view" by placement\'s own view: the board less the inset and the toolbar (review 2, M2)', () => {
    const tiles = { id: 1, rects: [{ x: 3000, y: 100, width: 300, height: 200 }], thumb: null };
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={(_f, target) => { targets.push(target); }}
      outside={tiles} onOutsideDone={() => {}} />);
    const wrapper = view.container.querySelector('.moodboard-board') as HTMLDivElement;
    wrapper.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 420, width: 600, height: 400 }) as DOMRect;
    const bar = view.container.querySelector('[data-bottom-bar]') as HTMLElement;
    bar.getBoundingClientRect = () => ({ left: 25, top: 370, right: 250, bottom: 405, width: 225, height: 35 }) as DOMRect;
    fireEvent.change(view.getByLabelText('Add images'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(chip.props!.viewOf()).toEqual({ x: 52, y: 72, width: 1136, height: 636 });
    expect(chip.props!.viewOf()).toEqual(targets[0].view);
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
});

describe('placeholder tiles (GM r4 answer 1)', () => {
  it('are drawn after the cards at their spot and size, never dragged or selected; the empty note stays away', () => {
    const view = render(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
      placeholders={[{ id: 'placeholder-1', x: 40, y: 60, width: 300, height: 200, source: { kind: 'file', name: 'a.png' } }]} />);
    const node = props().nodes.find((item) => item.id === 'placeholder-1')!;
    expect(node).toMatchObject({ type: 'placeholder', position: { x: 40, y: 60 }, width: 300, height: 200,
      draggable: false, selectable: false, focusable: true, ariaLabel: 'Adding an image' });
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
        act(() => { for (const listener of flow.zoomListeners) listener({ transform: [10, 20, zoom] }); });
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
      // The card as BoardCardNode draws it while filling (data-fill-url; the mock flow draws no cards).
      const cardEl = document.createElement('div');
      cardEl.className = 'moodboard-card';
      cardEl.dataset.fillUrl = url;
      view.container.querySelector('.moodboard-board')!.appendChild(cardEl);
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: url })]} onPlaceholdersFilled={filled} />);
      const seen: number[] = [];
      for (let frame = 0; frame < 400 && frames.length; frame += 1) {
        const cb = frames.shift()!;
        act(() => { cb(frame * 16); });
        seen.push(Number(cardEl.style.opacity));
        // A card drawn afresh this frame would start at the same opacity.
        if (frames.length) expect(flow.fill!.progress(url)).toBe(Number(cardEl.style.opacity));
      }
      // Steps between 0 and 1 (a spring, not a swap), ending at 1, then the placeholder is let go once.
      expect(seen.some((value) => value > 0.05 && value < 0.95)).toBe(true);
      expect(seen.at(-1)).toBe(1);
      expect(filled).toHaveBeenCalledTimes(1);
      expect(filled).toHaveBeenCalledWith(['placeholder-1']);
      // Nothing in the CSS times or eases it.
      expect(rule('.moodboard-card[data-fill-url]')).toMatch(/opacity:\s*0/);
      expect(rule('.moodboard-card[data-fill-url]')).not.toMatch(/transition|animation/);
      expect(rule('.moodboard-card')).not.toMatch(/transition|animation/);
    } finally { raf.mockRestore(); caf.mockRestore(); }
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
      cardEl.dataset.fillUrl = url;
      view.container.querySelector('.moodboard-board')!.appendChild(cardEl);
      raf.mockClear();
      view.rerender(<BoardCanvas boardKey="k1" images={[]} onMove={() => {}} onDropFiles={() => {}}
        placeholders={[holder({ filled: url })]} onPlaceholdersFilled={filled} />);
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
