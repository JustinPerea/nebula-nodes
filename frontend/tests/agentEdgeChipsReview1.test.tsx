import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Box } from '../src/lib/agentAnchorResolve';
import type { CursorSpace } from '../src/lib/agentCursorSpace';
import type { AgentCursor } from '../src/store/agentPresenceStore';
import { planChips, type ChipCursor, type ChipSizes } from '../src/lib/agentEdgeChips';
import { leaveChipFocus, panToTarget } from '../src/lib/agentChipPress';
import { AGENT_CURSOR_CHIP } from '../src/lib/agentCursorTuning';

const flow = vi.hoisted(() => ({ api: null as unknown }));
flow.api = { getState: () => ({ transform: [10, 20, 2], panZoom: { setViewport: () => {} } }) };
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useStoreApi: () => flow.api,
}));

import { CanvasEdgeChips } from '../src/components/canvas/CanvasEdgeChips';

/**
 * PR #233 review 1, C2 to C5, C7 and C8: the chip layer's recheck timer, focus
 * when a pressed chip goes, a zero direction, a pane too small for a chip, a
 * person's pan during the press spring, and chrome that holds a whole edge.
 */
const VIEW: Box = { left: 0, top: 0, width: 1000, height: 700 };
const SIZES: ChipSizes = { chip: () => ({ width: 100, height: 28 }), count: { width: 36, height: 20 } };
const { insetPx } = AGENT_CURSOR_CHIP;
let n = 0;
const cur = (tip: { x: number; y: number }, over: Partial<ChipCursor> = {}): ChipCursor =>
  ({ key: `c${n += 1}`, label: 'Claude', color: '#E8825A', tip, activeAt: n, ...over });
const finite = (box: Box) => Object.values(box).every(Number.isFinite);
const inView = (box: Box, view: Box) => box.left >= view.left && box.top >= view.top
  && box.left + box.width <= view.left + view.width && box.top + box.height <= view.top + view.height;

describe('C4: a tip exactly at the pane\'s middle, under a panel', () => {
  const panel = { id: 'inspector0', box: { left: 400, top: 250, width: 200, height: 200 } };

  it('gives a finite chip at a deterministic spot, never NaN', () => {
    const tip = { x: 500, y: 350 };
    const once = planChips({ view: VIEW, obstacles: [panel], cursors: [cur(tip)], sizes: SIZES });
    const again = planChips({ view: VIEW, obstacles: [panel], cursors: [cur(tip)], sizes: SIZES });
    expect(once.chips).toHaveLength(1);
    const [chip] = once.chips;
    expect(finite(chip.box)).toBe(true);
    expect(Number.isFinite(chip.angle)).toBe(true);
    expect({ ...again.chips[0], key: chip.key }).toEqual(chip);
    // It stands just outside the panel, not inside it and not at the container's corner.
    const outside = chip.box.left + chip.box.width <= panel.box.left || chip.box.left >= panel.box.left + panel.box.width
      || chip.box.top + chip.box.height <= panel.box.top || chip.box.top >= panel.box.top + panel.box.height;
    expect(outside).toBe(true);
  });
});

describe('C5: a pane too small to hold a chip', () => {
  it('draws no chip outside the viewport; the agent is counted if a count fits', () => {
    const narrow: Box = { left: 300, top: 0, width: 60, height: 700 }; // two docks leave 60 px
    const plan = planChips({ view: narrow, cursors: [cur({ x: 2000, y: 350 })], sizes: SIZES });
    expect(plan.chips).toEqual([]);
    expect(plan.counts.map((count) => count.count)).toEqual([1]); // 60 px holds a count (36 + 2 x 12), not a chip
    expect(finite(plan.counts[0].box)).toBe(true);
    expect(inView(plan.counts[0].box, narrow)).toBe(true);
  });

  it('a pane of no width has neither', () => {
    const none = planChips({ view: { left: 300, top: 0, width: 0, height: 700 }, cursors: [cur({ x: -50, y: 10 })], sizes: SIZES });
    expect(none).toEqual({ chips: [], counts: [] });
  });

  it('a pane that holds a chip still draws it, wholly inside', () => {
    const fits: Box = { left: 0, top: 0, width: 100 + 2 * insetPx, height: 700 };
    const { chips } = planChips({ view: fits, cursors: [cur({ x: -400, y: 350 })], sizes: SIZES });
    expect(chips).toHaveLength(1);
    expect(inView(chips[0].box, fits)).toBe(true);
  });

  it('every chip and count stays inside the view', () => {
    const view: Box = { left: 40, top: 10, width: 150, height: 90 };
    const cursors = [cur({ x: -100, y: 50 }), cur({ x: 900, y: 40 }), cur({ x: 100, y: -300 }), cur({ x: 100, y: 800 })];
    const plan = planChips({ view, cursors, sizes: SIZES });
    for (const box of [...plan.chips.map((c) => c.box), ...plan.counts.map((c) => c.box)]) {
      expect(finite(box)).toBe(true);
      expect(inView(box, view)).toBe(true);
    }
  });
});

