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
import { HEADER_ICON_X } from '../src/lib/agentCursorMotion';
import { useCanvasProposalsStore, type ProposalEntry } from '../src/store/canvasProposalsStore';
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
/** Frame by frame, one `act` each, so a layer that lets go of a cursor (React state) has rendered before the next frame. */
const run = (max = 200) => { for (let i = 0; i < max; i += 1) step(1); };

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
/** A flow point as client px (the test's own copy of the maths). */
const toClient = (p: { x: number; y: number }) => ({
  x: PANE.left + pane.transform[0] + p.x * pane.transform[2],
  y: PANE.top + pane.transform[1] + p.y * pane.transform[2],
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
/** The cursors on screen: one not yet placed has no transform and is at opacity 0 (agentCursor.css). */
const drawn = () => allCursors().filter((el) => el.style.transform !== '' && Number(el.style.opacity || 0) > 0);
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
  pane.dom.getBoundingClientRect = () => ({ left: PANE.left, top: PANE.top, right: PANE.left + 1340, bottom: PANE.top + 800,
    width: 1340, height: 800, x: PANE.left, y: PANE.top, toJSON: () => ({}) });
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
  it('flies in the screen layer from the registry point and lands on the node in the canvas layer', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    flush();
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    send(event());
    step(1);
    // Still the screen layer's: it flies the way back (GM r137), from where it rested.
    expect(drawn()).toEqual([screenCursor()]);
    const first = tipOf(screenCursor()!)!;
    expect(dist(first, aim(TILE))).toBeLessThan(25);
    expect(dist(first, toClient(N1))).toBeGreaterThan(150);
    expect(opacityOf(screenCursor()!)).toBeGreaterThan(0.9);
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    run();
    expect(drawn()).toEqual([canvasCursor()]);
    expect(tipOf(canvasCursor()!)).toEqual(N1);
  });
});

