import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { cursorHandoff } from '../src/lib/agentCursorHandoff';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';
import { useStudioCharacterStore } from '../src/store/studioCharacterStore';

/**
 * The screen layer on Characters and Styles, in jsdom over a fake page (the
 * harness of agentScreenLayer.test.tsx): the default lines on the cursor, the
 * item outline on a Style's row and card while an agent types, a removed
 * reference view that holds the spot, and the dot on the launcher the rail's
 * one button is for every surface.
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
const event = (overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { surface: 'style', itemId: 's1' },
  anchorNames: { style: 'Dusk grain' },
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
  // An event is never older than its own arrival: on a loaded machine the real time between `send` and
  // the first frame made it stale, and a stale event snaps (the flight test saw no flight).
  vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000);
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
  cursorHandoff.reset(); // a process-wide registry: a claim left by one test is not the next one's
  useBoardCanvasStore.setState({ studioBoard: null });
  useStudioCharacterStore.setState({ studioCharacter: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: null });
  useStudioCharacterStore.setState({ studioCharacter: null });
});

const say = () => cursors()[0].querySelector('.agent-cursor__say')?.textContent;
const dots = () => [...document.querySelectorAll<HTMLElement>('.agent-launcher-dot:not([data-leaving])')];
const CARD: Box = { left: 700, top: 500, width: 160, height: 180 };

describe('the default lines ride on the cursor', () => {
  it('a Style: Looking at it, and Renaming it for a type on its name', () => {
    put('anchor', 'style:s1', TILE);
    renderLayer();
    send(event({ action: 'look' }));
    flush();
    expect(say()).toBe('Looking at “Dusk grain”');
    send(event({ action: 'type', target: { surface: 'style', itemId: 's1', part: 'name' }, anchorNames: { style: 'Dusk grain', part: 'name' } }));
    flush();
    expect(say()).toBe('Renaming “Dusk grain”');
  });

  it('a Character: the character, its cover, a view, and a control', () => {
    put('anchor', 'character:c1', TILE);
    renderLayer();
    const look = (target: AgentPresenceEvent['target'], anchorNames: AgentPresenceEvent['anchorNames']) => {
      send(event({ action: 'look', target, anchorNames }));
      flush();
      return say();
    };
    expect(look({ surface: 'character', itemId: 'c1' }, { character: 'Mara' })).toBe('Looking at “Mara”');
    expect(look({ surface: 'character', itemId: 'c1/1' }, { character: 'Mara', view: 1 })).toBe('Looking at the cover of “Mara”');
    expect(look({ surface: 'character', itemId: 'c1/2' }, { character: 'Mara', view: 2 })).toBe('Looking at view 2 of “Mara”');
    expect(look({ surface: 'character', itemId: 'c1', part: 'traits' }, { character: 'Mara', part: 'Frozen trait string' }))
      .toBe('Looking at “Frozen trait string” on “Mara”');
  });

  it('the agent\'s own say still wins', () => {
    put('anchor', 'style:s1', TILE);
    renderLayer();
    send(event({ action: 'type', say: 'Making it grainier' }));
    flush();
    expect(say()).toBe('Making it grainier');
  });
});

describe('the item outline on a Style (the only sign of a write)', () => {
  it('draws solid on the dock row while an agent types, dashed while it proposes', () => {
    put('anchor', 'style:s1', TILE);
    renderLayer();
    send(event({ action: 'type', target: { surface: 'style', itemId: 's1', part: 'prompt' }, anchorNames: { style: 'Dusk grain', part: 'prompt' } }));
    flush();
    expect(rings()).toHaveLength(1);
    expect(rings()[0].dataset.kind).toBe('solid');
    expect([rings()[0].style.left, rings()[0].style.top, rings()[0].style.width, rings()[0].style.height]).toEqual(['300px', '200px', '160px', '120px']);
    send(event({ action: 'propose' }));
    flush();
    expect(rings()[0].dataset.kind).toBe('dashed');
  });

  it('draws on the card in Create\'s popover too', () => {
    put('anchor', 'style:s1', CARD);
    renderLayer();
    send(event({ action: 'type' }));
    flush();
    expect(rings()).toHaveLength(1);
    expect(rings()[0].style.left).toBe('700px');
    expect(rings()[0].style.height).toBe('180px');
  });

  it('draws none for look, and none while the style is only a launcher park', () => {
    put('launcher', 'style', { left: 900, top: 800, width: 70, height: 30 });
    renderLayer();
    send(event({ action: 'type' }));
    flush();
    expect(rings()).toHaveLength(0);
  });
});

describe('a removed reference view', () => {
  const view = (n: number) => event({
    action: 'look', target: { surface: 'character', itemId: `c1/${n}` }, anchorNames: { character: 'Mara', view: n },
  });

  it('holds the spot, though the character\'s row is right there', async () => {
    const tile = put('anchor', 'character:c1/3', TILE);
    put('launcher', 'character:c1', { left: 900, top: 100, width: 200, height: 40 });
    useStudioCharacterStore.setState({ studioCharacter: { characterId: 'c1', viewCount: 3 } });
    renderLayer();
    send(view(3));
    flush();
    const spot = tipOf(cursors()[0]);
    act(() => { useStudioCharacterStore.setState({ studioCharacter: { characterId: 'c1', viewCount: 2 } }); });
    tile.remove();
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual(spot);
  });

  it('a Studio that closed is not a removal: the cursor goes on to the character\'s row', async () => {
    const tile = put('anchor', 'character:c1/3', TILE);
    renderLayer();
    send(view(3));
    flush();
    tile.remove();
    put('launcher', 'character:c1', { left: 900, top: 100, width: 200, height: 40 });
    await dom();
    flush();
    expect(tipOf(cursors()[0])).toEqual({ x: 900 + 200 + 6, y: 120 });
  });
});

describe('the rail button, the launcher for every surface', () => {
  it('parks a character cursor and a style cursor at it, with a dot each, when no list is open', () => {
    const rail = put('launcher', 'moodboard character style', { left: 0, top: 300, width: 48, height: 48 });
    rail.setAttribute('data-rail-item', '');
    renderLayer();
    send(event({ target: { surface: 'character', itemId: 'c1' }, anchorNames: { character: 'Mara' }, ...session('a', 1) }));
    send(event({ agent: { id: 'gemini', name: 'Gemini', color: '#4A90D9', verified: true }, target: { surface: 'style', itemId: 's1' },
      anchorNames: { style: 'Dusk grain' }, ...session('b', 1) }));
    flush();
    // Both at the rail's button (6 px right of it); two cursors at one place stack in a column.
    const tips = cursors().map((el) => tipOf(el)!);
    expect(tips.map((tip) => tip.x)).toEqual([54, 54]);
    expect(tips[0].y).toBe(324);
    expect(tips[1].y).toBeGreaterThan(324);
    expect(dots()).toHaveLength(2);
  });

  it('a Characters tab beats the rail for a character, and a Styles tab for a style', () => {
    const rail = put('launcher', 'moodboard character style', { left: 0, top: 300, width: 48, height: 48 });
    rail.setAttribute('data-rail-item', '');
    put('launcher', 'character', { left: 100, top: 80, width: 90, height: 30 });
    put('launcher', 'style', { left: 300, top: 80, width: 90, height: 30 });
    renderLayer();
    send(event({ target: { surface: 'character', itemId: 'c1' }, anchorNames: { character: 'Mara' }, ...session('a', 1) }));
    send(event({ agent: { id: 'gemini', name: 'Gemini', color: '#4A90D9', verified: true }, target: { surface: 'style', itemId: 's1' },
      anchorNames: { style: 'Dusk grain' }, ...session('b', 1) }));
    flush();
    expect(cursors().map((el) => tipOf(el))).toEqual([{ x: 196, y: 95 }, { x: 396, y: 95 }]);
  });
});
