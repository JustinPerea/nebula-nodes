import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';

/**
 * Phase 3 slice 6: the hand-off between the canvas layer and the screen layer
 * (lib/agentCursorHandoff.ts), both layers in one jsdom tree. React Flow is the
 * canvas layer's own test's mock: one node, a transform the test sets, a pane
 * element with a box that is not at the window's origin, so a flow point and a
 * client point are different numbers.
 */

const lookup = new Map([
  ['n1', {
    id: 'n1',
    measured: { width: 200, height: 120 },
    internals: { positionAbsolute: { x: 400, y: 300 }, handleBounds: { source: [], target: [] } },
  }],
]);
const pane = vi.hoisted(() => {
  const state = {
    dom: null as HTMLElement | null,
    api: null as unknown,
    transform: [10, 20, 2] as [number, number, number],
    listeners: new Set<(state: unknown) => void>(),
  };
  state.api = {
    getState: () => ({ nodeLookup: lookupRef.current, transform: state.transform, domNode: state.dom }),
    subscribe: (listener: (state: unknown) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
  return state;
});
const lookupRef = vi.hoisted(() => ({ current: new Map() as Map<string, unknown> }));
lookupRef.current = lookup;
/** React Flow's store changed (the viewport moved). */
const notifyStore = () => act(() => {
  const state = (pane.api as { getState: () => unknown }).getState();
  for (const listener of [...pane.listeners]) listener(state);
});
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) => select({ transform: pane.transform }),
  useStoreApi: () => pane.api,
}));

import { AgentCursorLayer } from '../src/components/canvas/AgentCursorLayer';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { cursorHandoff, CursorHandoff, HANDOFF_FRESH_MS } from '../src/lib/agentCursorHandoff';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useUIStore } from '../src/store/uiStore';

let frames: FrameRequestCallback[] = [];
let frameIds: number[] = [];
let nextFrameId = 0;
let clock = 0;
const step = (n = 1) => act(() => {
  for (let i = 0; i < n && frames.length > 0; i += 1) {
    const run = frames;
    frames = [];
    frameIds = [];
    clock += 1000 / 60;
    for (const callback of run) callback(clock);
  }
});
const flush = (max = 600) => step(max);

/** The clocks the view reads: performance.now (the name's first-sight moment) follows the test's
 *  frames, and Date.now (how old an event is) is held still, so a slow machine can't make an event
 *  stale. On a loaded one the flight tests read the event as old and snapped (PR #233 r136). */
const deterministicClocks = () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000);
};

const boxes = new Map<Element, Box>();
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => VIEW,
};
function putTile(box: Box): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-agent-anchor', 'moodboard:b1/i1');
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
}
const TILE: Box = { left: 900, top: 120, width: 160, height: 120 };
const aim = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 24) });
/** The pane's box in the window: its own origin, so flow and client differ. */
const PANE = { left: 100, top: 50 };
/** A flow point as client px, and back (the test's own copy of the maths). */
const toClient = (p: { x: number; y: number }) => ({
  x: PANE.left + pane.transform[0] + p.x * pane.transform[2],
  y: PANE.top + pane.transform[1] + p.y * pane.transform[2],
});
const toFlow = (p: { x: number; y: number }) => ({
  x: (p.x - PANE.left - pane.transform[0]) / pane.transform[2],
  y: (p.y - PANE.top - pane.transform[1]) / pane.transform[2],
});
/** n1's header point, where a cursor on it aims. */
const N1 = { x: 400 + 100, y: 300 + 44 };

const event = (overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { nodeId: 'n1' },
  action: 'click',
  say: '',
  at: 0,
  ...overrides,
});
const onTile = (): Partial<AgentPresenceEvent> => ({ target: { surface: 'moodboard', itemId: 'b1/i1' }, anchorNames: { board: 'Desert light', image: 1 } });
const send = (e: AgentPresenceEvent) => act(() => { useAgentPresenceStore.getState().apply(e); });
const canvasCursor = () => document.querySelector<HTMLElement>('.agent-cursor-layer:not(.agent-cursor-layer--screen) .agent-cursor');
const screenCursor = () => document.querySelector<HTMLElement>('.agent-cursor-layer--screen .agent-cursor');
const allCursors = () => [...document.querySelectorAll<HTMLElement>('.agent-cursor')];
const tipOf = (el: HTMLElement) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
  return m ? { x: +m[1], y: +m[2] } : null;
};
const opacityOf = (el: HTMLElement) => Number(el.style.opacity);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function Both({ canvasMounted }: { canvasMounted: boolean }) {
  return (
    <>
      {canvasMounted && <AgentCursorLayer />}
      <AgentScreenLayer canvasMounted={canvasMounted} env={env} />
    </>
  );
}
const renderBoth = (canvasMounted = true) => render(<Both canvasMounted={canvasMounted} />);

