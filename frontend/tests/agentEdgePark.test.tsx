import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import { clampToClip, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { arrowExitPx, parkChevron, parkLabelNudge, PARK_CHEVRON_GAP_PX, PARK_CHEVRON_PX, PARK_LABEL_CLEAR_PX, PARK_LABEL_INSET_PX } from '../src/lib/agentCursorPark';
import { AGENT_CURSOR_ARROW_TOP, AGENT_CURSOR_PILL } from '../src/lib/agentCursorLook';
import { AGENT_CURSOR_ARROW_POINTS, AGENT_CURSOR_ARROW_STROKE, AGENT_CURSOR_ARROW_TIP } from '../src/lib/agentCursorLook';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';

/**
 * Phase 3 slice 7: the edge park and its chevron. A target inside an open
 * panel but scrolled out of view (the List view scrolled, the Board view
 * panned away) parks the cursor just inside the panel's edge, nearest the
 * item, as a clamp; a 6 px chevron in the agent colour points toward the item.
 * Nebula never scrolls or pans the panel.
 */

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

const boxes = new Map<Element, Box>();
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
/** The panel's own scroll area: what an item in it is visible through. */
const LIST: Box = { left: 880, top: 100, width: 300, height: 500 };
let clip: Box = LIST;
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => clip,
};
function put(attr: 'anchor' | 'launcher', value: string, box: Box): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(`data-agent-${attr}`, value);
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
}
const aim = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 24) });
const tile = (top: number, left = 900): Box => ({ left, top, width: 160, height: 120 });

const event = (overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { surface: 'moodboard', itemId: 'b1/i1' },
  anchorNames: { board: 'Desert light', image: 22 },
  action: 'click',
  say: 'Looking at image 22',
  at: 0,
  ...overrides,
});
const send = (e: AgentPresenceEvent) => act(() => { useAgentPresenceStore.getState().apply(e); });
const cursors = () => [...document.querySelectorAll<HTMLElement>('.agent-screen-layer .agent-cursor')];
const tipOf = (el: HTMLElement) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
  return m ? { x: +m[1], y: +m[2] } : null;
};
const chevron = () => document.querySelector<SVGElement>('.agent-cursor__park-chevron');
const angleOf = (el: Element) => Number((el as HTMLElement).style.getPropertyValue('--park-angle').replace('rad', ''));
/** The drawn cursor's extent in client px, worked out from the tuning constants and the placed chevron. */
const drawn = (el: HTMLElement) => {
  const tip = tipOf(el)!;
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  const arrowRight = tip.x + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - AGENT_CURSOR_ARROW_TIP.x + half;
  const arrowBottom = tip.y + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) - AGENT_CURSOR_ARROW_TIP.y + half;
  // The chevron is stroked 1.5 px (agentCursorAnywhere.css): its drawn reach is the half stroke beyond its box.
  const c = chevron() as unknown as HTMLElement | null;
  const px = (name: string) => Number(c!.style.getPropertyValue(name).replace('px', ''));
  const chevronRight = c ? tip.x + px('--park-x') - AGENT_CURSOR_ARROW_TIP.x + PARK_CHEVRON_PX / 2 + 0.75 : -Infinity;
  const chevronBottom = c ? tip.y + px('--park-y') - AGENT_CURSOR_ARROW_TIP.y + PARK_CHEVRON_PX / 2 + 0.75 : -Infinity;
  return { arrowRight, arrowBottom, chevronRight, chevronBottom,
    right: Math.max(arrowRight, chevronRight), bottom: Math.max(arrowBottom, chevronBottom) };
};
const near = (a: { x: number; y: number }, b: { x: number; y: number }, within = 1) =>
  Math.hypot(a.x - b.x, a.y - b.y) <= within;

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
  clip = LIST;
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
});

const renderLayer = () => render(<AgentScreenLayer canvasMounted={false} env={env} />);

