import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import { clampToClip, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { arrowExitPx, parkChevron, PARK_CHEVRON_GAP_PX, PARK_CHEVRON_PX } from '../src/lib/agentCursorPark';
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
    // The list's bottom edge is y 600; 12 px inside it.
    expect(tip.y).toBeCloseTo(LIST.top + LIST.height - 12, 0);
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
    expect(tipOf(cursors()[0])!.y).toBeCloseTo(VIEW.height - 12, 0);
  });
});