const realMatchMedia = window.matchMedia;
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null,
    dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  frames = [];
  frameIds = [];
  clock = 0;
  boxes.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.push(callback);
    frameIds.push(nextFrameId);
    return nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const at = frameIds.indexOf(id);
    if (at >= 0) {
      frames.splice(at, 1);
      frameIds.splice(at, 1);
    }
  });
  reduceMotion(false);
  pane.transform = [10, 20, 2];
  pane.dom = document.createElement('div');
  pane.dom.getBoundingClientRect = () => ({ left: PANE.left, top: PANE.top, right: PANE.left + 1000, bottom: PANE.top + 700,
    width: 1000, height: 700, x: PANE.left, y: PANE.top, toJSON: () => ({}) });
  lookupRef.current = lookup;
  cursorHandoff.reset();
  cursorHandoff.now = () => clock;
  deterministicClocks();
  useAgentPresenceStore.getState().clear();
  useUIStore.setState({ viewMode: 'canvas' });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  cursorHandoff.reset();
  cursorHandoff.now = () => performance.now();
  useAgentPresenceStore.getState().clear();
});

/** Rests a cursor on n1 on the canvas, then sends it to the tile. */
function restOnCanvasThenSendToTile() {
  putTile(TILE);
  const view = renderBoth(true);
  send(event());
  flush();
  return view;
}

describe('canvas to the panel: one cursor travels (PR #233 slice 6)', () => {
  it('starts the screen layer\'s flight at the registry point, not at an entrance 64 px back', () => {
    restOnCanvasThenSendToTile();
    const rest = tipOf(canvasCursor()!)!;
    expect(rest).toEqual(N1);
    const registry = toClient(N1);
    send(event(onTile()));
    // The canvas layer holds its last spot until the screen layer has drawn it (review 1, M5).
    expect(tipOf(canvasCursor()!)).toEqual(N1);
    step(1);
    expect(canvasCursor()).toBeNull(); // the screen layer has it: the canvas layer lets go
    const first = tipOf(screenCursor()!)!;
    // One frame in: within a frame's travel of where the canvas drew it.
    expect(dist(first, registry)).toBeLessThan(25);
    // Not the entrance: that starts 64 px short of the target and fades in.
    expect(dist(first, aim(TILE))).toBeGreaterThan(300);
    expect(opacityOf(screenCursor()!)).toBeGreaterThan(0.9);
  });

  it('draws it once, with no exit fade on the layer it left', () => {
    restOnCanvasThenSendToTile();
    send(event(onTile()));
    // Held where it was, not faded; the screen layer's has not drawn yet (no place on it).
    expect(allCursors().filter((el) => el.style.transform !== '')).toEqual([canvasCursor()]);
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    step(1);
    expect(allCursors()).toHaveLength(1);
    expect(screenCursor()).not.toBeNull();
  });

  it('never steps further in a frame than a flight of that length can: no jump', () => {
    restOnCanvasThenSendToTile();
    send(event(onTile()));
    let last = toClient(N1);
    let biggest = 0;
    for (let i = 0; i < 90; i += 1) {
      step(1);
      const el = screenCursor();
      if (!el) continue;
      const at = tipOf(el)!;
      biggest = Math.max(biggest, dist(at, last));
      last = at;
    }
    expect(last).toEqual(aim(TILE));
    // The flight is about 900 px over 0.5 s: 30 px a frame at the peak. A jump is hundreds.
    expect(biggest).toBeLessThan(60);
  });

  it('continues a flight in progress along its heading, at its speed', () => {
    putTile(TILE);
    renderBoth(true);
    send(event());
    step(3); // part way in from the entrance, moving
    const before = tipOf(canvasCursor()!)!;
    step(1);
    const now = tipOf(canvasCursor()!)!;
    const heading = { x: now.x - before.x, y: now.y - before.y };
    const speedBefore = Math.hypot(heading.x, heading.y) * pane.transform[2]; // client px in one frame
    expect(speedBefore).toBeGreaterThan(1);
    send(event(onTile()));
    step(1);
    const first = tipOf(screenCursor()!)!;
    const stepped = { x: first.x - toClient(now).x, y: first.y - toClient(now).y };
    // It carries on the way it was going (not stopped, not reversed), at about that speed.
    expect(stepped.x * heading.x + stepped.y * heading.y).toBeGreaterThan(0);
    expect(Math.hypot(stepped.x, stepped.y)).toBeGreaterThan(speedBefore * 0.4);
    expect(Math.hypot(stepped.x, stepped.y)).toBeLessThan(speedBefore * 2.5);
  });

  it('converts at the viewport of that frame: a zoom between the last frame and the hand-off is safe', () => {
    restOnCanvasThenSendToTile();
    send(event(onTile()));
    pane.transform = [10, 20, 4]; // the person zoomed in the same frame
    notifyStore();
    // The held canvas cursor rides the zoom with its node, and the screen
    // layer starts from where it is drawn then, at that viewport.
    const registry = toClient(N1);
    step(1);
    expect(dist(tipOf(screenCursor()!)!, registry)).toBeLessThan(25);
  });
});

