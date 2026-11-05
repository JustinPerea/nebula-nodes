import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';
import { AGENT_SAY_FADE_MS } from '../src/store/agentPresenceStore';

/**
 * Phase 3 slice 5: the screen layer (components/agent-cursor/AgentScreenLayer.tsx)
 * in jsdom. The page is fake: elements the test puts in the document with the
 * boxes it gives them (`boxes`), measured through the resolver's own env, so
 * no layout is needed. Frames run on the test's own clock.
 */

let frames: FrameRequestCallback[] = [];
let frameIds: number[] = [];
let nextFrameId = 0;
let clock = 0;
/** Runs `n` batches of the frames queued (each callback may queue the next). */
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
/** The page's own changes (an anchor came or went) reach the layer through a MutationObserver, a microtask. */
const dom = () => act(async () => { await Promise.resolve(); });

const boxes = new Map<Element, Box>();
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
let clipOf: (element: Element) => Box = () => VIEW;
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: (element) => clipOf(element),
};

/** A page element with an anchor or a launcher, at `box`. */
function put(attr: 'anchor' | 'launcher', value: string, box: Box): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(`data-agent-${attr}`, value);
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
}
/** Where a cursor aims at an item (agentAnchorResolve.aimPoint). */
const aim = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 24) });

const event = (overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { surface: 'moodboard', itemId: 'b1/i1' },
  anchorNames: { board: 'Desert light', image: 1 },
  action: 'click',
  say: '',
  at: 0,
  ...overrides,
});
const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12), ordinal } });
const send = (e: AgentPresenceEvent) => act(() => { useAgentPresenceStore.getState().apply(e); });
const cursors = () => [...document.querySelectorAll<HTMLElement>('.agent-screen-layer .agent-cursor')];
const tipOf = (el: HTMLElement) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
  return m ? { x: +m[1], y: +m[2] } : null;
};
const rings = () => [...document.querySelectorAll<HTMLElement>('.agent-item-outline')];
const renderLayer = (canvasMounted = false) => render(<AgentScreenLayer canvasMounted={canvasMounted} env={env} />);

const TILE: Box = { left: 300, top: 200, width: 160, height: 120 };
const realMatchMedia = window.matchMedia;
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null,
    dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};
const scrolled = vi.fn();

beforeEach(() => {
  frames = [];
  frameIds = [];
  clock = 0;
  boxes.clear();
  clipOf = () => VIEW;
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
  scrolled.mockReset();
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy'] as const) {
    (Element.prototype as unknown as Record<string, unknown>)[name] = scrolled;
  }
  (window as unknown as Record<string, unknown>).scrollTo = scrolled;
  reduceMotion(false);
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: null });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: null });
});

describe('a cursor flies to a Studio tile (PR #233 slice 5)', () => {
  it('flies across frames to the tile\'s aim point, and rests exactly there', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    step(3);
    const midway = tipOf(cursors()[0]);
    expect(midway).not.toBeNull();
    flush();
    const rest = tipOf(cursors()[0])!;
    expect(rest).toEqual(aim(TILE));
    // It was still on its way a few frames in: a flight, not a jump.
    expect(Math.hypot(midway!.x - rest.x, midway!.y - rest.y)).toBeGreaterThan(8);
    expect(cursors()[0].dataset.placed).toBe('true');
  });

  it('is in a fixed, click-through box over the window, with the shared cursor layer inside', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    const root = document.querySelector('.agent-screen-layer')!;
    expect(root.querySelector('.agent-cursor-layer.agent-cursor-layer--screen .agent-cursor')).not.toBeNull();
  });

  it('says the default line with the names the event carried, with no say of its own', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'look', anchorNames: { board: 'Desert light', image: 12 } }));
    flush();
    expect(cursors()[0].querySelector('.agent-cursor__say')?.textContent).toBe('Looking at image 12 on “Desert light”');
  });

  it('the agent\'s own say wins over the default', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'look', say: 'Checking the light' }));
    flush();
    expect(cursors()[0].querySelector('.agent-cursor__say')?.textContent).toBe('Checking the light');
  });

  it('draws nothing for a canvas cursor while the canvas is mounted, and parks one at Back to Canvas when it is not', () => {
    put('launcher', 'canvas', { left: 20, top: 16, width: 90, height: 30 });
    const view = renderLayer(true);
    send(event({ target: { nodeId: 'n1' } }));
    flush();
    expect(cursors()).toHaveLength(0);
    view.rerender(<AgentScreenLayer canvasMounted={false} env={env} />);
    flush();
    expect(cursors()).toHaveLength(1);
    expect(tipOf(cursors()[0])).toEqual({ x: 20 + 90 + 6, y: 16 + 15 });
  });
});