describe('the way back flies as one cursor from where it rests (GM r136, ruling 1; r137)', () => {
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
    const first = tipOf(screenCursor()!)!;
    expect(dist(first, aim(TILE))).toBeLessThan(25);
    expect(dist(first, toClient(N1))).toBeGreaterThan(150);
    expect(opacityOf(screenCursor()!)).toBeGreaterThan(0.9);
  });

  it('is one cursor in every frame of the flight, never a gap, a second one or a jump', () => {
    restInPanelThenSendToNodeWithAnOldEntry();
    let previous: { x: number; y: number } | null = null;
    for (let frame = 0; frame < 120; frame += 1) {
      step(1);
      expect(drawn()).toHaveLength(1);
      const el = drawn()[0];
      expect(opacityOf(el)).toBeGreaterThan(0.9);
      const at = el === screenCursor() ? tipOf(el)! : toClient(tipOf(el)!);
      if (previous) expect(dist(at, previous)).toBeLessThan(120);
      previous = at;
      if (dist(at, toClient(N1)) < 0.5 && frame > 10) break;
    }
    expect(dist(previous!, toClient(N1))).toBeLessThan(1);
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

describe('the way back stays in the top layer over a dock (GM r137, ruling 1)', () => {
  /** A dock panel across the flight's path, in client px: the canvas layer
   *  draws under it, so a cursor drawn there while over it is hidden. */
  const DOCK = { left: 900, top: 150, right: 1115, bottom: 700 };
  const overDock = (p: { x: number; y: number }) => p.x >= DOCK.left && p.x <= DOCK.right && p.y >= DOCK.top && p.y <= DOCK.bottom;
  const clientTip = (el: HTMLElement) => (el === screenCursor() ? tipOf(el)! : toClient(tipOf(el)!));

  function restOnTile() {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    run(120);
  }

  it('draws the cursor in the screen layer in every frame where its point is over a dock', () => {
    restOnTile();
    send(event());
    let overFrames = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      step(1);
      const cursors = drawn();
      expect(cursors).toHaveLength(1); // never none, never two
      const at = clientTip(cursors[0]);
      if (overDock(at)) {
        overFrames += 1;
        expect(cursors[0]).toBe(screenCursor());
      }
    }
    expect(overFrames).toBeGreaterThan(5); // the path does cross the dock
    expect(drawn()).toEqual([canvasCursor()]); // and the canvas layer took it at the landing
  });

  it('is the screen layer\'s until it lands on the node, then the canvas layer\'s, at the same spot', () => {
    restOnTile();
    send(event());
    let lastScreen: { x: number; y: number } | null = null;
    let firstCanvas: { x: number; y: number } | null = null;
    for (let frame = 0; frame < 150; frame += 1) {
      step(1);
      const el = drawn()[0];
      if (el === screenCursor()) lastScreen = tipOf(el);
      else if (!firstCanvas) firstCanvas = toClient(tipOf(el)!);
    }
    expect(lastScreen).not.toBeNull();
    expect(firstCanvas).not.toBeNull();
    expect(dist(lastScreen!, firstCanvas!)).toBeLessThan(2);
    expect(dist(lastScreen!, toClient(N1))).toBeLessThan(2);
  });

  it('follows a pan or zoom during the flight: it still lands on the node, with no jump', () => {
    restOnTile();
    send(event());
    run(12);
    pane.transform = [10, 20, 2];
    pane.transform = [-60, 5, 1.5]; // the person panned and zoomed mid-flight
    notifyStore();
    let previous: { x: number; y: number } | null = null;
    for (let frame = 0; frame < 160; frame += 1) {
      step(1);
      const cursors = drawn();
      expect(cursors).toHaveLength(1);
      const at = clientTip(cursors[0]);
      if (previous) expect(dist(at, previous)).toBeLessThan(160);
      previous = at;
    }
    expect(drawn()).toEqual([canvasCursor()]);
    expect(dist(previous!, toClient(N1))).toBeLessThan(1);
  });

  it('plays its say and arrival in the canvas layer, at the landing, not on the way', () => {
    restOnTile();
    send(event({ say: 'Hello there' }));
    run(10);
    expect(drawn()[0]).toBe(screenCursor());
    expect(screenCursor()!.querySelector('.agent-cursor__say')).toBeNull();
    run(150);
    expect(drawn()[0]).toBe(canvasCursor());
    expect(canvasCursor()!.querySelector('.agent-cursor__say')?.textContent).toContain('Hello there');
  });

  it('a claim left by a cursor that went from the store does not start a new one as a flight back', () => {
    restOnTile();
    act(() => { useAgentPresenceStore.getState().clear(); });
    run(5);
    send(event());
    step(2);
    expect(screenCursor()?.style.transform ?? '').toBe('');
  });

  it('reduced motion is a snap on the canvas layer, as before', () => {
    restOnTile();
    reduceMotion(true);
    send(event());
    step(2);
    expect(drawn()).toEqual([canvasCursor()]);
    expect(tipOf(canvasCursor()!)).toEqual(N1);
  });

  it('a node outside the canvas\'s box is the canvas layer\'s at once (its edge chip, as before)', () => {
    restOnTile();
    lookupRef.current = new Map([['far', {
      id: 'far', measured: { width: 200, height: 120 },
      internals: { positionAbsolute: { x: 4000, y: 300 }, handleBounds: { source: [], target: [] } },
    }]]);
    send(event({ target: { nodeId: 'far' } }));
    run(20);
    // The screen layer never flew it (its held spot is gone once the canvas layer drew it).
    expect(screenCursor()).toBeNull();
    expect(canvasCursor()).not.toBeNull();
  });

  it('a node deleted during the flight ends it: the cursor holds the spot it reached, nothing keeps flying', () => {
    restOnTile();
    send(event());
    run(10);
    expect(drawn()[0]).toBe(screenCursor());
    lookupRef.current = new Map();
    notifyStore();
    run(5);
    const held = tipOf(screenCursor()!);
    run(40);
    expect(drawn()).toHaveLength(1);
    expect(tipOf(screenCursor()!)).toEqual(held);
  });
});

describe('the way back after a screen change (PR #233 pre-merge review, F1)', () => {
  const DOCK = { left: 900, top: 150, right: 1115, bottom: 700 };
  const overDock = (p: { x: number; y: number }) => p.x >= DOCK.left && p.x <= DOCK.right && p.y >= DOCK.top && p.y <= DOCK.bottom;
  const clientTip = (el: HTMLElement) => (el === screenCursor() ? tipOf(el)! : toClient(tipOf(el)!));

  /** The cursor is on a moodboard tile while the person is in a Studio (the
   *  screen layer claims it there); the person goes back to the canvas with
   *  the Moodboard dock open, and the same view redraws it on the dock. */
  function pointedInStudioThenBackOnCanvas() {
    putTile(TILE);
    act(() => { useUIStore.setState({ viewMode: 'moodboard-editor' }); });
    const view = renderBoth(false);
    send(event(onTile()));
    flush();
    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    view.rerender(<Both canvasMounted={true} />);
    run(30);
  }

  it('still flies a cursor that was on a surface before the screen change under the dock', () => {
    pointedInStudioThenBackOnCanvas();
    expect(cursorHandoff.epoch).toBeGreaterThan(0);
    send(event());
    let overFrames = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      step(1);
      const cursors = drawn();
      expect(cursors).toHaveLength(1);
      if (overDock(clientTip(cursors[0]))) {
        overFrames += 1;
        expect(cursors[0]).toBe(screenCursor());
      }
    }
    expect(overFrames).toBeGreaterThan(5);
    expect(drawn()).toEqual([canvasCursor()]);
  });

  it('a claim renewed under a new epoch notifies once and does not make an old entry valid', () => {
    const registry = new CursorHandoff(() => 0);
    let t = 0;
    registry.now = () => t;
    let calls = 0;
    registry.onClaim(() => { calls += 1; });
    registry.write('a', { layer: 'screen', at: { x: 1, y: 2 }, velocity: { x: 0, y: 0 }, opacity: 1, lean: 0 });
    registry.claim('a', 'screen');
    registry.bump();
    expect(registry.transits('a', 1)).toBe(false);
    registry.claim('a', 'screen');
    registry.claim('a', 'screen');
    expect(calls).toBe(2);
    expect(registry.transits('a', 1)).toBe(true);
    t = HANDOFF_FRESH_MS * 50;
    expect(registry.take('a', 'canvas')).toBeNull(); // written under the old epoch
  });
});