describe('the panel to the canvas', () => {
  it('starts the canvas layer\'s flight at the registry point, in flow coordinates', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    flush();
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    const registry = toFlow(aim(TILE));
    send(event());
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE)); // held until the canvas has drawn it
    step(1);
    expect(screenCursor()).toBeNull();
    const first = tipOf(canvasCursor()!)!;
    expect(dist(first, registry)).toBeLessThan(25 / pane.transform[2] + 1);
    expect(dist(first, N1)).toBeGreaterThan(150);
    expect(opacityOf(canvasCursor()!)).toBeGreaterThan(0.9);
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    flush();
    expect(tipOf(canvasCursor()!)).toEqual(N1);
  });
});

describe('the way back flies as one cursor from where it rests (GM r136, ruling 1)', () => {
  /** The live ordering: the canvas layer's first frame takes the registry
   *  before the screen layer's own hold write lands, so what it finds is the
   *  screen cursor's last resting frame, long since written. */
  function restInPanelThenSendToNodeWithAnOldEntry() {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    flush(); // ten seconds of rest: its last frame is far older than HANDOFF_FRESH_MS
    const write = CursorHandoff.prototype.write;
    const spy = vi.spyOn(cursorHandoff, 'write').mockImplementation((key, entry, epoch) => {
      if (entry.layer === 'screen') return; // the hold write arrives after the take
      write.call(cursorHandoff, key, entry, epoch);
    });
    send(event());
    return spy;
  }

  it('starts at the resting spot, not at an entrance 64 px up-left of the node', () => {
    restInPanelThenSendToNodeWithAnOldEntry();
    step(1);
    const first = tipOf(canvasCursor()!)!;
    expect(dist(first, toFlow(aim(TILE)))).toBeLessThan(25 / pane.transform[2] + 1);
    expect(dist(first, N1)).toBeGreaterThan(150);
    expect(opacityOf(canvasCursor()!)).toBeGreaterThan(0.9);
  });

  it('is one cursor in every frame of the flight, never a gap, a second one or a jump', () => {
    restInPanelThenSendToNodeWithAnOldEntry();
    let previous: { x: number; y: number } | null = null;
    for (let frame = 0; frame < 120; frame += 1) {
      step(1);
      expect(allCursors()).toHaveLength(1);
      const el = allCursors()[0];
      expect(opacityOf(el)).toBeGreaterThan(0.9);
      const at = tipOf(el)!;
      if (previous) expect(dist(at, previous) * pane.transform[2]).toBeLessThan(120);
      previous = at;
      if (dist(at, N1) < 0.5 && frame > 10) break;
    }
    expect(dist(previous!, N1)).toBeLessThan(1);
  });

  it('is not taken once the screen layer no longer holds the cursor and its entry is old', () => {
    const registry = new CursorHandoff(() => 0);
    let t = 0;
    registry.now = () => t;
    registry.write('a', { layer: 'screen', at: { x: 1, y: 2 }, velocity: { x: 0, y: 0 }, opacity: 1, lean: 0 });
    registry.claim('a', 'screen');
    t = HANDOFF_FRESH_MS * 50;
    expect(registry.take('a', 'canvas')).not.toBeNull(); // it still rests there
    registry.write('a', { layer: 'screen', at: { x: 1, y: 2 }, velocity: { x: 0, y: 0 }, opacity: 1, lean: 0 });
    registry.claim('a', 'canvas'); // the other layer drew it since
    t += HANDOFF_FRESH_MS * 50;
    expect(registry.take('a', 'canvas')).toBeNull();
  });
});