describe('a cursor with no spot, and one whose target goes (GM r6)', () => {
  it('is not drawn while nothing resolves, and not at 0,0', () => {
    renderLayer();
    send(event());
    flush();
    const el = cursors()[0];
    expect(el).toBeDefined();
    expect(el.dataset.placed).toBeUndefined();
    expect(el.style.transform).toBe('');
    expect(el.style.opacity === '' || el.style.opacity === '0').toBe(true);
  });

  it('makes its entrance, 64 px back and fading in, once something resolves', async () => {
    renderLayer();
    send(event());
    flush();
    put('anchor', 'moodboard:b1/i1', TILE);
    await dom();
    flush(); // the page gained an anchor: the layer wakes
    const el = cursors()[0];
    expect(el.dataset.placed).toBe('true');
    expect(tipOf(el)).toEqual(aim(TILE));
  });

  it('enters from back along the line, not already there', async () => {
    renderLayer();
    send(event());
    flush();
    put('anchor', 'moodboard:b1/i1', TILE);
    await dom();
    step(3);
    const first = tipOf(cursors()[0])!;
    const goal = aim(TILE);
    expect(Math.hypot(first.x - goal.x, first.y - goal.y)).toBeGreaterThan(20);
    expect(Number(cursors()[0].style.opacity)).toBeLessThan(1);
    flush();
    expect(tipOf(cursors()[0])).toEqual(goal);
  });

  it('holds its last spot when the tile leaves with nothing else to resolve to', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    const spot = tipOf(cursors()[0]);
    tile.remove();
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual(spot);
    expect(cursors()[0].dataset.placed).toBe('true');
  });

  it('GM 4: an image its own agent removed holds the spot, though the board\'s row is right there', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    put('launcher', 'moodboard:b1', { left: 900, top: 100, width: 200, height: 40 });
    useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'k', imageIds: ['i1', 'i2'] } });
    renderLayer();
    send(event());
    flush();
    const spot = tipOf(cursors()[0]);
    // The remove: the studio's images no longer list it, and the tile leaves.
    act(() => { useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'k', imageIds: ['i2'] } }); });
    tile.remove();
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual(spot);
  });

  it('a panel that closed is not a removal: the cursor goes on to the board\'s row', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    // The Studio is not open (no studio board), and the board's row shows.
    tile.remove();
    put('launcher', 'moodboard:b1', { left: 900, top: 100, width: 200, height: 40 });
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual({ x: 900 + 200 + 6, y: 120 });
  });
});