describe('C8: chrome that blocks every spot on an edge', () => {
  it('a chip that cannot stay on its edge slides inward past the chrome; every agent is a chip or in a count', () => {
    // A bar the whole length of the right edge, as wide as it is deep: no chip fits on it.
    const chrome: Box[] = [{ left: 800, top: 0, width: 200, height: 700 }];
    const cursors = [cur({ x: 3000, y: 100 }), cur({ x: 3000, y: 350 })];
    const plan = planChips({ view: VIEW, chrome, cursors, sizes: SIZES });
    const counted = plan.counts.reduce((sum, count) => sum + count.count, 0);
    // Every agent is either a chip somewhere or in a count.
    expect(plan.chips.length + counted).toBe(2);
    for (const chip of plan.chips) expect(chrome.some((c) => overlapBoxes(chip.box, c))).toBe(false);
    for (const count of plan.counts) {
      expect(inView(count.box, VIEW)).toBe(true);
      expect(chrome.some((c) => overlapBoxes(count.box, c))).toBe(false);
    }
  });

  it('chips dropped for want of a spot are counted where a count fits, not silently', () => {
    // Chrome across the whole pane but its right 50 px: no chip fits on the right edge at any depth, a count does.
    const chrome: Box[] = [{ left: 0, top: 0, width: 940, height: 700 }];
    const plan = planChips({ view: VIEW, chrome, cursors: [cur({ x: 3000, y: 300 }), cur({ x: 3000, y: 400 })], sizes: SIZES });
    expect(plan.chips).toEqual([]);
    expect(plan.counts.map((count) => count.count)).toEqual([2]);
    expect(overlapBoxes(plan.counts[0].box, chrome[0])).toBe(false);
  });

  it('with chrome on every edge, what cannot be placed is counted where there is any room', () => {
    const chrome: Box[] = [
      { left: 0, top: 0, width: 1000, height: 80 }, { left: 0, top: 620, width: 1000, height: 80 },
      { left: 0, top: 0, width: 80, height: 700 }, { left: 920, top: 0, width: 80, height: 700 },
    ];
    const plan = planChips({ view: VIEW, chrome, cursors: [cur({ x: 3000, y: 350 }), cur({ x: -3000, y: 350 })], sizes: SIZES });
    expect(plan.chips.length + plan.counts.reduce((sum, count) => sum + count.count, 0)).toBe(2);
  });
});
const overlapBoxes = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

// ---- the layer -------------------------------------------------------------------------

const PANE = { left: 0, top: 0, width: 1000, height: 600 };
let targets: Record<string, { x: number; y: number }>;
let pane: HTMLElement;
const space = (): CursorSpace => ({
  layer: 'canvas', zoom: () => 2, pane: () => pane, viewKey: () => 0, subscribe: () => () => {},
  resolve: (anchor) => targets[(anchor as { nodeId?: string }).nodeId ?? ''] ?? null,
  chainPoint: () => null, nodeInfo: () => undefined, labels: () => ({}) as never,
  fromClient: (p) => p, toClient: (p) => ({ x: p.x * 2, y: p.y * 2 }), snap: (p) => p,
} as unknown as CursorSpace);
const cursor = (key: string, nodeId: string, receivedAt = 1): AgentCursor => ({
  id: key, key, session: null, name: 'Claude', color: '#E8825A', verified: true,
  target: { surface: 'canvas', nodeId } as never, action: 'move', say: '', receivedAt, seq: 1, did: null,
  replayed: false, projectId: null, proposalId: null, arrivedAt: receivedAt, arrivalKnown: true,
});