describe('the name shows where a flight rests, in both motion modes (GM r136, ruling 2)', () => {
  const labelOf = (el: HTMLElement | null) => el?.dataset.label;

  it('canvas to the panel: the name shows at the panel rest, as it did on the canvas', () => {
    putTile(TILE);
    renderBoth(true);
    send(event());
    flush();
    expect(labelOf(canvasCursor())).toMatch(/^name/); // the canvas's own first-sight moment
    send(event(onTile()));
    flush(40);
    expect(labelOf(screenCursor())).toMatch(/^name/);
  });

  it('the panel to the canvas: the name shows at the node rest', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    flush(40);
    send(event());
    flush(40);
    expect(labelOf(canvasCursor())).toMatch(/^name/);
  });

  it('it is hidden while the cursor flies', () => {
    putTile(TILE);
    renderBoth(true);
    send(event());
    flush(40);
    send(event(onTile()));
    step(4);
    expect(labelOf(screenCursor())).not.toMatch(/^name/);
  });

  it('reduced motion draws the same rest', () => {
    putTile(TILE);
    renderBoth(true);
    send(event());
    flush();
    reduceMotion(true);
    send(event(onTile()));
    flush(40);
    expect(labelOf(screenCursor())).toMatch(/^name/);
    send(event());
    flush(40);
    expect(labelOf(canvasCursor())).toMatch(/^name/);
  });
});

describe('screenEpoch: a switched screen is not flown across (GM-approved plan, adversarial review)', () => {
  it('a hand-off written before the person switched screens makes the entrance instead', () => {
    putTile(TILE);
    const view = renderBoth(true);
    send(event());
    flush();
    // The person opens a Studio: the canvas goes. The cursor's target is still a canvas node,
    // so the screen layer draws it (parked at Back to Canvas, when there is one).
    act(() => { useUIStore.setState({ viewMode: 'moodboard-editor' }); });
    const back = document.createElement('div');
    back.setAttribute('data-agent-launcher', 'canvas');
    document.body.appendChild(back);
    boxes.set(back, { left: 20, top: 16, width: 90, height: 30 });
    view.rerender(<Both canvasMounted={false} />);
    step(1);
    const at = screenCursor()!;
    // Not carried from the canvas point; in from 64 px back, fading in.
    expect(opacityOf(at)).toBeLessThan(0.5);
    expect(dist(tipOf(at)!, toClient(N1))).toBeGreaterThan(300);
    flush();
    expect(tipOf(screenCursor()!)).toEqual({ x: 20 + 90 + 6, y: 16 + 15 });
  });

  it('bumps on a view mode change and on nothing else in the UI store', () => {
    putTile(TILE);
    renderBoth(true);
    send(event()); // the first write starts the watch
    flush();
    const epoch = cursorHandoff.epoch;
    act(() => { useUIStore.setState({ viewMode: 'moodboard-editor' }); });
    expect(cursorHandoff.epoch).toBe(epoch + 1);
    act(() => { useUIStore.setState({ viewMode: 'moodboard-editor' }); });
    expect(cursorHandoff.epoch).toBe(epoch + 1);
  });
});

describe('reduced motion: the hand-off is a snap', () => {
  it('puts it on its target in the first frame, at full opacity', () => {
    putTile(TILE);
    renderBoth(true);
    send(event());
    flush();
    reduceMotion(true);
    send(event(onTile()));
    step(1);
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    expect(opacityOf(screenCursor()!)).toBe(1);
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
  });
});

describe('the registry (lib/agentCursorHandoff.ts)', () => {
  const entry = (layer: 'canvas' | 'screen' = 'canvas') => ({ layer, at: { x: 5, y: 6 }, velocity: { x: 1, y: 2 }, opacity: 1, lean: 0 });

  it('hands over only to the other layer, once', () => {
    const registry = new CursorHandoff(() => 0);
    registry.write('a', entry('canvas'));
    expect(registry.take('a', 'canvas')).toBeNull();
    expect(registry.take('a', 'screen')?.at).toEqual({ x: 5, y: 6 });
    expect(registry.take('a', 'screen')).toBeNull();
  });

  it('is fresh for 100 ms and no longer', () => {
    let t = 0;
    const registry = new CursorHandoff(() => t);
    registry.write('a', entry());
    t = HANDOFF_FRESH_MS;
    expect(registry.take('a', 'screen')).not.toBeNull();
    registry.write('a', entry());
    t = HANDOFF_FRESH_MS * 2 + 1;
    expect(registry.take('a', 'screen')).toBeNull();
  });

  it('is not carried across an epoch', () => {
    const registry = new CursorHandoff(() => 0);
    registry.write('a', entry());
    registry.bump();
    expect(registry.take('a', 'screen')).toBeNull();
  });
});