describe('a resting cursor rides its item; a new place is a flight', () => {
  it('rides the item when the page scrolls under it, in the frame it wakes, never a flight', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    const moved: Box = { ...TILE, top: TILE.top + 260 };
    boxes.set(tile, moved);
    act(() => { document.dispatchEvent(new Event('scroll')); });
    step(2); // the scroll's frame, then the cursor's
    expect(tipOf(cursors()[0])).toEqual(aim(moved));
  });

  it('flies, not rides, to a different element (the row re-mounted elsewhere)', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    tile.remove();
    const other: Box = { left: 900, top: 500, width: 160, height: 120 };
    put('anchor', 'moodboard:b1/i1', other);
    await dom();
    step(5);
    const mid = tipOf(cursors()[0])!;
    expect(Math.hypot(mid.x - aim(other).x, mid.y - aim(other).y)).toBeGreaterThan(30);
    flush();
    expect(tipOf(cursors()[0])).toEqual(aim(other));
  });

  it('re-plans a flight whose target moves 24 px or more, from where it is', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    step(4);
    const before = tipOf(cursors()[0])!;
    const moved: Box = { ...TILE, left: TILE.left + 400 };
    boxes.set(tile, moved);
    step(1);
    const after = tipOf(cursors()[0])!;
    // No jump to the new spot: the tip is still near where it was.
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(60);
    flush();
    expect(tipOf(cursors()[0])).toEqual(aim(moved));
  });
});

describe('a panel unmounting mid-flight re-plans: no jump, no fade (slice 6)', () => {
  it('dock closes under a flight to a row: the chain runs row, tab, rail and it flies on to the rail', () => {
    const tile = put('anchor', 'moodboard:b1/i1', { left: 900, top: 300, width: 160, height: 120 });
    const row = put('launcher', 'moodboard:b1', { left: 900, top: 100, width: 200, height: 40 });
    const tab = put('launcher', 'moodboard', { left: 880, top: 60, width: 80, height: 28 });
    const rail = put('launcher', 'moodboard', { left: 8, top: 400, width: 40, height: 40 });
    rail.setAttribute('data-rail-item', 'assets');
    renderLayer();
    send(event());
    step(5);
    const tips: { x: number; y: number }[] = [tipOf(cursors()[0])!];
    const opacities: number[] = [Number(cursors()[0].style.opacity)];
    // The dock closes: its tile, row and tab go in one frame.
    for (const el of [tile, row, tab]) el.remove();
    for (let i = 0; i < 120; i += 1) {
      step(1);
      tips.push(tipOf(cursors()[0])!);
      opacities.push(Number(cursors()[0].style.opacity));
    }
    // It landed beside the rail's button.
    expect(tips[tips.length - 1]).toEqual({ x: 8 + 40 + 6, y: 420 });
    // No jump: no frame stepped further than a flight of this length does (about 900 px over half a second).
    const steps = tips.slice(1).map((tip, i) => Math.hypot(tip.x - tips[i].x, tip.y - tips[i].y));
    expect(Math.max(...steps)).toBeLessThan(60);
    // No fade: the opacity never fell back.
    expect(Math.min(...opacities.slice(1))).toBeGreaterThanOrEqual(opacities[0] - 0.01);
  });

  it('a dock that closes on a resting cursor sends it on to the rail', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    const rail = put('launcher', 'moodboard', { left: 8, top: 400, width: 40, height: 40 });
    rail.setAttribute('data-rail-item', 'assets');
    renderLayer();
    send(event());
    flush();
    tile.remove();
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual({ x: 54, y: 420 });
  });
});

describe('several agents in one panel (design section 4 holds)', () => {
  it('show their names at two, and the second lands in a column under the first', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ ...session('a', 1) }));
    flush();
    // One cursor on a surface: no name pill (it shows on a first sighting, then goes).
    send(event({ ...session('b', 2) }));
    flush();
    const [first, second] = cursors();
    expect(first.querySelector('.agent-cursor__name')).not.toBeNull();
    expect(second.querySelector('.agent-cursor__name')).not.toBeNull();
    const a = tipOf(first)!;
    const b = tipOf(second)!;
    expect(b.x).toBe(a.x);
    expect(b.y).toBeGreaterThanOrEqual(a.y + 42);
  });

  it('two agents on different tiles each rest on their own tile', () => {
    const other: Box = { left: 700, top: 200, width: 160, height: 120 };
    put('anchor', 'moodboard:b1/i1', TILE);
    put('anchor', 'moodboard:b1/i2', other);
    renderLayer();
    send(event({ ...session('a', 1) }));
    send(event({ ...session('b', 2), target: { surface: 'moodboard', itemId: 'b1/i2' } }));
    flush();
    expect(cursors().map((el) => tipOf(el))).toEqual([aim(TILE), aim(other)]);
  });
});