beforeEach(() => {
  pane = document.createElement('div');
  pane.getBoundingClientRect = () => ({ ...PANE, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(pane);
  targets = {};
});
afterEach(() => { cleanup(); pane.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('C2: the recheck runs only while there is a canvas cursor', () => {
  it('with no agents the timer never runs: no DOM queries over several periods', () => {
    vi.useFakeTimers();
    const query = vi.spyOn(document, 'querySelectorAll');
    render(<CanvasEdgeChips agents={{}} space={space()} />);
    query.mockClear();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(query).not.toHaveBeenCalled();
  });

  it('with a cursor it rechecks, and it stops when the cursors go', () => {
    vi.useFakeTimers();
    targets = { far: { x: 1500, y: 150 } };
    const agents = { claude: cursor('claude', 'far') };
    const query = vi.spyOn(document, 'querySelectorAll');
    const view = render(<CanvasEdgeChips agents={agents} space={space()} />);
    query.mockClear();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(query.mock.calls.length).toBeGreaterThan(0);
    view.rerender(<CanvasEdgeChips agents={{}} space={space()} />);
    query.mockClear();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('C3: focus when a pressed chip goes', () => {
  it('moves to the canvas when the focused chip unmounts (its cursor came into view)', () => {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-wrapper';
    canvas.tabIndex = -1;
    document.body.append(canvas);
    targets = { far: { x: 1500, y: 150 } };
    const agents = { claude: cursor('claude', 'far') };
    const view = render(<CanvasEdgeChips agents={agents} space={space()} />);
    const chip = screen.getByRole('button', { name: 'Claude, show where it’s working' });
    chip.focus();
    expect(document.activeElement).toBe(chip);
    targets = { far: { x: 100, y: 100 } }; // the pan landed: in view
    view.rerender(<CanvasEdgeChips agents={{ ...agents }} space={space()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(canvas);
    canvas.remove();
  });

  it('leaves focus alone when a chip that is not the focused one goes, or the focused one stays', () => {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-wrapper';
    canvas.tabIndex = -1;
    document.body.append(canvas);
    const chip = document.createElement('button');
    chip.className = 'agent-edge-chip';
    chip.dataset.chipKey = 'a';
    document.body.append(chip);
    chip.focus();
    leaveChipFocus(new Set(['a']));
    expect(document.activeElement).toBe(chip);
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    leaveChipFocus(new Set());
    expect(document.activeElement).toBe(other);
    chip.remove(); other.remove(); canvas.remove();
  });
});

describe('C7: a person\'s pan or zoom during the press spring', () => {
  const store = (transform: number[] | undefined, setViewport: (viewport: unknown) => void) => ({
    getState: () => ({ transform, panZoom: { setViewport } }),
  });

  it('stops the spring when the camera is not where the last frame left it', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    let camera = [0, 0, 1];
    const written: { x: number; y: number; zoom: number }[] = [];
    const handle = { getState: () => ({ transform: camera, panZoom: { setViewport: (v: { x: number; y: number; zoom: number }) => {
      written.push(v);
      camera = [v.x, v.y, v.zoom]; // the camera follows what is written
    } } }) };
    const cancel = panToTarget({ target: { x: 800, y: 0 }, view: { left: 0, top: 0, width: 1000, height: 600 },
      pane: { left: 0, top: 0, width: 1000, height: 600 }, store: handle });
    expect(cancel).not.toBeNull();
    const run = () => { const batch = frames.splice(0); for (const callback of batch) callback(16 * (written.length + 1)); };
    run(); run();
    expect(written.length).toBeGreaterThan(0);
    const before = written.length;
    camera = [camera[0] - 200, camera[1], camera[2] * 1.5]; // the person wheeled or dragged
    run(); run(); run();
    expect(written.length).toBe(before); // nothing written over their move
    expect(frames).toHaveLength(0); // and the spring is not running
    vi.unstubAllGlobals();
  });

  it('writes every frame while nobody else moves the camera', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    let camera = [0, 0, 1];
    const written: unknown[] = [];
    const handle = store(undefined, () => {});
    handle.getState = () => ({ transform: camera, panZoom: { setViewport: (v: { x: number; y: number; zoom: number }) => {
      written.push(v);
      camera = [v.x, v.y, v.zoom];
    } } });
    panToTarget({ target: { x: 800, y: 0 }, view: { left: 0, top: 0, width: 1000, height: 600 },
      pane: { left: 0, top: 0, width: 1000, height: 600 }, store: handle });
    for (let i = 0; i < 200 && frames.length > 0; i += 1) { const batch = frames.splice(0); for (const callback of batch) callback(16 * (i + 1)); }
    expect(written.length).toBeGreaterThan(5);
    expect(written[written.length - 1]).toEqual({ zoom: 1, x: 500 - 800, y: 300 });
    vi.unstubAllGlobals();
  });
});
