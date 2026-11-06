import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';

/**
 * PR #233 review 1, M5 (a cursor handed to a layer that can't resolve it
 * holds its last spot, GM - Design 6) and B2 (a leave takes a launcher dot
 * with it). The harness is tests/agentCursorHandoff.test.tsx's: both layers
 * in one jsdom tree over a mocked React Flow.
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
import { cursorHandoff } from '../src/lib/agentCursorHandoff';
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
  useAgentPresenceStore.getState().clear();
  useUIStore.setState({ viewMode: 'canvas' });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  cursorHandoff.reset();
  cursorHandoff.now = () => performance.now();
  useAgentPresenceStore.getState().clear();
});


const RAIL: Box = { left: 8, top: 300, width: 44, height: 44 };
const idle = async () => { await act(async () => { await Promise.resolve(); }); };

describe('M5: a hand-off waits for the receiving layer', () => {
  it('the canvas layer holds its spot while the screen layer can\'t resolve the item, with no fade', () => {
    renderBoth(true);
    send(event());
    flush();
    expect(tipOf(canvasCursor()!)).toEqual(N1);
    send(event(onTile())); // no tile on the page, no launcher: nothing resolves on the screen layer
    flush();
    expect(tipOf(canvasCursor()!)).toEqual(N1);
    expect(opacityOf(canvasCursor()!)).toBe(1);
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    // The screen layer draws nothing yet: no place to be.
    expect(screenCursor()?.style.transform ?? '').toBe('');
  });

  it('lets go, with no fade, once the screen layer has resolved and drawn it', async () => {
    renderBoth(true);
    send(event());
    flush();
    send(event(onTile()));
    flush();
    expect(canvasCursor()).not.toBeNull();
    putTile(TILE);
    await idle();
    flush();
    expect(canvasCursor()).toBeNull();
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    expect(allCursors()).toHaveLength(1);
  });

  it('a held cursor the store then drops fades out where it is, as any exit does', () => {
    renderBoth(true);
    send(event());
    flush();
    send(event(onTile()));
    flush();
    act(() => { useAgentPresenceStore.getState().clear(); });
    expect(canvasCursor()?.getAttribute('data-leaving')).toBe('true');
  });

  it('the other way: the screen layer holds a panel cursor the canvas can\'t resolve yet', () => {
    putTile(TILE);
    renderBoth(true);
    send(event(onTile()));
    flush();
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    lookupRef.current = new Map(); // the canvas has no n1 (not loaded yet)
    send(event());
    flush();
    expect(tipOf(screenCursor()!)).toEqual(aim(TILE));
    expect(document.querySelector('[data-leaving="true"]')).toBeNull();
    lookupRef.current = lookup;
    notifyStore();
    flush();
    expect(screenCursor()).toBeNull();
    expect(tipOf(canvasCursor()!)).toEqual(N1);
  });
});

describe('B2: a leave takes the cursor and its launcher dot', () => {
  it('a cursor parked at the rail shows a dot; the leave event removes both', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const rail = document.createElement('div');
    rail.setAttribute('data-agent-launcher', 'moodboard');
    document.body.appendChild(rail);
    boxes.set(rail, RAIL);
    render(<AgentScreenLayer canvasMounted={false} env={env} />);
    send(event({ ...onTile(), session: { key: 'aaaaaaaaaaaa', ordinal: 1 } } as Partial<AgentPresenceEvent>));
    flush();
    act(() => { vi.advanceTimersByTime(20); });
    expect(document.querySelectorAll('.agent-launcher-dot:not([data-leaving])')).toHaveLength(1);
    act(() => { useAgentPresenceStore.getState().leave([{ agentId: 'claude', key: 'aaaaaaaaaaaa' }]); });
    expect(document.querySelectorAll('.agent-launcher-dot:not([data-leaving])')).toHaveLength(0);
    expect(useAgentPresenceStore.getState().agents).toEqual({});
    vi.useRealTimers();
  });
});