describe('type always shows a caret on the screen layer (GM, 2026-11-05)', () => {
  // The Studio has no field caret in this PR: type shows one on the say pill's end while it
  // shows, and beside the tip otherwise, as the shared field does for any non-node target.
  const sayCaret = () => document.querySelector('.agent-cursor__say .agent-cursor__say-caret');
  const tipCaret = () => document.querySelector('.agent-cursor__tip-caret');

  it('ends the say pill while the say shows, with nothing doubled on the tip', () => {
    put('anchor', 'moodboard:b1:direction', TILE);
    renderLayer();
    send(event({ action: 'type', target: { surface: 'moodboard', itemId: 'b1', part: 'direction' }, say: 'Writing the direction' }));
    flush();
    expect(cursors()[0].dataset.expr).toBe('type');
    expect(sayCaret()).not.toBeNull();
    expect(tipCaret()).toBeNull();
  });

  it('moves onto the cursor, beside the tip, once the say\'s hold ends', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      put('anchor', 'moodboard:b1/i1', TILE);
      renderLayer();
      send(event({ action: 'type', say: 'Writing a note' }));
      flush();
      expect(sayCaret()).not.toBeNull();
      expect(tipCaret()).toBeNull();
      act(() => { vi.advanceTimersByTime(3000 + AGENT_SAY_FADE_MS + 100); });
      expect(document.querySelector('.agent-cursor__say')).toBeNull();
      expect(cursors()[0].dataset.expr).toBe('type');
      expect(tipCaret()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a count cursor that is typing has no say pill, so the caret sits beside its tip', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    for (const [i, key] of ['a', 'b', 'c', 'd'].entries()) {
      send(event({ ...session(key, i + 1), action: 'type', say: 'Writing' }));
      flush();
    }
    const counting = document.querySelector<HTMLElement>('.agent-screen-layer .agent-cursor[data-count]')!;
    expect(counting).not.toBeNull();
    expect(counting.querySelector('.agent-cursor__say')).toBeNull();
    expect(counting.querySelector('.agent-cursor__tip-caret')).not.toBeNull();
  });
});

