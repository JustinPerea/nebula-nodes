import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import { clampToClip, domEnv, type Box, type ResolverEnv } from '../src/lib/agentAnchorResolve';
import { registerBoardView, type BoardCardRect } from '../src/lib/agentBoardView';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';

/**
 * Phase 3 slice 7b: a Board view card panned fully out of the pane has no DOM
 * element (onlyRenderVisibleElements), so the cursor parks at the pane's edge
 * from the card's position and the camera, with the chevron, instead of
 * falling back to the board's launcher.
 */

let frames: FrameRequestCallback[] = [];
let clock = 0;
const step = (n = 1) => act(() => {
  for (let i = 0; i < n && frames.length > 0; i += 1) {
    const run = frames;
    frames = [];
    clock += 1000 / 60;
    for (const callback of run) callback(clock);
  }
});
const flush = () => step(600);

const PANE: Box = { left: 200, top: 100, width: 800, height: 600 };
const boxes = new Map<Element, Box>();
let paneEl: HTMLElement;
let camera = { x: 0, y: 0, zoom: 1 };
let cards: BoardCardRect[] = [];
const listeners = new Set<() => void>();
const CARD = { imageId: 'i1', width: 160, height: 120 };

const screenBox = (card: BoardCardRect): Box => ({ left: PANE.left + camera.x + card.x * camera.zoom,
  top: PANE.top + camera.y + card.y * camera.zoom, width: card.width * camera.zoom, height: card.height * camera.zoom });
/** The page as the Board view leaves it: a card in view has an element, one culled has none. */
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => PANE,
  culled: (board, image) => {
    const card = cards.find((c) => c.imageId === image);
    return board === 'b1' && card ? { box: screenBox(card), clip: PANE, element: paneEl } : null;
  },
};
/** The Board view mounting or unmounting a card as the camera moves. */
function sync(): void {
  for (const el of document.querySelectorAll('[data-agent-anchor]')) el.remove();
  for (const card of cards) {
    const box = screenBox(card);
    const visible = box.left + box.width > PANE.left && box.left < PANE.left + PANE.width
      && box.top + box.height > PANE.top && box.top < PANE.top + PANE.height;
    if (!visible) continue;
    const el = document.createElement('div');
    el.setAttribute('data-agent-anchor', `moodboard:b1/${card.imageId}`);
    document.body.appendChild(el);
    boxes.set(el, box);
  }
  for (const listener of [...listeners]) listener();
}
const pan = (x: number, y: number) => { camera = { ...camera, x, y }; act(() => sync()); step(2); };

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
const aim = (box: Box) => ({ x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 24) });
const scrolled = vi.fn();
let unregister: () => void = () => {};

beforeEach(() => {
  frames = [];
  clock = 0;
  boxes.clear();
  listeners.clear();
  camera = { x: 0, y: 0, zoom: 1 };
  cards = [{ ...CARD, x: 300, y: 200 }];
  paneEl = document.createElement('div');
  document.body.appendChild(paneEl);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  scrolled.mockReset();
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy'] as const) {
    (Element.prototype as unknown as Record<string, unknown>)[name] = scrolled;
  }
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: { boardId: 'b1', boardKey: 'b1', imageIds: ['i1'] } });
  unregister = registerBoardView({ boardId: 'b1', pane: () => paneEl, camera: () => camera, cards: () => cards,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); } });
});
afterEach(() => {
  unregister();
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: null });
});

const renderLayer = () => render(<AgentScreenLayer canvasMounted={false} env={env} />);

describe('a Board view card panned out of the pane (PR #233 slice 7b)', () => {
  it('parks at the pane\'s nearest edge with the chevron toward the card, not at the launcher', () => {
    // The Assets dock's row for the board is open too: the old fallback would have flown there.
    const row = document.createElement('div');
    row.setAttribute('data-agent-launcher', 'moodboard:b1');
    document.body.appendChild(row);
    boxes.set(row, { left: 20, top: 400, width: 200, height: 40 });
    pan(-1500, 0); // the card is far to the left of the pane
    expect(document.querySelector('[data-agent-anchor]')).toBeNull();
    renderLayer();
    send(event());
    flush();
    const tip = tipOf(cursors()[0])!;
    const toward = aim(screenBox(cards[0]));
    expect(tip.x).toBeCloseTo(PANE.left + 12, 0);
    expect(tip).toEqual(expect.objectContaining({ x: expect.closeTo(clampToClip(toward, PANE).point.x, 0) }));
    expect(chevron()).not.toBeNull();
    expect(Math.cos(angleOf(chevron()!))).toBeLessThan(-0.95);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('parks at the bottom edge for a card panned up out of view', () => {
    pan(0, -1200);
    renderLayer();
    send(event());
    flush();
    expect(tipOf(cursors()[0])!.y).toBeCloseTo(PANE.top + 12, 0);
    expect(Math.sin(angleOf(chevron()!))).toBeLessThan(-0.9);
  });

  it('follows the camera while the card stays out, and the chevron turns with it', () => {
    pan(-1500, 0);
    renderLayer();
    send(event());
    flush();
    pan(0, -1500); // now it is above the pane
    flush();
    expect(tipOf(cursors()[0])!.y).toBeCloseTo(PANE.top + 12, 0);
    expect(Math.sin(angleOf(chevron()!))).toBeLessThan(-0.9);
  });

  it('panning it back in glides the cursor onto it, and the chevron goes', () => {
    pan(-1500, 0);
    renderLayer();
    send(event());
    flush();
    const parked = tipOf(cursors()[0])!;
    pan(0, 0);
    const first = tipOf(cursors()[0])!;
    expect(Math.hypot(first.x - parked.x, first.y - parked.y)).toBeLessThan(60);
    flush();
    const want = aim(screenBox(cards[0]));
    expect(tipOf(cursors()[0])).toEqual({ x: want.x, y: want.y });
    expect(chevron()).toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
  });

  it('a card on another board is not this board\'s', () => {
    pan(-1500, 0);
    renderLayer();
    send(event({ target: { surface: 'moodboard', itemId: 'other/i1' } }));
    flush();
    expect(chevron()).toBeNull();
  });
});

describe('the camera maths in the page\'s own environment (domEnv)', () => {
  it('works out the card\'s rect the way React Flow does: pane + translate + position x zoom', () => {
    paneEl.getBoundingClientRect = () => ({ left: 50, top: 40, width: 500, height: 400, right: 550, bottom: 440, x: 50, y: 40, toJSON: () => ({}) });
    camera = { x: 100, y: -20, zoom: 2 };
    cards = [{ imageId: 'i1', x: 10, y: 30, width: 80, height: 60 }];
    const found = domEnv().culled!('b1', 'i1')!;
    expect(found.box).toEqual({ left: 50 + 100 + 20, top: 40 - 20 + 60, width: 160, height: 120 });
    expect(found.clip).toEqual({ left: 50, top: 40, width: 500, height: 400 });
    expect(found.element).toBe(paneEl);
    expect(domEnv().culled!('b2', 'i1')).toBeNull();
    expect(domEnv().culled!('b1', 'nope')).toBeNull();
  });
});