describe('the way back to a node that waits (PR #233 pre-merge review, F2 and F3)', () => {
  /** n1's header while it shows "Waiting for your OK": where the canvas layer draws a cursor on it. */
  const WAIT = { x: 400 + HEADER_ICON_X, y: 300 + 44 };
  const holdWait = (id: string) => act(() => {
    const entry = {
      view: { id, status: 'open', agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true }, expiresAt: 1_700_000_000_000 + 60_000,
        wait: { nodeIds: ['n1'], barLine: 'x', names: [] } },
      acceptKey: 'k',
    } as unknown as ProposalEntry;
    useCanvasProposalsStore.setState({ synced: true, proposals: { [id]: entry } });
  });
  afterEach(() => { useCanvasProposalsStore.getState().clear(); });

  it('lands at the wait rest in the screen layer, and the canvas layer takes it there with no second flight', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    run(120);
    holdWait('p1');
    send(event({ action: 'propose', proposalId: 'p1' }));
    let lastScreen: { x: number; y: number } | null = null;
    const canvasFrames: { x: number; y: number }[] = [];
    for (let frame = 0; frame < 160; frame += 1) {
      step(1);
      const el = drawn()[0];
      if (!el) continue;
      if (el === screenCursor()) lastScreen = tipOf(el);
      else canvasFrames.push(toClient(tipOf(el)!));
    }
    expect(lastScreen).not.toBeNull();
    expect(dist(lastScreen!, toClient(WAIT))).toBeLessThan(2);
    expect(canvasFrames.length).toBeGreaterThan(5);
    for (const at of canvasFrames) expect(dist(at, toClient(WAIT))).toBeLessThan(2);
  });

  it('reads the canvas pane\'s box once a frame with two cursors in transit', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    send(event({ agent: { id: 'codex', name: 'Codex', color: '#4B8BF5', verified: true }, ...onTile() }));
    run(150);
    const read = vi.fn(pane.dom!.getBoundingClientRect);
    pane.dom!.getBoundingClientRect = read;
    send(event());
    send(event({ agent: { id: 'codex', name: 'Codex', color: '#4B8BF5', verified: true } }));
    let inTransit = 0;
    for (let frame = 0; frame < 40; frame += 1) {
      read.mockClear();
      step(1);
      const flying = allCursors().filter((el) => el.closest('.agent-cursor-layer--screen') && el.style.transform !== '');
      if (flying.length < 2) continue; // the canvas layer's own one read, when it takes a cursor, is not this layer's
      inTransit += 1;
      expect(read.mock.calls.length).toBeLessThanOrEqual(1);
    }
    expect(inTransit).toBeGreaterThan(5);
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