describe('item outlines: type solid, propose dashed, nested 2 px for two agents, +N from three (GM 3)', () => {
  const settle = () => flush();

  it('draws a solid ring on the item once a typing cursor has landed, and none while it flies', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'type' }));
    step(2);
    expect(rings()).toHaveLength(0);
    settle();
    expect(rings()).toHaveLength(1);
    const ring = rings()[0];
    expect(ring.dataset.kind).toBe('solid');
    expect(ring.style.left).toBe('300px');
    expect(ring.style.top).toBe('200px');
    expect(ring.style.width).toBe('160px');
    expect(ring.style.height).toBe('120px');
    expect(ring.style.getPropertyValue('--agent-color')).toBe('#E8825A');
  });

  it('is dashed for propose', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'propose' }));
    settle();
    expect(rings()[0].dataset.kind).toBe('dashed');
  });

  it('draws none for any other action', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    for (const action of ['move', 'look', 'click', 'think', 'run']) {
      send(event({ action }));
      settle();
      expect(rings(), action).toHaveLength(0);
    }
  });

  it('is clipped to where the item shows', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    clipOf = () => ({ left: 0, top: 0, width: 1440, height: 260 });
    renderLayer();
    send(event({ action: 'type' }));
    settle();
    expect(rings()[0].style.height).toBe('60px');
  });

  it('two agents on one item nest 2 px apart, the earlier one innermost', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ ...session('a', 1), action: 'type', since: 1 }));
    settle();
    send(event({ ...session('b', 2), action: 'type', since: 2 }));
    settle();
    expect(rings()).toHaveLength(2);
    const [inner, outer] = rings().sort((x, y) => Number(x.dataset.ring) - Number(y.dataset.ring));
    expect(Number(inner.dataset.ring)).toBe(0);
    expect(inner.style.left).toBe('300px');
    expect(outer.style.left).toBe('298px');
    expect(outer.style.top).toBe('198px');
    expect(outer.style.width).toBe('164px');
    expect(outer.style.height).toBe('124px');
  });

  it('a third agent adds no third ring: the outermost carries +1', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      send(event({ ...session(key, i + 1), action: 'type', since: i + 1 }));
      settle();
    }
    expect(rings()).toHaveLength(2);
    const outer = rings().find((ring) => ring.dataset.ring === '1')!;
    expect(outer.querySelector('.agent-item-outline__more')?.textContent).toBe('+1');
    expect(rings().find((ring) => ring.dataset.ring === '0')!.querySelector('.agent-item-outline__more')).toBeNull();
  });

  it('holds at least 0.4 s after the action changes, then goes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      put('anchor', 'moodboard:b1/i1', TILE);
      renderLayer();
      send(event({ action: 'type' }));
      settle();
      expect(rings()).toHaveLength(1);
      send(event({ action: 'click' }));
      settle();
      expect(rings()).toHaveLength(1); // under 0.4 s: still shown
      act(() => { vi.advanceTimersByTime(450); });
      expect(rings()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rides a scroll with its item', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'type' }));
    settle();
    boxes.set(tile, { ...TILE, top: 420 });
    act(() => { document.dispatchEvent(new Event('scroll')); });
    step(3);
    expect(rings()[0].style.top).toBe('420px');
  });
});

describe('reduced motion: every new behaviour snaps', () => {
  beforeEach(() => reduceMotion(true));

  it('lands on the tile in its first frame, with no entrance', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    step(1);
    expect(tipOf(cursors()[0])).toEqual(aim(TILE));
    expect(cursors()[0].style.opacity).toBe('1');
  });

  it('goes to a new tile at once, never a flight', () => {
    const other: Box = { left: 900, top: 500, width: 160, height: 120 };
    put('anchor', 'moodboard:b1/i1', TILE);
    put('anchor', 'moodboard:b1/i2', other);
    renderLayer();
    send(event());
    flush();
    send(event({ target: { surface: 'moodboard', itemId: 'b1/i2' } }));
    step(1);
    expect(tipOf(cursors()[0])).toEqual(aim(other));
  });

  it('follows a scroll in its first frame, and a first resolution after none lands in one', () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event());
    flush();
    boxes.set(tile, { ...TILE, top: 500 });
    act(() => { document.dispatchEvent(new Event('scroll')); });
    step(2);
    expect(tipOf(cursors()[0])).toEqual(aim({ ...TILE, top: 500 }));
  });

  it('shows its outline the frame it lands', () => {
    put('anchor', 'moodboard:b1/i1', TILE);
    renderLayer();
    send(event({ action: 'type' }));
    step(2);
    flush();
    expect(rings()).toHaveLength(1);
  });
});

describe('the layer never opens, scrolls or pans anything for the person', () => {
  it('calls no scroll method through a flight, a scroll, a remove and an outline', async () => {
    const tile = put('anchor', 'moodboard:b1/i1', TILE);
    put('launcher', 'moodboard', { left: 20, top: 400, width: 40, height: 40 });
    renderLayer();
    send(event({ action: 'type' }));
    flush();
    boxes.set(tile, { ...TILE, top: 700 });
    act(() => { document.dispatchEvent(new Event('scroll')); });
    flush();
    tile.remove();
    await dom();
    flush();
    expect(scrolled).not.toHaveBeenCalled();
  });
});