describe('the clamp: just inside the panel\'s top or bottom edge, nearest the item (PR #233 slice 7)', () => {
  it('parks 12 px inside the bottom edge for an item scrolled out below, still near it in x', () => {
    put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    const tip = tipOf(cursors()[0])!;
    // The list's bottom edge is y 600: the drawn cursor ends 12 px inside it, so the tip is higher.
    expect(drawn(cursors()[0]).bottom).toBeCloseTo(LIST.top + LIST.height - 12, 0);
    // Along the line from the panel's middle toward the item: left of centre, as the item is.
    expect(tip.x).toBeGreaterThan(LIST.left + 12);
    expect(tip.x).toBeLessThan(aim(tile(900)).x + 40);
    expect(near(tip, clampToClip(aim(tile(900)), LIST).point)).toBe(true);
  });

  it('parks 12 px inside the top edge for an item scrolled out above', () => {
    put('anchor', 'moodboard:b1/i1', tile(-300));
    renderLayer();
    send(event());
    flush();
    expect(tipOf(cursors()[0])!.y).toBeCloseTo(LIST.top + 12, 0);
  });

  it('carries its say pill with it', () => {
    put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    expect(cursors()[0].querySelector('.agent-cursor__say')?.textContent).toBe('Looking at image 22');
  });

  it('the Board view: panned away to the left, it parks inside the pane\'s left edge', () => {
    clip = { left: 200, top: 100, width: 800, height: 600 };
    put('anchor', 'moodboard:b1/i1', { left: -400, top: 300, width: 160, height: 120 });
    renderLayer();
    send(event());
    flush();
    expect(tipOf(cursors()[0])!.x).toBeCloseTo(200 + 12, 0);
    expect(Math.cos(angleOf(chevron()!))).toBeLessThan(-0.99); // pointing left, toward the board
  });

  it('sticks at the edge while the person scrolls the item in the same direction, and never calls a scroll', () => {
    const el = put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    const parked = tipOf(cursors()[0])!;
    for (const top of [860, 820, 780, 740]) {
      boxes.set(el, tile(top));
      act(() => { document.dispatchEvent(new Event('scroll')); });
      step(3);
      // The clamp slides along the edge a little (its line from the middle moves with the item), never inward.
      expect(tipOf(cursors()[0])!.y).toBeCloseTo(parked.y, 0);
    }
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('the chevron', () => {
  it('points toward the item: down for one below, up for one above', () => {
    const el = put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    expect(chevron()).not.toBeNull();
    const tip = tipOf(cursors()[0])!;
    const toward = aim(tile(900));
    expect(angleOf(chevron()!)).toBeCloseTo(Math.atan2(toward.y - tip.y, toward.x - tip.x), 2);
    expect(Math.sin(angleOf(chevron()!))).toBeGreaterThan(0.9);
    boxes.set(el, tile(-400));
    act(() => { document.dispatchEvent(new Event('scroll')); });
    flush();
    expect(Math.sin(angleOf(chevron()!))).toBeLessThan(-0.9);
  });

  it('is in the agent colour, 6 px, and not a control', () => {
    put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    const el = chevron()!;
    expect(el.getAttribute('width')).toBe(String(PARK_CHEVRON_PX));
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.closest('.agent-cursor')).toBe(cursors()[0]);
  });

  it('is drawn only while parked at an edge: not on a visible item, not at a launcher', async () => {
    const el = put('anchor', 'moodboard:b1/i1', tile(300));
    renderLayer();
    send(event());
    flush();
    expect(chevron()).toBeNull();
    boxes.set(el, tile(900));
    act(() => { document.dispatchEvent(new Event('scroll')); });
    flush();
    expect(chevron()).not.toBeNull();
    el.remove();
    put('launcher', 'moodboard:b1', { left: 900, top: 100, width: 200, height: 40 });
    await act(async () => { await Promise.resolve(); });
    flush();
    expect(chevron()).toBeNull();
  });

  it('keeps clear of the arrow: 4 px beyond its box when the item is below or right, at 4 px from the tip otherwise', () => {
    // Above or to the left of the tip the arrow is not in the way.
    expect(parkChevron({ x: 100, y: 100 }, { x: 100, y: 0 }).distance).toBeCloseTo(PARK_CHEVRON_GAP_PX + PARK_CHEVRON_PX / 2, 5);
    expect(parkChevron({ x: 100, y: 100 }, { x: 0, y: 100 }).distance).toBeCloseTo(PARK_CHEVRON_GAP_PX + PARK_CHEVRON_PX / 2, 5);
    // Below it the arrow is: past its tail.
    expect(parkChevron({ x: 100, y: 100 }, { x: 100, y: 500 }).distance).toBeCloseTo(arrowExitPx(Math.PI / 2) + 7, 5);
    expect(arrowExitPx(Math.PI / 2)).toBeGreaterThan(15);
    expect(parkChevron({ x: 0, y: 0 }, { x: 10, y: 10 }).angle).toBeCloseTo(Math.PI / 4, 5);
  });

  it('an item a pixel left of straight below still puts the chevron past the arrow\'s tail, not under it (found by the bottom-park shot)', () => {
    const straightDown = arrowExitPx(Math.PI / 2);
    // The tip's x is 1 px right of the item's middle: the angle is a hair past vertical, cos < 0.
    for (const dxPx of [-0.5, -1, -3, 3, 0]) {
      const { angle, distance } = parkChevron({ x: 100, y: 100 }, { x: 100 + dxPx, y: 600 });
      expect(distance, `dx ${dxPx}`).toBeGreaterThan(straightDown - 1);
      // The chevron's middle is clear of the arrow's box below its tail.
      expect(Math.sin(angle) * distance).toBeGreaterThan(straightDown);
    }
    // Same on the right side, a hair above or below horizontal.
    for (const dyPx of [-0.5, 0.5, -3]) {
      const { distance } = parkChevron({ x: 100, y: 100 }, { x: 900, y: 100 + dyPx });
      expect(distance).toBeGreaterThan(arrowExitPx(0) - 1);
    }
    // Clearly up or left is unchanged: leaves at once.
    expect(arrowExitPx(-Math.PI / 2)).toBe(0);
    expect(arrowExitPx(Math.PI)).toBe(0);
    expect(arrowExitPx(-Math.PI / 4)).toBe(0);
  });
});

describe('the cursor glides into the item as the person scrolls it in', () => {
  it('flies from the edge to the item, not a jump', () => {
    const el = put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    flush();
    const parked = tipOf(cursors()[0])!;
    // The person scrolls it right into the middle of the list.
    boxes.set(el, tile(300));
    act(() => { document.dispatchEvent(new Event('scroll')); });
    step(2);
    const first = tipOf(cursors()[0])!;
    expect(Math.hypot(first.x - parked.x, first.y - parked.y)).toBeLessThan(40);
    expect(Math.hypot(first.x - aim(tile(300)).x, first.y - aim(tile(300)).y)).toBeGreaterThan(20);
    flush();
    expect(tipOf(cursors()[0])).toEqual(aim(tile(300)));
    expect(chevron()).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });
});

describe('reduced motion: a still frame', () => {
  it('lands on the clamp in its first frame with the chevron drawn, no entrance, no glide', () => {
    reduceMotion(true);
    put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    step(1);
    expect(near(tipOf(cursors()[0])!, clampToClip(aim(tile(900)), LIST).point)).toBe(true);
    expect(chevron()).not.toBeNull();
    expect(Number(cursors()[0].style.opacity)).toBe(1);
  });

  it('goes to the item the frame it comes into view', () => {
    reduceMotion(true);
    const el = put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event());
    step(1);
    boxes.set(el, tile(300));
    act(() => { document.dispatchEvent(new Event('scroll')); });
    step(2);
    expect(tipOf(cursors()[0])).toEqual(aim(tile(300)));
  });
});

// The window is the clip when nothing else is: an item below the page's own edge parks inside the window.
describe('the window is a clip too', () => {
  it('an item below the window parks inside the window\'s bottom edge', () => {
    clip = VIEW;
    put('anchor', 'moodboard:b1/i1', tile(1500, 700));
    renderLayer();
    send(event());
    flush();
    expect(drawn(cursors()[0]).bottom).toBeCloseTo(VIEW.height - 12, 0);
  });
});

describe('the whole drawn cursor stays 12 px inside the clip (slice 10b)', () => {
  const inside = (box: Box) => {
    put('anchor', 'moodboard:b1/i1', box);
    renderLayer();
    send(event());
    flush();
    return drawn(cursors()[0]);
  };
  it('bottom park in the List clip: arrow and chevron both end 12 px above the edge', () => {
    const d = inside(tile(900));
    expect(d.arrowBottom).toBeLessThanOrEqual(LIST.top + LIST.height - 12 + 0.5);
    expect(d.chevronBottom).toBeLessThanOrEqual(LIST.top + LIST.height - 12 + 0.5);
    expect(d.bottom).toBeCloseTo(LIST.top + LIST.height - 12, 0);
    expect(Math.sin(angleOf(chevron()!))).toBeGreaterThan(0.9);
  });
  it('bottom park with the window as the clip', () => {
    clip = VIEW;
    const d = inside(tile(1500, 700));
    expect(d.bottom).toBeCloseTo(VIEW.height - 12, 0);
    expect(d.chevronBottom).toBeLessThanOrEqual(VIEW.height - 12 + 0.5);
  });
  it('right park: arrow and chevron end 12 px inside the right edge', () => {
    const d = inside({ left: 2000, top: 300, width: 160, height: 120 });
    expect(d.right).toBeCloseTo(LIST.left + LIST.width - 12, 0);
    expect(d.chevronRight).toBeLessThanOrEqual(LIST.left + LIST.width - 12 + 0.5);
    expect(d.arrowRight).toBeLessThanOrEqual(LIST.left + LIST.width - 12 + 0.5);
  });
  it('right park with the window as the clip', () => {
    clip = VIEW;
    expect(inside({ left: 3000, top: 300, width: 160, height: 120 }).right).toBeCloseTo(VIEW.width - 12, 0);
  });
  it('top and left parks are unchanged: the tip 12 px inside', () => {
    put('anchor', 'moodboard:b1/i1', tile(-300));
    renderLayer();
    send(event());
    flush();
    expect(tipOf(cursors()[0])!.y).toBeCloseTo(LIST.top + 12, 0);
    cleanup();
    document.body.innerHTML = '';
    boxes.clear();
    useAgentPresenceStore.getState().clear();
    put('anchor', 'moodboard:b1/i1', { left: -400, top: 300, width: 160, height: 120 });
    renderLayer();
    send(event());
    flush();
    expect(tipOf(cursors()[0])!.x).toBeCloseTo(LIST.left + 12, 0);
  });
});

describe('a parked cursor\'s pills stay inside the panel and clear of the chevron (GM r136, ruling 4)', () => {
  const NAME_W = 52;
  const SAY_W = 191; // "Added 3 images to “Desert light”"
  /** The pills' box after the nudge, the arrow's box and the chevron's, all client px. */
  function placed(origin: { x: number; y: number }, toward: { x: number; y: number }, over: { clip?: Box; nameShown?: boolean; sayW?: number } = {}) {
    const area = over.clip ?? LIST;
    const clipBox = { left: area.left, top: area.top, right: area.left + area.width, bottom: area.top + area.height };
    const { angle, distance } = parkChevron(origin, toward);
    const chevronAt = { x: origin.x + AGENT_CURSOR_ARROW_TIP.x + Math.cos(angle) * distance, y: origin.y + AGENT_CURSOR_ARROW_TIP.y + Math.sin(angle) * distance };
    const nameShown = over.nameShown ?? true;
    const sayW = over.sayW ?? SAY_W;
    const nudge = parkLabelNudge({ origin, clip: clipBox, nameShown, nameW: NAME_W, sayW, chevron: chevronAt });
    const { left, top, height, gap, ring } = AGENT_CURSOR_PILL;
    const width = Math.max(nameShown ? NAME_W + ring : 0, sayW);
    const h = (nameShown ? height + gap : 0) + height;
    const box = { left: origin.x + left + nudge.x, top: origin.y + top + nudge.y, right: origin.x + left + nudge.x + width, bottom: origin.y + top + nudge.y + h };
    const half = AGENT_CURSOR_ARROW_STROKE / 2;
    const arrow = {
      left: origin.x + Math.min(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - half, right: origin.x + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) + half,
      top: origin.y + AGENT_CURSOR_ARROW_TOP, bottom: origin.y + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) + half,
    };
    const reach = PARK_CHEVRON_PX / 2 + 0.75;
    const chev = { left: chevronAt.x - reach, right: chevronAt.x + reach, top: chevronAt.y - reach, bottom: chevronAt.y + reach };
    return { nudge, box, arrow, chev, clipBox };
  }
  const meets = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }, pad: number) =>
    a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
  const inside = (r: ReturnType<typeof placed>) => {
    expect(r.box.left).toBeGreaterThanOrEqual(r.clipBox.left + PARK_LABEL_INSET_PX - 0.01);
    expect(r.box.right).toBeLessThanOrEqual(r.clipBox.right - PARK_LABEL_INSET_PX + 0.01);
    expect(r.box.top).toBeGreaterThanOrEqual(r.clipBox.top + PARK_LABEL_INSET_PX - 0.01);
    expect(r.box.bottom).toBeLessThanOrEqual(r.clipBox.bottom - PARK_LABEL_INSET_PX + 0.01);
    // Where it already is clears the arrow by design (the boxes touch at a corner by a fraction of a px).
    if (r.nudge.x !== 0 || r.nudge.y !== 0) expect(meets(r.box, r.arrow, 0)).toBe(false);
    expect(meets(r.box, r.chev, PARK_LABEL_CLEAR_PX - 0.01)).toBe(false);
  };

  it('a bottom park in the shot\'s panel (a 191 px say, 346 px wide): moved above the arrow and in from the right', () => {
    // The shot: a tip 31 px above the 884 px edge of a panel from x 70 to 416, at x 243.
    const clip = { left: 70, top: 16, width: 346, height: 868 };
    const r = placed({ x: 243, y: 826 }, { x: 200, y: 1500 }, { clip });
    expect(r.nudge.y).toBeLessThan(0);
    inside(r);
    // Unmoved, it would have run past the right edge and under the bottom.
    const home = { right: 243 + AGENT_CURSOR_PILL.left + SAY_W, bottom: 826 + AGENT_CURSOR_PILL.top + 44 };
    expect(home.right).toBeGreaterThan(416 - PARK_LABEL_INSET_PX);
    expect(home.bottom).toBeGreaterThan(884 - PARK_LABEL_INSET_PX);
  });

  it('with the name hidden (the say alone) it is still inside and clear', () => {
    inside(placed({ x: 243, y: 826 }, { x: 200, y: 1500 }, { clip: { left: 70, top: 16, width: 346, height: 868 }, nameShown: false }));
  });

  it('a right park, a top park and a left park', () => {
    inside(placed({ x: 1150 - 30, y: 300 }, { x: 3000, y: 300 })); // right edge of LIST
    inside(placed({ x: 1000, y: LIST.top + 12 }, { x: 1000, y: -500 }));
    inside(placed({ x: LIST.left + 12, y: 300 }, { x: -500, y: 300 }));
  });

  it('leaves a pill alone where it already fits', () => {
    expect(placed({ x: 900, y: 200 }, { x: 900, y: 1500 }, { sayW: 90 }).nudge).toEqual({ x: 0, y: 0 });
  });

  it('on the page: a bottom park\'s label carries the offset, set from the say\'s measured width', () => {
    put('anchor', 'moodboard:b1/i1', tile(900));
    renderLayer();
    send(event({ say: 'Added 3 images to “Desert light”' }));
    flush();
    const el = cursors()[0];
    expect(el.style.getPropertyValue('--label-dy')).not.toBe('');
    expect(Number.parseFloat(el.style.getPropertyValue('--label-dy'))).toBeLessThan(0);
  });

  it('a cursor on its item (not parked) has no offset', () => {
    put('anchor', 'moodboard:b1/i1', tile(150));
    renderLayer();
    send(event({ say: 'Added 3 images to “Desert light”' }));
    flush();
    expect(cursors()[0].style.getPropertyValue('--label-dy')).toBe('');
    expect(cursors()[0].style.getPropertyValue('--label-dx')).toBe('');
  });
});
