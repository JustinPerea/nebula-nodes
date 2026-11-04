import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';

// One node drawn at (400, 300), 200 × 120; the portal renders in place.
const lookup = new Map([
  ['n1', {
    id: 'n1',
    measured: { width: 200, height: 120 },
    internals: { positionAbsolute: { x: 400, y: 300 }, handleBounds: { source: [], target: [] } },
  }],
  ['n2', {
    id: 'n2',
    measured: { width: 200, height: 120 },
    internals: { positionAbsolute: { x: 900, y: 300 }, handleBounds: { source: [], target: [] } },
  }],
]);
const pane = vi.hoisted(() => {
  const state = {
    dom: null as HTMLElement | null,
    api: null as unknown,
    transform: [0, 0, 1] as [number, number, number],
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
/** React Flow's store changed (a node moved, the viewport moved). */
const notifyStore = () => act(() => {
  const state = (pane.api as { getState: () => unknown }).getState();
  for (const listener of [...pane.listeners]) listener(state);
});
const lookupRef = vi.hoisted(() => ({ current: new Map() as Map<string, unknown> }));
lookupRef.current = lookup;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) => select({ transform: pane.transform }),
  // One store, as React Flow gives: a new object per render would re-run every effect keyed on it.
  useStoreApi: () => pane.api,
}));

import { AgentCursorLayer, CARRY_PREVIEW_HOLD_MS } from '../src/components/canvas/AgentCursorLayer';
import { AGENT_CURSOR_REST_HOLD_MAX_MS } from '../src/lib/agentCursorPlanner';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { AGENT_CURSOR_HOVER_SLOP_PX, AGENT_CURSOR_PILL, cursorClearancePx, cursorShape, cursorsMeet, inkFor, labelWidths, sessionFill, stackStepPx } from '../src/lib/agentCursorLook';

/** The column step below a name, and below a name and a say (GM - Design, PR #211 r14). */
const S = stackStepPx(false);
const SS = stackStepPx(true);
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_CURSOR_IDLE_MS, AGENT_SAY_FADE_MS, AGENT_SAY_MS } from '../src/store/agentPresenceStore';
import { agentActionEntry } from '../src/store/agentLogStore';
import { forgetPersonPlaced, notePersonPlaced } from '../src/lib/personNodeMoves';

/**
 * GM - Design's agent cursor spec, phase 1 in the layer: each action draws
 * today's nearest visual until phase 2, one cursor per session with its own
 * name and fill, and the name hidden while the cursor moves.
 */

let frames: FrameRequestCallback[] = [];
// Ids of the frames still asked for, so cancelAnimationFrame cancels, as in a browser.
let frameIds: number[] = [];
let nextFrameId = 0;
let clock = 0;
/** Run each frame's callbacks last asked first: a browser's rAF order between
 *  cursors varies (review 4, drag LOW-1), so the column must not lean on it. */
let reverseFrames = false;
/** Run animation frames 1/60 s apart until none is asked for (or the cap). */
const flush = (max = 400) => act(() => {
  for (let i = 0; i < max && frames.length > 0; i += 1) {
    const run = frames;
    frames = [];
    frameIds = [];
    clock += 1000 / 60;
    for (const callback of reverseFrames ? [...run].reverse() : run) callback(clock);
  }
});
/** Run just a few frames. */
const tickFrames = (count: number) => flush(count);

const event = (overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { nodeId: 'n1' },
  action: 'move',
  say: '',
  at: 0,
  ...overrides,
});
const send = (e: AgentPresenceEvent) => act(() => { useAgentPresenceStore.getState().apply(e); });
const cursors = () => [...document.querySelectorAll<HTMLElement>('.agent-cursor')];
const ripple = () => document.querySelector('.agent-cursor__ripple');
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
  reverseFrames = false;
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
  useAgentPresenceStore.getState().clear();
  reduceMotion(false);
  pane.dom = null;
  pane.transform = [0, 0, 1];
  lookupRef.current = lookup;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
});

describe('each action draws its nearest visual until phase 2', () => {
  it.each(['click', 'type', 'run', 'propose', 'wait', 'error'])('%s ripples on arrival', (action) => {
    render(<AgentCursorLayer />);
    send(event({ action }));
    tickFrames(2);
    expect(ripple()).toBeNull();
    flush();
    expect(ripple()).not.toBeNull();
    expect(cursors()[0].dataset.action).toBe(action);
  });

  it.each(['move', 'look', 'think'])('%s draws nothing extra', (action) => {
    render(<AgentCursorLayer />);
    send(event({ action }));
    flush();
    expect(cursors()[0].dataset.placed).toBe('true');
    expect(ripple()).toBeNull();
  });

  it('an action this tab does not know draws like move', () => {
    render(<AgentCursorLayer />);
    send(event({ action: 'hover' }));
    flush();
    expect(cursors()[0].dataset.action).toBe('move');
    expect(ripple()).toBeNull();
  });

  it('drag pulls the wire on its second leg, then ripples', () => {
    render(<AgentCursorLayer />);
    send(event({ action: 'drag', from: { nodeId: 'n1' }, target: { nodeId: 'n2' } }));
    const wire = document.querySelector<SVGLineElement>('.agent-cursor__wire')!;
    let pulled = false;
    for (let i = 0; i < 200 && !ripple(); i += 1) {
      tickFrames(1);
      if (wire.style.opacity === '1') pulled = true;
    }
    expect(pulled).toBe(true);
    expect(ripple()).not.toBeNull();
    expect(wire.style.opacity).toBe('0');
  });

  it('under reduced motion it snaps, with no ripple', () => {
    reduceMotion(true);
    render(<AgentCursorLayer />);
    send(event({ action: 'click' }));
    tickFrames(1);
    // The header of n1: x + width / 2, y + min(44, height / 2).
    expect(cursors()[0].style.transform).toBe('translate(500px, 344px) scale(1)');
    expect(cursors()[0].style.opacity).toBe('1');
    flush();
    expect(ripple()).toBeNull();
  });
});

describe('one cursor per session', () => {
  it('two sessions of one runner draw two cursors, named and filled apart', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, target: { nodeId: 'n2' } }));
    flush();
    const [first, second] = cursors();
    expect(cursors()).toHaveLength(2);
    expect(first.dataset.session).toBe('aaaaaaaaaaaa');
    expect(second.dataset.session).toBe('bbbbbbbbbbbb');
    expect(first.querySelector('.agent-cursor__name')?.textContent).toBe('Claude');
    expect(second.querySelector('.agent-cursor__name')?.textContent).toBe('Claude · 2');
    expect(first.style.getPropertyValue('--agent-color')).toBe('#E8825A');
    expect(second.style.getPropertyValue('--agent-color')).not.toBe('#E8825A');
    expect(second.style.getPropertyValue('--agent-ink')).toBe('#0b0b0c');
    // Two cursors on the canvas: both names show once they stop.
    expect(first.dataset.label).toBe('name');
    expect(second.dataset.label).toBe('name');
  });

  it('paints the most recently active cursor last, and keeps tips apart on one node', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 } }));
    flush();
    expect(cursors().map((el) => el.dataset.session)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(cursors()[0].style.transform).toBe('translate(500px, 344px) scale(1)');
    expect(cursors()[1].style.transform).toBe(`translate(500px, ${344 + S}px) scale(1)`);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, say: 'Back again' }));
    flush();
    expect(cursors().map((el) => el.dataset.session)).toEqual(['bbbbbbbbbbbb', 'aaaaaaaaaaaa']);
  });
});

describe('the name and say rules', () => {
  it('hides the name while the cursor moves; the say pill takes its slot', () => {
    render(<AgentCursorLayer />);
    send(event({ say: 'Starting on the brief' }));
    tickFrames(3);
    const el = cursors()[0];
    expect(el.dataset.label).toBe('say');
    flush();
    // Stopped, on its first sighting: the name shows above the say.
    expect(el.dataset.label).toBe('name+say');
    expect(el.getAttribute('aria-label')).toBe('Claude: Starting on the brief');
  });

  it('a lone cursor hides its name once the first sighting is over', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      render(<AgentCursorLayer />);
      send(event());
      flush();
      expect(cursors()[0].dataset.label).toBe('name');
      act(() => { vi.advanceTimersByTime(1600); });
      expect(cursors()[0].dataset.label).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });
});

const at = (el: HTMLElement) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
  return m ? { x: +m[1], y: +m[2] } : { x: NaN, y: NaN };
};

describe('arrival is the tip at the target (GM - Design, PR #211 r2)', () => {
  it.each(['click', 'run', 'error'])('%s ripples only once the tip is within 2 px, never in mid-air', (action) => {
    render(<AgentCursorLayer />);
    // From a resting cursor on n1 to n2, 500 px away.
    send(event());
    flush();
    send(event({ action, target: { nodeId: 'n2' } }));
    let rippledAt: { x: number; y: number } | null = null;
    for (let i = 0; i < 200 && !rippledAt; i += 1) {
      tickFrames(1);
      const p = at(cursors()[0]);
      if (ripple()) rippledAt = p;
      else if (i > 2) expect(ripple()).toBeNull();
    }
    expect(rippledAt).not.toBeNull();
    expect(Math.hypot(rippledAt!.x - 1000, rippledAt!.y - 344)).toBeLessThanOrEqual(2);
  });

  it('the drag wire stays on until the tip is at the port, and its end is there', () => {
    render(<AgentCursorLayer />);
    send(event({ action: 'drag', from: { nodeId: 'n1' }, target: { nodeId: 'n2' } }));
    const wire = document.querySelector<SVGLineElement>('.agent-cursor__wire')!;
    let lastOn: { x: number; y: number } | null = null;
    for (let i = 0; i < 300 && !ripple(); i += 1) {
      tickFrames(1);
      if (wire.style.opacity === '1') lastOn = { x: +wire.getAttribute('x2')!, y: +wire.getAttribute('y2')! };
    }
    expect(ripple()).not.toBeNull();
    // The wire stays on until the frame before the tip arrives (one frame's
    // travel short at most: round 1 let go 130-170 px short), and lets go
    // with its end at the port (n2's header), within 2 px.
    expect(lastOn).not.toBeNull();
    expect(Math.hypot(lastOn!.x - 1000, lastOn!.y - 344)).toBeLessThan(6);
    expect(wire.style.opacity).toBe('0');
    expect(Math.hypot(+wire.getAttribute('x2')! - 1000, +wire.getAttribute('y2')! - 344)).toBeLessThanOrEqual(2);
  });
});

describe('two cursors on one spot keep their places (review 1, F2)', () => {
  it('the first to arrive keeps the spot when the other acts again', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 } }));
    flush();
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, el.style.transform]));
    const before = where();
    expect(before.aaaaaaaaaaaa).toBe('translate(500px, 344px) scale(1)');
    expect(before.bbbbbbbbbbbb).toBe(`translate(500px, ${344 + S}px) scale(1)`);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, action: 'look' }));
    flush();
    expect(where()).toEqual(before);
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, action: 'look' }));
    flush();
    expect(where()).toEqual(before);
    // Recency still sets paint order: b last.
    expect(cursors().map((el) => el.dataset.session)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });
});

describe('a cursor that shifts a little on its spot keeps its place in the stack (review 1, F2)', () => {
  it('stays first: it lands where it aimed, and the later cursor steps aside', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, target: { x: 300, y: 300 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, target: { x: 300, y: 300 } }));
    flush();
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, el.style.transform]));
    expect(where().bbbbbbbbbbbb).toBe(`translate(300px, ${300 + S}px) scale(1)`);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, target: { x: 304, y: 300 } }));
    flush();
    // a came first: it is never pushed off its own target. b's target is
    // still within 16 px of a's target, so b stays in a's column, straight
    // below it (GM - Design, PR #211 r13 item 3).
    expect(where().aaaaaaaaaaaa).toBe('translate(304px, 300px) scale(1)');
    expect(where().bbbbbbbbbbbb).toBe(`translate(304px, ${300 + S}px) scale(1)`);
  });
});

describe('with two or more cursors the name holds its slot (GM - Design, PR #211 r2)', () => {
  it('shows the name in flight, so the say pill never jumps', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, target: { nodeId: 'n2' } }));
    flush();
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, target: { x: 100, y: 600 }, say: 'Over here' }));
    const layouts = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      tickFrames(1);
      const el = cursors().find((c) => c.dataset.session === 'aaaaaaaaaaaa')!;
      layouts.add(el.dataset.label!);
    }
    expect([...layouts]).toEqual(['name+say']);
  });
});

describe('a tab that hears an event while hidden snaps (GM - Design, PR #211 r2)', () => {
  it('lands on the latest target with no flight and no ripple; an old say line is not shown', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    act(() => { useAgentPresenceStore.getState().apply(event({ action: 'click', target: { nodeId: 'n2' }, say: 'Clicked' }), Date.now() - 5_000); });
    tickFrames(1);
    const el = cursors()[0];
    expect(el.style.transform).toBe('translate(1000px, 344px) scale(1)');
    flush();
    expect(ripple()).toBeNull();
    expect(el.querySelector('.agent-cursor__say')).toBeNull();
    // The name only, for a moment.
    expect(el.dataset.label).toBe('name');
  });

  it('keeps a say line that is still current', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    act(() => { useAgentPresenceStore.getState().apply(event({ target: { nodeId: 'n2' }, say: 'Still here' }), Date.now() - 1_500); });
    tickFrames(1);
    expect(cursors()[0].style.transform).toBe('translate(1000px, 344px) scale(1)');
    flush();
    expect(cursors()[0].querySelector('.agent-cursor__say')?.textContent).toBe('Still here');
    // Its say doesn't wait on a snap: nothing below it is moving (review 6, item 3).
    expect(cursors()[0].dataset.sayWait).toBeUndefined();
  });
});

describe('the replay a person tab gets on connect (GM - Design, PR #211 r3)', () => {
  const replay = (cursors: unknown[]) => act(() => { useAgentPresenceStore.getState().replay(cursors as never); });
  const live = (ordinal: number, extra: Partial<AgentPresenceEvent> = {}) => ({
    ...event({ session: { key: String(ordinal).repeat(12), ordinal }, ...extra }), replay: true, secondsAgo: 0,
  });

  it('a fresh tab with sessions 1 and 3 live shows "Claude" and "Claude · 3" where they are, with no flight', () => {
    render(<AgentCursorLayer />);
    replay([live(1, { target: { nodeId: 'n1' }, action: 'click' }), live(3, { target: { nodeId: 'n2' }, action: 'click' })]);
    tickFrames(1);
    const els = cursors();
    expect(els.map((el) => el.getAttribute('aria-label')?.split(':')[0]).sort()).toEqual(['Claude', 'Claude · 3']);
    const byName = Object.fromEntries(els.map((el) => [el.querySelector('.agent-cursor__name')!.textContent, el]));
    expect(byName.Claude.style.transform).toBe('translate(500px, 344px) scale(1)');
    expect(byName['Claude · 3'].style.transform).toBe('translate(1000px, 344px) scale(1)');
    flush();
    // Nothing is shown as if it happened now.
    expect(ripple()).toBeNull();
  });

  it('a tab that connects during a flight lands the cursor on its target at once', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: '111111111111', ordinal: 1 }, target: { nodeId: 'n1' } }));
    flush();
    send(event({ session: { key: '111111111111', ordinal: 1 }, target: { nodeId: 'n2' } }));
    tickFrames(3);
    expect(cursors()[0].style.transform).not.toBe('translate(1000px, 344px) scale(1)');
    // The reconnect's replay: the same cursor, mid-flight on the backend's clock.
    replay([live(1, { target: { nodeId: 'n2' } })]);
    tickFrames(1);
    expect(cursors()).toHaveLength(1);
    expect(cursors()[0].style.transform).toBe('translate(1000px, 344px) scale(1)');
  });

  it('a replayed cursor moves normally on its next event', () => {
    render(<AgentCursorLayer />);
    replay([live(1, { target: { nodeId: 'n1' } })]);
    flush();
    send(event({ session: { key: '111111111111', ordinal: 1 }, target: { nodeId: 'n2' } }));
    tickFrames(3);
    const mid = cursors()[0].style.transform;
    expect(mid).not.toBe('translate(500px, 344px) scale(1)');
    expect(mid).not.toBe('translate(1000px, 344px) scale(1)');
    flush();
    expect(cursors()[0].style.transform).toBe('translate(1000px, 344px) scale(1)');
  });
});

describe('no layout read per frame or per pointermove (review 1, L1 and F7)', () => {
  const rectFor = (el: Element): DOMRect => {
    if (el === pane.dom) return new DOMRect(0, 0, 1440, 900);
    const cursor = el.closest<HTMLElement>('.agent-cursor');
    const p = cursor ? at(cursor) : { x: -999, y: -999 };
    if (el.classList.contains('agent-cursor__pointer')) return new DOMRect(p.x, p.y, 20, 22);
    if (el.classList.contains('agent-cursor__name')) return new DOMRect(p.x + 15, p.y + 17, 60, 20);
    if (el.classList.contains('agent-cursor__say')) return new DOMRect(p.x + 15, p.y + 41, 120, 20);
    return new DOMRect(0, 0, 0, 0);
  };
  const reads = { count: 0 };
  beforeEach(() => {
    pane.dom = document.createElement('div');
    document.body.appendChild(pane.dom);
    reads.count = 0;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      reads.count += 1;
      return rectFor(this);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    pane.dom?.remove();
  });
  const pointer = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })); });

  it('reads the pane once for a whole flight of three cursors, however many frames', () => {
    render(<AgentCursorLayer />);
    pointer(1400, 880);
    for (const [k, n] of [['aaaaaaaaaaaa', 'n1'], ['bbbbbbbbbbbb', 'n2'], ['cccccccccccc', 'n2']] as const) {
      send(event({ session: { key: k, ordinal: k === 'aaaaaaaaaaaa' ? 1 : k === 'bbbbbbbbbbbb' ? 2 : 3 }, target: { nodeId: n } }));
    }
    flush();
    const afterLanding = reads.count;
    // At most the pane plus each cursor's boxes once per landing, not one per frame.
    expect(afterLanding).toBeLessThanOrEqual(1 + 3 * 3 * 2);
    for (let i = 0; i < 60; i += 1) pointer(1400 - i, 880);
    expect(reads.count).toBe(afterLanding);
  });

  it('a leaving cursor takes no hover: a pointer over it reads nothing and changes nothing (review 5, F12)', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 2 } }));
    flush();
    const el = cursors()[0];
    act(() => { useAgentPresenceStore.getState().demote(); });
    tickFrames(2);
    const label = el.dataset.label;
    const before = reads.count;
    for (let i = 0; i < 10; i += 1) pointer(505 + i, 350);
    expect(reads.count).toBe(before);
    expect(el.dataset.label).toBe(label);
  });

  it('re-tests hover when the cursor lands: a cursor that flies out from under a still pointer drops its name', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      render(<AgentCursorLayer />);
      send(event());
      flush();
      act(() => { vi.advanceTimersByTime(1600); });
      const el = cursors()[0];
      expect(el.dataset.label).toBe('none');
      pointer(505, 350); // over the arrow at (500, 344)
      expect(el.dataset.label).toBe('name');
      send(event({ target: { nodeId: 'n2' } }));
      flush();
      expect(at(el)).toEqual({ x: 1000, y: 344 });
      expect(el.dataset.label).toBe('none');
      // And back under the still pointer: the name shows again on landing.
      send(event({ target: { nodeId: 'n1' } }));
      flush();
      expect(el.dataset.label).toBe('name');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hover slop is 4 px', () => {
    expect(AGENT_CURSOR_HOVER_SLOP_PX).toBe(4);
  });

  const moveNode = (id: string, dx: number) => {
    const next = new Map(lookupRef.current) as Map<string, { internals: { positionAbsolute: { x: number; y: number } } }>;
    const node = next.get(id)!;
    next.set(id, { ...node, internals: { ...node.internals, positionAbsolute: {
      x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y } } });
    lookupRef.current = next as never;
    notifyStore();
  };

  it('re-tests hover after following its node under a still pointer (review 2, L1)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      render(<AgentCursorLayer />);
      send(event());
      flush();
      act(() => { vi.advanceTimersByTime(1600); });
      const el = cursors()[0];
      pointer(505, 350); // over the arrow at (500, 344)
      expect(el.dataset.label).toBe('name');
      // The person moves the node a little (a drag, under the stack radius per frame) away and back.
      for (let i = 0; i < 20; i += 1) { moveNode('n1', 10); tickFrames(1); }
      flush();
      expect(el.dataset.label).toBe('none');
      for (let i = 0; i < 20; i += 1) { moveNode('n1', -10); tickFrames(1); }
      flush();
      expect(at(el)).toEqual({ x: 500, y: 344 });
      // Back under the still pointer: the name shows, with no pointer move.
      expect(el.dataset.label).toBe('name');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hit-tests a resting cursor where it followed its node to, not where its boxes were read (review 2, L1)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      render(<AgentCursorLayer />);
      send(event());
      flush();
      act(() => { vi.advanceTimersByTime(1600); });
      const el = cursors()[0];
      pointer(1400, 880); // far off: the boxes are read at (500, 344)
      expect(el.dataset.label).toBe('none');
      // The person drags n1 200 px right, 10 px a frame: the cursor follows.
      for (let i = 0; i < 20; i += 1) { moveNode('n1', 10); tickFrames(1); }
      flush();
      expect(at(el)).toEqual({ x: 700, y: 344 });
      // The pointer goes to where the cursor is now: its name shows.
      pointer(705, 350);
      expect(el.dataset.label).toBe('name');
      // And where it was is no longer it.
      pointer(505, 350);
      expect(el.dataset.label).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the cached pane and boxes on a viewport change, a pane resize and a window resize, and only then (review 2, L4)', () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    render(<AgentCursorLayer />);
    send(event());
    flush();
    pointer(1400, 880);
    const settled = reads.count;
    pointer(1390, 880);
    expect(reads.count).toBe(settled); // cached
    const rereads = (change: () => void) => {
      const before = reads.count;
      change();
      pointer(1380, 880);
      return reads.count > before;
    };
    expect(rereads(() => { pane.transform = [5, 0, 1]; notifyStore(); })).toBe(true);
    expect(rereads(() => {})).toBe(false);
    expect(rereads(() => act(() => { observers.forEach((callback) => callback()); }))).toBe(true);
    expect(rereads(() => act(() => { window.dispatchEvent(new Event('resize')); }))).toBe(true);
    expect(rereads(() => {})).toBe(false);
  });

  // Review 5, NIT-1 (M13): a cursor's boxes go stale by how far its tip
  // moved on screen, not in canvas units. Zoomed in to 2, its node moved 0.8
  // canvas units (1.6 px on screen, past HOVER_STALE_PX): it reads its boxes
  // again on coming to rest. Zoomed out to 0.25, 3 canvas units (0.75 px):
  // it doesn't.
  it.each([[2, 0.8, true], [0.25, 3, false]] as const)('at zoom %s a rest %s canvas units on re-reads its boxes: %s (review 5, NIT-1, M13)', (zoom, dx, again) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      pane.transform = [0, 0, zoom];
      render(<AgentCursorLayer />);
      send(event());
      flush();
      act(() => { vi.advanceTimersByTime(1600); });
      pointer(1400, 880);
      const before = reads.count;
      pointer(1390, 880);
      expect(reads.count).toBe(before); // cached
      moveNode('n1', dx);
      flush();
      // Followed its node (drawn on whole device pixels).
      expect(Math.abs(at(cursors()[0]).x - (500 + dx))).toBeLessThanOrEqual(1 / zoom);
      expect(reads.count > before).toBe(again);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads its boxes when its label changes (a pill appears or goes)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    try {
      render(<AgentCursorLayer />);
      send(event({ say: 'Reading' }));
      flush();
      // The say pill sits under the arrow until it fades (3 s): hovering it shows the name.
      pointer(530, 392);
      expect(cursors()[0].dataset.label).toBe('name+say');
      act(() => { vi.advanceTimersByTime(4000); });
      // The pill is gone; the same spot is no longer over the cursor.
      pointer(531, 392);
      expect(cursors()[0].dataset.label).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ratchets (review 1, L2 and F5)', () => {
  it('the lean turns the arrow only, never the pills', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ target: { nodeId: 'n2' } }));
    let leaned = false;
    for (let i = 0; i < 30; i += 1) {
      tickFrames(1);
      const el = cursors()[0];
      expect(el.style.transform).not.toMatch(/rotate/);
      if (/rotate\(/.test(el.querySelector<SVGElement>('.agent-cursor__pointer')!.style.transform)) leaned = true;
    }
    expect(leaned).toBe(true);
  });

  it('the idle dim wakes a sleeping cursor and plays on the spring', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      render(<AgentCursorLayer />);
      send(event());
      flush();
      expect(frames).toHaveLength(0); // asleep
      act(() => { vi.advanceTimersByTime(20_001); });
      expect(frames.length).toBeGreaterThan(0);
      tickFrames(3);
      const mid = +cursors()[0].style.opacity;
      expect(mid).toBeLessThan(1);
      expect(mid).toBeGreaterThan(0.45);
      flush();
      expect(cursors()[0].style.opacity).toBe('0.45');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inks the name on the session fill, not the agent colour', () => {
    render(<AgentCursorLayer />);
    const blue = { id: 'p1', name: 'Blue', color: '#0000ff', verified: false };
    send(event({ agent: blue, session: { key: 'dddddddddddd', ordinal: 5 } }));
    flush();
    const fill = sessionFill('#0000ff', { ordinal: 5 });
    expect(inkFor(fill)).not.toBe(inkFor('#0000ff'));
    expect(cursors()[0].style.getPropertyValue('--agent-ink')).toBe(inkFor(fill));
  });

  it('names each session for screen readers, and isolates the agent name', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 } }));
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, target: { nodeId: 'n2' }, say: 'Hi' }));
    flush();
    expect(cursors()[1].getAttribute('aria-label')).toBe('Claude · 2: Hi');
    const name = cursors()[1].querySelector('.agent-cursor__name')!;
    expect(name.querySelector('bdi')?.textContent).toBe('Claude');
    expect(name.textContent).toBe('Claude · 2');
  });

  it('listens to the pointer passively and stops on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<AgentCursorLayer />);
    const added = add.mock.calls.find(([type]) => type === 'pointermove');
    expect(added?.[2]).toEqual({ passive: true });
    unmount();
    expect(remove.mock.calls.some(([type, fn]) => type === 'pointermove' && fn === added?.[1])).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });
});


describe('a tab hidden mid-flight lands with no ring and no wire (GM - Design, PR #211 r5; review 2, M1)', () => {
  const setVisibility = (state: 'hidden' | 'visible') => act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  it.each([1500, 5000])('hidden %s ms after a click took off: the tip lands, and that is all', (hiddenMs) => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' }, say: 'Clicking Run' }));
    tickFrames(12); // 200 ms in, mid-flight
    expect(at(cursors()[0]).x).toBeLessThan(1000);
    setVisibility('hidden');
    clock += hiddenMs; // no frames while hidden
    setVisibility('visible');
    flush();
    expect(at(cursors()[0])).toEqual({ x: 1000, y: 344 });
    expect(ripple()).toBeNull();
  });

  it.each([1500, 5000])('a drag hidden %s ms mid-flight lands with its wire gone and no ripple', (hiddenMs) => {
    render(<AgentCursorLayer />);
    send(event({ action: 'drag', from: { nodeId: 'n1' }, target: { nodeId: 'n2' } }));
    const wire = document.querySelector<SVGLineElement>('.agent-cursor__wire')!;
    for (let i = 0; i < 200 && wire.style.opacity !== '1'; i += 1) tickFrames(1);
    expect(wire.style.opacity).toBe('1');
    setVisibility('hidden');
    clock += hiddenMs;
    setVisibility('visible');
    flush();
    expect(wire.style.opacity).toBe('0');
    expect(ripple()).toBeNull();
  });

  it('a hide shorter than 0.25 s mid-flight still lands with no ring: the return is not now', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' } }));
    tickFrames(15); // 250 ms in, mid-flight
    expect(ripple()).toBeNull();
    setVisibility('hidden');
    clock += 150;
    setVisibility('visible');
    flush();
    expect(at(cursors()[0])).toEqual({ x: 1000, y: 344 });
    expect(ripple()).toBeNull();
  });

  it('a stall past 0.25 s with no visibility change does the same; a slow frame under it does not', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' } }));
    tickFrames(6);
    clock += 300; // one 300 ms frame
    tickFrames(1);
    expect(at(cursors()[0])).toEqual({ x: 1000, y: 344 });
    flush();
    expect(ripple()).toBeNull();
    // 200 ms is a slow frame: the move carries on and the ring shows on arrival.
    send(event({ action: 'click', target: { nodeId: 'n1' } }));
    tickFrames(6);
    clock += 200;
    tickFrames(1);
    expect(at(cursors()[0]).x).toBeGreaterThan(500);
    flush();
    expect(ripple()).not.toBeNull();
  });
});

describe('the stale-event threshold is the move\'s own duration (review 2, L4)', () => {
  it('an event just older than its flight snaps; one just younger flies', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    // n1 to n2 is 500 screen px: 593 ms.
    act(() => { useAgentPresenceStore.getState().apply(event({ target: { nodeId: 'n2' } }), Date.now() - 640); });
    tickFrames(1);
    expect(at(cursors()[0])).toEqual({ x: 1000, y: 344 });
    act(() => { useAgentPresenceStore.getState().apply(event({ target: { nodeId: 'n1' } }), Date.now() - 540); });
    tickFrames(1);
    expect(at(cursors()[0]).x).toBeGreaterThan(500);
  });
});

describe('a target that keeps moving (GM - Design, PR #211 r5)', () => {
  const moveNode = (id: string, dx: number, dy: number) => {
    const next = new Map(lookupRef.current) as Map<string, { internals: { positionAbsolute: { x: number; y: number } } }>;
    const node = next.get(id)!;
    next.set(id, { ...node, internals: { ...node.internals, positionAbsolute: {
      x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y + dy } } });
    lookupRef.current = next as never;
    notifyStore();
  };

  it('a click on a node being dragged fires at first arrival and the cursor rides along', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' } }));
    let firedWhileMoving = false;
    for (let i = 0; i < 150; i += 1) {
      moveNode('n2', 0, 2.5); // 150 px/s down, never stopping in this test
      tickFrames(1);
      if (ripple()) firedWhileMoving = true;
    }
    expect(firedWhileMoving).toBe(true);
    // Riding along: the tip is on the moving node's spot within 2 px.
    const node = (lookupRef.current as Map<string, { internals: { positionAbsolute: { x: number; y: number } } }>).get('n2')!;
    const spot = { x: node.internals.positionAbsolute.x + 100, y: node.internals.positionAbsolute.y + 44 };
    const tip = at(cursors()[0]);
    expect(Math.hypot(tip.x - spot.x, tip.y - spot.y)).toBeLessThanOrEqual(2.5);
  });

  it('a newer event before arrival drops the old action\'s look', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' } }));
    tickFrames(10);
    send(event({ action: 'move', target: { nodeId: 'n1' } }));
    let rippled = false;
    for (let i = 0; i < 200; i += 1) {
      tickFrames(1);
      if (ripple()) rippled = true;
    }
    expect(rippled).toBe(false);
    expect(at(cursors()[0])).toEqual({ x: 500, y: 344 });
  });

  it('a click on the spot it already rests on ripples on the next frame (review 2, N3)', () => {
    render(<AgentCursorLayer />);
    send(event());
    flush();
    send(event({ action: 'click' }));
    tickFrames(1);
    expect(ripple()).not.toBeNull();
  });
});

describe('de-stacking goes by physical arrival (GM - Design, PR #211 r5)', () => {
  it('cursors that leave take their places with them: a cursor alone on a spot is never pushed aside (live, after a restart\'s empty replay)', () => {
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 } };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 } };
    send(event({ ...A, target: { x: 360, y: 640 } }));
    send(event({ ...B, target: { x: 760, y: 640 } }));
    flush();
    // A restarted backend replays nothing: every cursor leaves at once. A
    // leaving cursor wakes the others; one already gone must not run again.
    act(() => { useAgentPresenceStore.getState().replay([]); });
    flush();
    expect(cursors()).toHaveLength(0);
    // New keys on the old spots, each alone there.
    const C = { session: { key: 'cccccccccccc', ordinal: 1 } };
    const D = { session: { key: 'dddddddddddd', ordinal: 2 } };
    send(event({ ...C, target: { x: 760, y: 640 } }));
    flush();
    expect(at(cursors()[0])).toEqual({ x: 760, y: 640 });
    send(event({ ...D, target: { x: 360, y: 640 } }));
    flush();
    const byKey = Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    expect(byKey).toEqual({ cccccccccccc: { x: 760, y: 640 }, dddddddddddd: { x: 360, y: 640 } });
  });

  it('two cursors sent 100 ms apart from different distances: the one that lands second moves aside', () => {
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 } };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 } };
    // A rests far off; B rests near n2.
    send(event({ ...A, target: { x: -1400, y: 344 } }));
    send(event({ ...B, target: { x: 960, y: 344 } }));
    flush();
    // A is sent first, from 2,400 px; B 100 ms later, from 40 px. B lands first.
    send(event({ ...A, target: { nodeId: 'n2' } }));
    tickFrames(6);
    send(event({ ...B, target: { nodeId: 'n2' } }));
    flush();
    const byKey = Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    expect(byKey.bbbbbbbbbbbb).toEqual({ x: 1000, y: 344 });
    expect(byKey.aaaaaaaaaaaa).toEqual({ x: 1000, y: 344 + S });
  });

  it('while both are on their way, the one due to land first aims at the spot: it never lands aside and hops back', () => {
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 } };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 } };
    send(event({ ...A, target: { x: -1400, y: 344 } }));
    send(event({ ...B, target: { x: 960, y: 344 } }));
    flush();
    send(event({ ...A, target: { nodeId: 'n2' } }));
    tickFrames(6);
    send(event({ ...B, target: { nodeId: 'n2' } }));
    const b = () => at(cursors().find((el) => el.dataset.session === 'bbbbbbbbbbbb')!);
    let aside = false;
    for (let i = 0; i < 400 && frames.length > 0; i += 1) {
      tickFrames(1);
      const p = b();
      if (Math.hypot(p.x - 1010, p.y - 354) < 3) aside = true;
    }
    expect(b()).toEqual({ x: 1000, y: 344 });
    expect(aside).toBe(false);
  });

  it('the stamp radius is 16 screen px at any zoom', () => {
    pane.transform = [0, 0, 0.5];
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 } };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 } };
    send(event({ ...A, target: { x: 300, y: 300 } }));
    flush();
    send(event({ ...B, target: { x: 300, y: 300 } }));
    flush();
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    expect(where().bbbbbbbbbbbb).toEqual({ x: 300, y: 300 + S / 0.5 }); // straight down S screen px at zoom 0.5
    // A shifts 20 flow px: 10 screen px, inside the radius. It keeps its
    // stamp, so it is never pushed off its own target.
    send(event({ ...A, target: { x: 320, y: 300 } }));
    flush();
    expect(where().aaaaaaaaaaaa).toEqual({ x: 320, y: 300 });
  });

  it('a node dragged slowly under a landed cursor: the carried one is drawn after it at once, and the backend\'s arrival moves nothing (review 2, L2; r47 Q1)', () => {
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, since: 1000 };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, since: 2000 };
    send(event({ ...A, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...B, target: { x: 800, y: 344 } }));
    flush();
    // The person drags n1 (A's node) onto B's spot, 5 px per frame.
    for (let i = 0; i < 60; i += 1) {
      const next = new Map(lookupRef.current) as Map<string, { internals: { positionAbsolute: { x: number; y: number } } }>;
      const node = next.get('n1')!;
      next.set('n1', { ...node, internals: { ...node.internals, positionAbsolute: {
        x: node.internals.positionAbsolute.x + 5, y: node.internals.positionAbsolute.y } } });
      lookupRef.current = next as never;
      notifyStore();
      tickFrames(1);
    }
    flush();
    const spots = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    // A's target chain changed: the tab previews the arrival the backend
    // will count, so B keeps the spot and A is drawn under it (r47 Q1).
    // (On the way, while A's arrow meets B's label but their targets are
    // still over 16 apart, the column joins in this tab only, A first: an
    // overlap join is no arrival, r24 Q2.)
    expect(spots().bbbbbbbbbbbb).toEqual({ x: 800, y: 344 });
    expect(spots().aaaaaaaaaaaa).toEqual({ x: 800, y: 344 + S });
    // The backend's arrival agrees: nothing moves.
    act(() => { useAgentPresenceStore.getState().arrive([{ agentId: 'claude', key: 'aaaaaaaaaaaa', ordinal: 1, since: 3000 }]); });
    flush();
    expect(spots().bbbbbbbbbbbb).toEqual({ x: 800, y: 344 });
    expect(spots().aaaaaaaaaaaa).toEqual({ x: 800, y: 344 + S });
  });
});

describe('a dragged node carries its cursors (GM - Design, PR #211 r9 items 2, 3 and 5)', () => {
  type Entry = { internals: { positionAbsolute: { x: number; y: number } } };
  /** The node moves; `dragging` is React Flow's flag for the person's own drag. */
  const moveNode = (id: string, dx: number, dy: number, dragging = false) => {
    const next = new Map(lookupRef.current) as Map<string, Entry>;
    const node = next.get(id)!;
    next.set(id, { ...node, dragging, internals: { ...node.internals, positionAbsolute: {
      x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y + dy } } } as Entry);
    lookupRef.current = next as never;
    notifyStore();
  };
  const spotOf = (id: string) => {
    const node = (lookupRef.current as Map<string, Entry>).get(id)!;
    return { x: node.internals.positionAbsolute.x + 100, y: node.internals.positionAbsolute.y + 44 };
  };
  const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));

  it.each([5, 20, 30])('two cursors on one node dragged %s px a frame keep their order: the first on the spot, the second aside all the way', (perFrame) => {
    render(<AgentCursorLayer />);
    // The first to arrive has the later key, so a tie broken by key would swap them.
    const first = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const second = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...first, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...second, target: { nodeId: 'n1' } }));
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: spotOf('n1'), aaaaaaaaaaaa: { x: 500, y: 344 + S } });
    const frames300 = Math.round(300 / perFrame);
    for (let i = 0; i < frames300; i += 1) {
      // The person's drag (React Flow's dragging flag): carried at any speed.
      moveNode('n1', perFrame, 0, true);
      tickFrames(1);
      const spot = spotOf('n1');
      // Carried: on their spots every frame, the second never on the first's.
      expect(where().bbbbbbbbbbbb).toEqual(spot);
      expect(where().aaaaaaaaaaaa).toEqual({ x: spot.x, y: spot.y + S });
    }
    moveNode('n1', 0, 0, false);
    flush();
    const spot = spotOf('n1');
    expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x, y: spot.y + S } });
    // And again, back the other way.
    for (let i = 0; i < frames300; i += 1) {
      moveNode('n1', -perFrame, 0);
      tickFrames(1);
    }
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 500, y: 344 }, aaaaaaaaaaaa: { x: 500, y: 344 + S } });
  });

  it.each([5, 20])('keeps their order when the second one\'s frame runs first, dragged %s px a frame', (perFrame) => {
    render(<AgentCursorLayer />);
    const first = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const second = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...first, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...second, target: { nodeId: 'n1' } }));
    flush();
    // The first speaks again where it is: it now paints, and runs its frame,
    // last. Its say pill shows, so the second steps past it (r13 item 2).
    send(event({ ...first, target: { nodeId: 'n1' }, action: 'look', say: 'Still here' }));
    flush();
    expect(cursors().map((el) => el.dataset.session)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    const step = stackStepPx(true);
    for (let i = 0; i < 300 / perFrame; i += 1) {
      moveNode('n1', perFrame, 0);
      tickFrames(1);
      const spot = spotOf('n1');
      expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x, y: spot.y + step } });
    }
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 800, y: 344 }, aaaaaaaaaaaa: { x: 800, y: 344 + step } });
  });

  it('a cursor that flies onto a dragged node lands aside: the one the node carries keeps the spot', () => {
    render(<AgentCursorLayer />);
    const carried = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const flier = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...carried, target: { nodeId: 'n1' } }));
    send(event({ ...flier, target: { x: 0, y: 0 } }));
    flush();
    send(event({ ...flier, action: 'click', target: { nodeId: 'n1' } }));
    for (let i = 0; i < 90; i += 1) {
      moveNode('n1', 4, 0);
      tickFrames(1);
      expect(where().bbbbbbbbbbbb).toEqual(spotOf('n1'));
    }
    flush();
    const spot = spotOf('n1');
    expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x, y: spot.y + S } });
  });

  it('a cursor set aside goes back onto its spot on the land spring when the other leaves, not in one jump', () => {
    render(<AgentCursorLayer />);
    const first = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const second = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...first, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...second, target: { nodeId: 'n1' } }));
    flush();
    expect(where().aaaaaaaaaaaa).toEqual({ x: 500, y: 344 + S });
    // The first moves off to n2: the second's spot is the node's own again.
    send(event({ ...first, target: { nodeId: 'n2' } }));
    let last = where().aaaaaaaaaaaa;
    let biggestStep = 0;
    for (let i = 0; i < 60; i += 1) {
      tickFrames(1);
      const now = where().aaaaaaaaaaaa;
      biggestStep = Math.max(biggestStep, Math.hypot(now.x - last.x, now.y - last.y));
      last = now;
    }
    // 14 px on the land spring: a few px a frame at most, never all at once.
    expect(biggestStep).toBeLessThan(5);
    flush();
    expect(where().aaaaaaaaaaaa).toEqual({ x: 500, y: 344 });
  });

  it.each([[4, false], [12, false], [20, false], [40, true], [80, true]])('a resting cursor on a node moved %s px a frame (the person dragging: %s) is on its spot every frame and stops dead with it', (perFrame, dragging) => {
    render(<AgentCursorLayer />);
    send(event({ target: { nodeId: 'n2' } }));
    flush();
    for (let i = 0; i < 40; i += 1) {
      moveNode('n2', perFrame, 0, dragging);
      tickFrames(1);
      expect(at(cursors()[0])).toEqual(spotOf('n2'));
    }
    moveNode('n2', 0, 0, false);
    const stop = spotOf('n2');
    for (let i = 0; i < 60; i += 1) {
      tickFrames(1);
      expect(at(cursors()[0])).toEqual(stop);
    }
  });

  it('a click on a node flung faster than 24 px a frame fires no later than the drag\'s end, at the tip', () => {
    render(<AgentCursorLayer />);
    send(event({ target: { x: 0, y: 344 } }));
    flush();
    send(event({ action: 'click', target: { nodeId: 'n2' } }));
    let rippledDuring = false;
    for (let i = 0; i < 40; i += 1) {
      moveNode('n2', 30, 0);
      tickFrames(1);
      if (ripple()) rippledDuring = true;
    }
    expect(rippledDuring).toBe(false);
    tickFrames(1);
    expect(ripple()).toBeNull();
    tickFrames(1);
    expect(ripple()).not.toBeNull();
    // It still lands on the node, and the ripple came once.
    flush();
    expect(at(cursors()[0])).toEqual(spotOf('n2'));
    expect(document.querySelectorAll('.agent-cursor__ripple')).toHaveLength(1);
  });
});

describe('the name pill edge on the cursor (GM - Design, PR #211 r9 item 4)', () => {
  it('marks a black agent\'s pill for the edge, and Claude\'s not', () => {
    render(<AgentCursorLayer />);
    send(event({ agent: { id: 'ink', name: 'Ink', color: '#000000', verified: false } }));
    send(event());
    flush();
    const byAgent = Object.fromEntries(cursors().map((el) => [el.dataset.agent, el.dataset.edge]));
    expect(byAgent).toEqual({ ink: 'both', claude: undefined });
  });
});

describe('a view whose effects reconnect keeps its place (round 4: StrictMode in dev, live)', () => {
  it('under StrictMode, a cursor that speaks again (and so paints last) keeps its stamp: no swap', async () => {
    const { StrictMode } = await import('react');
    render(<StrictMode><AgentCursorLayer /></StrictMode>);
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session ?? el.dataset.agent, at(el)]));
    const pair = (key: string, ordinal: number, action = 'click') => event({
      agent: { id: 'pair', name: 'Pair', color: '#3FC1A5', verified: false }, session: { key, ordinal }, action, target: { nodeId: 'n1' } });
    send(event({ target: { nodeId: 'n1' } }));
    flush();
    send(pair('aaaaaaaaaaaa', 1));
    flush();
    send(pair('bbbbbbbbbbbb', 2));
    flush();
    const before = where();
    expect(before).toEqual({ claude: { x: 500, y: 344 }, aaaaaaaaaaaa: { x: 500, y: 344 + S }, bbbbbbbbbbbb: { x: 500, y: 344 + 2 * S } });
    send(pair('aaaaaaaaaaaa', 1, 'look'));
    flush();
    expect(where()).toEqual(before);
  });
});

describe('the presence exit, for every removal (GM - Design, PR #211 review 4)', () => {
  const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12), ordinal } });
  const opacity = (el: HTMLElement) => Number(el.style.opacity);
  const demote = () => act(() => { useAgentPresenceStore.getState().demote(); });

  it('5 -> 0 on a demoted tab: every cursor fades over more than one frame, then goes', () => {
    render(<AgentCursorLayer />);
    for (const [i, key] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      send(event({ ...session(key, i + 1), target: { x: 100 + 60 * i, y: 100 } }));
    }
    flush();
    expect(cursors()).toHaveLength(5);
    expect(cursors().every((el) => opacity(el) === 1)).toBe(true);
    demote();
    let partial = 0;
    for (let i = 0; i < 400 && cursors().length > 0; i += 1) {
      tickFrames(1);
      if (cursors().length === 5 && cursors().every((el) => opacity(el) > 0 && opacity(el) < 1)) partial += 1;
    }
    expect(partial).toBeGreaterThan(1);
    expect(cursors()).toHaveLength(0);
  });

  it('fades on the opacity spring, tip, pill and say pill together (one element), and never moves', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), say: 'On it' }));
    flush();
    const el = cursors()[0];
    const start = at(el);
    demote();
    const seen: number[] = [];
    for (let i = 0; i < 400 && el.isConnected; i += 1) {
      tickFrames(1);
      if (el.isConnected) {
        seen.push(opacity(el));
        expect(at(el)).toEqual(start);
        expect(el.querySelector('.agent-cursor__name')).not.toBeNull();
      }
    }
    // Falls all the way, without a jump: no frame drops more than a fifth.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i - 1] - seen[i]).toBeLessThan(0.2);
    expect(seen.length).toBeGreaterThan(5);
  });

  it('a prune and a number taken over fade too', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 } }));
    send(event({ ...session('b', 3), target: { x: 400, y: 100 } }));
    flush();
    act(() => { useAgentPresenceStore.getState().prune(Date.now() + 10 * 60_000); });
    tickFrames(3);
    expect(cursors()).toHaveLength(2);
    expect(cursors().every((el) => el.dataset.leaving === 'true')).toBe(true);
    flush();
    expect(cursors()).toHaveLength(0);
  });

  it('under reduced motion it goes in one frame', () => {
    reduceMotion(true);
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2) }));
    flush();
    expect(cursors()).toHaveLength(1);
    demote();
    expect(cursors()).toHaveLength(0);
  });

  it('a number taken over never shows two "Claude · 2" pills: the leaving one hides its pill at once', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 } }));
    flush();
    const visiblePills = () => cursors().filter((el) => el.dataset.taken !== 'true')
      .map((el) => el.querySelector('.agent-cursor__name')!.textContent);
    // The backend gave number 2 to another session: the old one has left.
    send(event({ ...session('b', 2), target: { x: 400, y: 100 } }));
    expect(cursors()).toHaveLength(2);
    expect(visiblePills()).toEqual(['Claude · 2']);
    for (let i = 0; i < 400 && cursors().length > 1; i += 1) {
      tickFrames(1);
      expect(visiblePills().filter((text) => text === 'Claude · 2')).toHaveLength(1);
    }
    expect(cursors()).toHaveLength(1);
  });

  it('a return mid-exit reverses on the same spring: one cursor all the way, never a second', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 } }));
    flush();
    const el = cursors()[0];
    demote();
    tickFrames(6);
    const low = opacity(el);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(1);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 }, say: 'Back' }));
    const seen: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      tickFrames(1);
      expect(cursors()).toHaveLength(1);
      seen.push(opacity(cursors()[0]));
    }
    expect(cursors()[0]).toBe(el); // the same view: no second cursor mounted
    expect(el.dataset.leaving).toBeUndefined();
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(low - 0.05); // no restart from 0
    expect(seen.at(-1)).toBe(1);
    expect(el.querySelector('.agent-cursor__say')?.textContent).toBe('Back');
  });

  it('back mid-exit in a replay (a reconnect): put on its spot, and the fade reverses rather than snapping in', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 } }));
    flush();
    const el = cursors()[0];
    demote();
    tickFrames(6);
    const low = opacity(el);
    act(() => { useAgentPresenceStore.getState().replay([{ ...event({ ...session('a', 2), target: { x: 100, y: 100 } }), secondsAgo: 0 } as never]); });
    tickFrames(1);
    expect(cursors()).toEqual([el]);
    const next = opacity(el);
    expect(next).toBeLessThan(0.9);
    expect(next).toBeGreaterThanOrEqual(low - 0.05);
    flush();
    expect(opacity(el)).toBe(1);
  });

  it("a leaving cursor isn't counted for de-stacking, and paints under live cursors", () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...session('b', 3), target: { nodeId: 'n1' } }));
    flush();
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    expect(where()).toEqual({ aaaaaaaaaaaa: { x: 500, y: 344 }, bbbbbbbbbbbb: { x: 500, y: 344 + S } });
    // a's session leaves (a takeover of its number by another agent's tab is
    // the same): b takes the spot while a still fades.
    act(() => {
      const { agents } = useAgentPresenceStore.getState();
      const rest = { ...agents };
      delete rest['claude#aaaaaaaaaaaa'];
      useAgentPresenceStore.setState({ agents: rest });
    });
    send(event({ ...session('c', 4), target: { x: 900, y: 900 } }));
    tickFrames(1);
    expect(cursors().map((el) => el.dataset.session)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
    expect(cursors()[0].dataset.leaving).toBe('true');
    // b heads for the spot while a is still fading there.
    let movedWhileLeaving = false;
    for (let i = 0; i < 400 && cursors().some((el) => el.dataset.leaving); i += 1) {
      tickFrames(1);
      if (cursors().some((el) => el.dataset.leaving) && where().bbbbbbbbbbbb.y < 366) movedWhileLeaving = true;
    }
    expect(movedWhileLeaving).toBe(true);
    flush();
    expect(where().bbbbbbbbbbbb).toEqual({ x: 500, y: 344 });
  });
});

describe('a cursor at rest is drawn on whole device pixels, off its own layer (GM - Design, PR #211 r10 item 1)', () => {
  // The pane at the page's origin (jsdom's boxes are all 0).
  beforeEach(() => { pane.dom = document.createElement('div'); });
  it('will-change only while it flies; at rest the screen position is a whole pixel', () => {
    pane.transform = [0.3, 0.7, 1.37];
    render(<AgentCursorLayer />);
    send(event({ target: { x: 100.13, y: 200.41 } }));
    tickFrames(3);
    expect(cursors()[0].style.willChange).toBe('transform, opacity');
    flush();
    const el = cursors()[0];
    expect(el.style.willChange).toBe('auto');
    const tip = at(el);
    const [tx, ty, z] = pane.transform;
    for (const screen of [tx + tip.x * z, ty + tip.y * z]) expect(Math.abs(screen - Math.round(screen))).toBeLessThan(1e-6);
    // Within half a pixel of where it aimed.
    expect(Math.abs((tip.x - 100.13) * z)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((tip.y - 200.41) * z)).toBeLessThanOrEqual(0.5);
  });

  it('on a 2x display, whole device pixels are half CSS pixels', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    pane.transform = [0, 0, 1];
    render(<AgentCursorLayer />);
    send(event({ target: { x: 100.3, y: 200.2 } }));
    flush();
    expect(at(cursors()[0])).toEqual({ x: 100.5, y: 200 });
  });

  it('no frame jump at the switch: it lands on the whole pixel, so coming off its layer adds nothing past the landing\'s own last step', () => {
    pane.transform = [0.3, 0.7, 1.37];
    render(<AgentCursorLayer />);
    send(event({ target: { x: 100.13, y: 200.41 } }));
    const frames: { at: { x: number; y: number }; promoted: boolean }[] = [];
    for (let i = 0; i < 400; i += 1) {
      tickFrames(1);
      const el = cursors()[0];
      frames.push({ at: at(el), promoted: el.style.willChange !== 'auto' });
      if (frames.length > 2 && !frames.at(-1)!.promoted && !frames.at(-2)!.promoted) break;
    }
    const switchAt = frames.findIndex((f, i) => i > 0 && frames[i - 1].promoted && !f.promoted);
    expect(switchAt).toBeGreaterThan(0);
    const [before, after] = [frames[switchAt - 1].at, frames[switchAt].at];
    const z = pane.transform[2];
    // The land spring settles within 0.2 screen px; the snap here (0.48 px
    // and 0.26 px off the whole pixel) would jump 0.54 px if drawn only at rest.
    expect(Math.hypot(after.x - before.x, after.y - before.y) * z).toBeLessThanOrEqual(0.2);
  });
});

describe('any person move of a node carries resting cursors at 0 px (GM - Design, PR #211 review 4, item 2)', () => {
  type Entry = { position?: { x: number; y: number }; dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
  const nodes = () => lookupRef.current as Map<string, Entry>;
  const spotOf = (id: string) => {
    const node = nodes().get(id)!;
    return { x: node.internals.positionAbsolute.x + 100, y: node.internals.positionAbsolute.y + 44 };
  };
  /** The node moves to (x, y); `person` says the person put it there (a nudge, Arrange). */
  const putNode = (id: string, x: number, y: number, person: boolean) => {
    const next = new Map(nodes());
    const position = { x, y };
    next.set(id, { ...next.get(id)!, position, internals: { ...next.get(id)!.internals, positionAbsolute: { x, y } } });
    // The record holds the move itself: the position object it put on the node.
    if (person) notePersonPlaced({ [id]: position });
    lookupRef.current = next as never;
    notifyStore();
  };
  const lean = (el: HTMLElement) => el.querySelector<SVGElement>('.agent-cursor__pointer')!.style.transform;

  beforeEach(() => forgetPersonPlaced());

  it.each([['Shift+Arrow nudge', 20], ['arrow nudge', 5], ['Arrange', 300]])('a %s at 300%% zoom: 0 px trail and 0° lean', (_, step) => {
    pane.transform = [0, 0, 3];
    render(<AgentCursorLayer />);
    putNode('n1', 400, 300, true);
    send(event());
    flush();
    const el = cursors()[0];
    expect(at(el)).toEqual(spotOf('n1'));
    for (let press = 1; press <= 5; press += 1) {
      putNode('n1', 400 + step * press, 300, true);
      tickFrames(1);
      expect(at(el)).toEqual(spotOf('n1'));
      expect(lean(el)).toBe('');
      tickFrames(2);
      expect(at(el)).toEqual(spotOf('n1'));
    }
    flush();
    expect(at(el)).toEqual(spotOf('n1'));
  });

  it("a move the person didn't make (a sync) still flies at 300% zoom", () => {
    pane.transform = [0, 0, 3];
    render(<AgentCursorLayer />);
    putNode('n1', 400, 300, true);
    send(event());
    flush();
    const el = cursors()[0];
    putNode('n1', 420, 300, false);
    tickFrames(1);
    expect(at(el)).not.toEqual(spotOf('n1'));
    flush();
    expect(at(el)).toEqual(spotOf('n1'));
  });
});

describe('the pill step (GM - Design, PR #211 r10 item 3, r12 and r13)', () => {
  type Entry = { dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
  const pills = () => cursors().map((el) => {
    const tip = at(el);
    return { left: tip.x + AGENT_CURSOR_PILL.left, top: tip.y + AGENT_CURSOR_PILL.top, width: 70, height: AGENT_CURSOR_PILL.height };
  });
  const apart = (a: ReturnType<typeof pills>[number], b: ReturnType<typeof pills>[number]) =>
    a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top;
  const noOverlap = () => {
    const boxes = pills();
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(apart(a, b)).toBe(true);
  };
  const drag = (dx: number) => {
    const next = new Map(lookupRef.current) as Map<string, Entry>;
    const node = next.get('n1')!;
    next.set('n1', { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: {
      x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y } } });
    lookupRef.current = next as never;
    notifyStore();
  };

  it.each([2, 3])('%i cursors on one node: no pill boxes meet, at rest and after a drag, each keeping its step', (count) => {
    render(<AgentCursorLayer />);
    for (const [i, key] of ['a', 'b', 'c'].slice(0, count).entries()) {
      send(event({ session: { key: key.repeat(12), ordinal: i + 1 }, target: { nodeId: 'n1' } }));
      flush();
    }
    const steps = cursors().map((el) => ({ x: at(el).x - 500, y: at(el).y - 344 }));
    expect(steps).toEqual([{ x: 0, y: 0 }, { x: 0, y: S }, { x: 0, y: 2 * S }].slice(0, count));
    noOverlap();
    for (let i = 0; i < 30; i += 1) {
      drag(12);
      tickFrames(1);
      noOverlap();
    }
    flush();
    noOverlap();
    expect(cursors().map((el) => ({ x: at(el).x - 860, y: at(el).y - 344 }))).toEqual(steps);
  });
});

describe('a cursor carried beside one that is not on its node keeps its order (review 4, N1)', () => {
  type Entry = { dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
  it('B rides n1 with C, a later cursor on a flow point beside it: a small drag swaps nothing', () => {
    render(<AgentCursorLayer />);
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 1 }, target: { nodeId: 'n1' } }));
    flush();
    // C lands later on the flow point where n1's spot is: it steps aside.
    send(event({ session: { key: 'cccccccccccc', ordinal: 2 }, target: { x: 500, y: 344 } }));
    flush();
    const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 500, y: 344 }, cccccccccccc: { x: 500, y: 344 + S } });
    for (let i = 1; i <= 3; i += 1) {
      const next = new Map(lookupRef.current) as Map<string, Entry>;
      const node = next.get('n1')!;
      next.set('n1', { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: { x: 400 + 2 * i, y: 300 } } });
      lookupRef.current = next as never;
      notifyStore();
      tickFrames(1);
      // C stays second, below B: its target is in B's column (r13 item 3).
      expect(where().cccccccccccc.y).toBe(344 + S);
      expect(where().bbbbbbbbbbbb.y).toBe(344);
    }
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 506, y: 344 }, cccccccccccc: { x: 506, y: 344 + S } });
  });
});

describe('round 4c: the column, the says, the exit and the record (PR #211 review 5, GM r12 and r13)', () => {
  const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12), ordinal } });
  const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session!.slice(0, 1), at(el)]));
  const opacity = (el: HTMLElement) => Number(el.style.opacity);
  const demote = () => act(() => { useAgentPresenceStore.getState().demote(); });
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });

  it('a say on the middle cursor: the one below glides down to clear it, and back when it goes, on the land spring', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      for (const [i, key] of ['a', 'b', 'c'].entries()) {
        send(event({ ...session(key, i + 1), target: { nodeId: 'n1' } }));
        flush();
      }
      expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, c: { x: 500, y: 344 + 2 * S } });
      send(event({ ...session('b', 2), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
      const glide: number[] = [];
      for (let i = 0; i < 400 && where().c.y !== 344 + S + SS; i += 1) {
        tickFrames(1);
        glide.push(where().c.y);
      }
      expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, c: { x: 500, y: 344 + S + SS } });
      // A glide, not a jump: several frames between, none moving 12 px or more.
      expect(glide.filter((y) => y > 344 + 2 * S && y < 344 + S + SS).length).toBeGreaterThan(3);
      for (let i = 1; i < glide.length; i += 1) expect(Math.abs(glide[i] - glide[i - 1])).toBeLessThan(12);
      // Says stay visible in the stack.
      const b = cursors().find((el) => el.dataset.session === 'b'.repeat(12))!;
      expect(b.querySelector('.agent-cursor__say')?.textContent).toBe('Checking the prompt');
      expect(b.dataset.label).toBe('name+say');
      // The say goes: c glides back up once it is gone, not while it fades.
      act(() => { vi.advanceTimersByTime(AGENT_SAY_MS + 10); });
      tickFrames(2);
      expect(b.querySelector('.agent-cursor__say--leaving')).not.toBeNull();
      expect(where().c.y).toBe(344 + S + SS);
      act(() => { vi.advanceTimersByTime(AGENT_SAY_FADE_MS + 10); });
      const back: number[] = [];
      for (let i = 0; i < 400 && where().c.y !== 344 + 2 * S; i += 1) {
        tickFrames(1);
        back.push(where().c.y);
      }
      expect(where().c).toEqual({ x: 500, y: 344 + 2 * S });
      expect(back.filter((y) => y > 344 + 2 * S && y < 344 + S + SS).length).toBeGreaterThan(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a say shown before the cursor first lands still counts for the one below it', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'First' }));
    send(event({ ...session('b', 2), target: { nodeId: 'n1' } }));
    flush();
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + stackStepPx(true) } });
  });

  it('two targets 10 px apart: one column, the later straight below the earlier', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 1), target: { x: 300, y: 300 } }));
    flush();
    send(event({ ...session('b', 2), target: { x: 308, y: 306 } }));
    flush();
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S } });
  });

  it.each([2, 3])('%i peers leaving together: every pill keeps its layout, only the tip opacity falls (review 5, M1)', (count) => {
    render(<AgentCursorLayer />);
    for (const [i, key] of ['a', 'b', 'c'].slice(0, count).entries()) {
      send(event({ ...session(key, i + 1), target: { nodeId: 'n1' }, say: i === 1 ? 'Checking the prompt' : '' }));
      flush();
    }
    const views = cursors();
    const before = views.map((el) => ({ label: el.dataset.label, at: at(el), say: el.querySelector('.agent-cursor__say')?.className }));
    expect(before.map((v) => v.label)).toEqual(['name', 'name+say', 'name'].slice(0, count));
    demote();
    let frames = 0;
    for (let i = 0; i < 400 && views.some((el) => el.isConnected); i += 1) {
      tickFrames(1);
      for (const [j, el] of views.entries()) {
        if (!el.isConnected) continue;
        expect(el.dataset.leaving).toBe('true');
        expect(el.dataset.label).toBe(before[j].label);
        expect(at(el)).toEqual(before[j].at);
        expect(el.querySelector('.agent-cursor__say')?.className).toBe(before[j].say);
        // The name shows all the way: nothing took it over (review 5, F9).
        expect(el.dataset.taken).toBeUndefined();
        expect(el.getAttribute('role')).toBeNull(); // F10: no status role while leaving
        expect(opacity(el)).toBeLessThan(1);
      }
      frames += 1;
    }
    expect(frames).toBeGreaterThan(5);
    expect(cursors()).toHaveLength(0);
  });

  it('the say and idle timers stop for the exit: a say due to end mid-exit stays as it was', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Nearly done' }));
      flush();
      act(() => { vi.advanceTimersByTime(AGENT_SAY_MS - 50); });
      const el = cursors()[0];
      demote();
      tickFrames(2);
      act(() => { vi.advanceTimersByTime(AGENT_SAY_MS + AGENT_SAY_FADE_MS + AGENT_CURSOR_IDLE_MS); });
      tickFrames(2);
      expect(el.isConnected).toBe(true);
      expect(el.querySelector('.agent-cursor__say')?.className).toBe('agent-cursor__say');
      expect(el.dataset.idle).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a leaving drag cursor drops its wire on its first exit frame (review 5, F11)', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 1), action: 'drag', from: { nodeId: 'n1' }, target: { nodeId: 'n2' } }));
    const wire = document.querySelector<SVGLineElement>('.agent-cursor__wire')!;
    for (let i = 0; i < 300 && wire.style.opacity !== '1'; i += 1) tickFrames(1);
    expect(wire.style.opacity).toBe('1');
    demote();
    tickFrames(1);
    expect(wire.style.opacity).toBe('0');
  });

  it('a takeover hides the leaving pill for its whole exit, even when the new holder leaves first (review 5, LOW-3)', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 2), target: { x: 100, y: 100 } }));
    flush();
    send(event({ ...session('b', 2), target: { x: 400, y: 100 } }));
    tickFrames(2);
    const old = cursors().find((el) => el.dataset.session === 'a'.repeat(12))!;
    expect(old.dataset.taken).toBe('true');
    demote(); // the new holder leaves too
    const shown = () => cursors().filter((el) => el.dataset.taken !== 'true' && opacity(el) > 0.02)
      .map((el) => el.querySelector('.agent-cursor__name')!.textContent);
    for (let i = 0; i < 400 && cursors().length > 0; i += 1) {
      tickFrames(1);
      if (old.isConnected) expect(old.dataset.taken).toBe('true');
      expect(shown().filter((text) => text === 'Claude · 2').length).toBeLessThanOrEqual(1);
    }
    expect(cursors()).toHaveLength(0);
  });

  it('an idle cursor whose say has ended, back mid-exit, comes back neither idle nor with its say spent (review 5, nextSeq)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 2), target: { x: 100, y: 100 }, say: 'First' }));
      flush();
      act(() => { vi.advanceTimersByTime(AGENT_CURSOR_IDLE_MS + 10); });
      const el = cursors()[0];
      expect(el.dataset.idle).toBe('true');
      expect(el.querySelector('.agent-cursor__say')).toBeNull();
      demote();
      tickFrames(4);
      send(event({ ...session('a', 2), target: { x: 100, y: 100 }, say: 'Back' }));
      tickFrames(2);
      expect(cursors()).toEqual([el]);
      expect(el.dataset.idle).toBeUndefined();
      expect(el.querySelector('.agent-cursor__say')?.textContent).toBe('Back');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('drawn on whole device pixels at rest, whatever moved it (review 5, the draw-time snap)', () => {
    beforeEach(() => { pane.dom = document.createElement('div'); });
    const onWholePixels = (el: HTMLElement) => {
      const tip = at(el);
      const [tx, ty, z] = pane.transform;
      for (const screen of [tx + tip.x * z, ty + tip.y * z]) expect(Math.abs(screen - Math.round(screen))).toBeLessThan(1e-6);
    };

    it('a fractional pan at rest', () => {
      pane.transform = [0, 0, 1.37];
      render(<AgentCursorLayer />);
      send(event({ target: { x: 100.13, y: 200.41 } }));
      flush();
      const el = cursors()[0];
      onWholePixels(el);
      for (const [tx, ty] of [[0.25, 0.6], [13.71, -2.38], [-40.5, 7.13]]) {
        pane.transform = [tx, ty, 1.37];
        notifyStore();
        flush();
        expect(el.style.willChange).toBe('auto');
        onWholePixels(el);
      }
    });

    it("a ride's end on a node moved by fractions", () => {
      type Entry = { dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
      pane.transform = [0.3, 0.7, 1.37];
      render(<AgentCursorLayer />);
      send(event());
      flush();
      const el = cursors()[0];
      for (let i = 1; i <= 8; i += 1) {
        const next = new Map(lookupRef.current) as Map<string, Entry>;
        const node = next.get('n1')!;
        next.set('n1', { ...node, dragging: i < 8, internals: { ...node.internals, positionAbsolute: { x: 400 + 3.17 * i, y: 300 + 1.29 * i } } });
        lookupRef.current = next as never;
        notifyStore();
        tickFrames(1);
      }
      flush();
      expect(el.style.willChange).toBe('auto');
      onWholePixels(el);
    });
  });
});

describe('round 4d: the owned step, no foreign overlap, nothing jumps, says wait their turn, zoom rides (GM r14 and r15, review 6)', () => {
  type Entry = { dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
  const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12), ordinal } });
  const byKey = (k: string) => cursors().find((el) => el.dataset.session === k.repeat(12))!;
  const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session!.slice(0, 1), at(el)]));
  /** A cursor as drawn this frame, in screen px: its say counts once it shows (not while it waits). */
  const shapeOf = (el: HTMLElement) => {
    const p = at(el);
    const [tx, ty, z] = pane.transform;
    const name = el.querySelector('.agent-cursor__name')!.textContent!;
    const say = el.querySelector('.agent-cursor__say');
    const w = labelWidths(name, say?.textContent);
    const painted = say !== null && el.dataset.sayWait === undefined;
    return cursorShape({ x: p.x * z + tx, y: p.y * z + ty }, painted && (el.dataset.saySide === 'left' ? 'left' : true), w.nameW, w.sayW);
  };
  const leastClear = () => {
    const shapes = cursors().filter((el) => el.dataset.leaving !== 'true' && el.dataset.collapsed !== 'true').map(shapeOf);
    let least = Infinity;
    for (const [i, a] of shapes.entries()) for (const b of shapes.slice(i + 1)) least = Math.min(least, cursorClearancePx(a, b));
    return least;
  };
  const drag = (id: string, dx: number) => {
    const next = new Map(lookupRef.current) as Map<string, Entry>;
    const node = next.get(id)!;
    next.set(id, { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: {
      x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y } } });
    lookupRef.current = next as never;
    notifyStore();
  };
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const column = () => {
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      send(event({ ...session(key, i + 1), target: { nodeId: 'n1' } }));
      flush();
    }
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, c: { x: 500, y: 344 + 2 * S } });
  };

  it.each([
    ['(0, 19)', [19]],
    ['(0, 30, 15)', [30, 15]],
  ])('%s: 2 px clear and no arrow by a foreign label, at rest and through a drag of the head', (_name, below) => {
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 1), target: { nodeId: 'n1' } }));
    flush();
    for (const [i, dy] of below.entries()) {
      send(event({ ...session('bc'[i], i + 2), target: { x: 500, y: 344 + dy } }));
      flush();
    }
    expect(Object.values(where()).map((p) => p.x)).toEqual(Array(below.length + 1).fill(500));
    expect(leastClear()).toBeGreaterThanOrEqual(2 - 1e-6);
    for (let i = 0; i < 40; i += 1) {
      drag('n1', 6);
      tickFrames(1);
      expect(leastClear()).toBeGreaterThanOrEqual(2 - 1e-6);
    }
    drag('n1', 0);
    flush();
    expect(leastClear()).toBeGreaterThanOrEqual(2 - 1e-6);
  });

  it.each([[1, 0.5], [0.5, 2]])('a zoom from %s to %s carries the column at its screen-px steps every frame: no spring, 2 px clear', (from, to) => {
    pane.transform = [0, 0, from];
    render(<AgentCursorLayer />);
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      send(event({ ...session(key, i + 1), target: { nodeId: 'n1' } }));
      flush();
    }
    const steps = () => {
      const z = pane.transform[2];
      const ys = ['a', 'b', 'c'].map((k) => at(byKey(k)).y * z);
      return [ys[1] - ys[0], ys[2] - ys[1]];
    };
    expect(steps().map((d) => Math.round(d))).toEqual([S, S]);
    for (let f = 1; f <= 18; f += 1) {
      pane.transform = [0, 0, from + ((to - from) * f) / 18];
      notifyStore();
      // Carried in the zoom's own frame, not the next one (live, round 4d).
      for (const d of steps()) expect(d).toBeCloseTo(S, 6);
      tickFrames(1);
      for (const d of steps()) expect(d).toBeCloseTo(S, 6);
      expect(leastClear()).toBeGreaterThanOrEqual(2 - 1e-6);
    }
  });

  it('a chain that splits: every cursor that must move glides there on the land spring, together, nothing jumps (review 6, item 2)', () => {
    render(<AgentCursorLayer />);
    // a, b, c and d each 15 px below the last: one column by targets.
    for (const [i, key] of ['a', 'b', 'c', 'd'].entries()) {
      send(event({ ...session(key, i + 1), target: { x: 300, y: 300 + 15 * i } }));
      flush();
    }
    // Four in one column: d folds into c's count cursor (GM r17 item 1).
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S }, c: { x: 300, y: 300 + 2 * S }, d: { x: 300, y: 300 + 2 * S } });
    expect(byKey('c').dataset.count).toBe('2');
    expect(byKey('d').dataset.collapsed).toBe('true');
    // b goes elsewhere: c, 30 px from a, still meets a's label, and d meets
    // c; the count cursor opens back into c and d.
    send(event({ ...session('b', 2), target: { nodeId: 'n2' } }));
    const path: { c: number; d: number }[] = [];
    for (let i = 0; i < 200 && (where().c.y !== 300 + S || where().d.y !== 300 + 2 * S); i += 1) {
      tickFrames(1);
      path.push({ c: where().c.y, d: where().d.y });
    }
    expect(where().c).toEqual({ x: 300, y: 300 + S });
    expect(where().d).toEqual({ x: 300, y: 300 + 2 * S });
    expect(byKey('c').dataset.count).toBeUndefined();
    expect(byKey('d').dataset.collapsed).toBeUndefined();
    expect(path.filter((p) => p.c > 300 + S && p.c < 300 + 2 * S).length).toBeGreaterThan(3);
    for (let i = 1; i < path.length; i += 1) {
      expect(Math.abs(path[i].c - path[i - 1].c)).toBeLessThan(12);
      // d opens where the count cursor was, and c glides up out of it: the
      // step between them only grows.
      expect(path[i].d).toBe(300 + 2 * S);
      expect(path[i].d - path[i].c).toBeGreaterThanOrEqual(path[i - 1].d - path[i - 1].c - 1e-9);
    }
  });

  it('a say on the top cursor: the cursors below glide first, the say fades in once the room is clear, and never over an arrow (review 6, item 3)', () => {
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    const a = byKey('a');
    const frames: { waiting: boolean; b: number; clear: number }[] = [];
    for (let i = 0; i < 120 && (where().b.y !== 344 + SS || where().c.y !== 344 + SS + S); i += 1) {
      tickFrames(1);
      frames.push({ waiting: a.dataset.sayWait === 'true', b: where().b.y, clear: leastClear() });
    }
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + SS }, c: { x: 500, y: 344 + SS + S } });
    // It waited while b moved, then showed, and never hid again.
    expect(frames[0].waiting).toBe(true);
    const shownAt = frames.findIndex((f) => !f.waiting);
    expect(shownAt).toBeGreaterThan(2);
    expect(frames.slice(shownAt).every((f) => !f.waiting)).toBe(true);
    // b had all but finished its glide: its arrow clear of a's say block.
    expect(frames[shownAt].b).toBeGreaterThan(344 + SS - 1);
    // The say counts in every frame it shows: never within 2 px of an arrow.
    for (const f of frames) expect(f.clear).toBeGreaterThanOrEqual(2 - 1e-6);
    expect(a.querySelector('.agent-cursor__say')?.textContent).toBe('Checking the prompt');
  });

  it('a say that goes fades out first, then the cursors below close up', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column();
      send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
      flush();
      expect(where().b.y).toBe(344 + SS);
      act(() => { vi.advanceTimersByTime(AGENT_SAY_MS + 10); });
      tickFrames(3);
      expect(byKey('a').querySelector('.agent-cursor__say--leaving')).not.toBeNull();
      expect(where().b.y).toBe(344 + SS);
      act(() => { vi.advanceTimersByTime(AGENT_SAY_FADE_MS + 10); });
      expect(byKey('a').querySelector('.agent-cursor__say')).toBeNull();
      const up: number[] = [];
      for (let i = 0; i < 200 && where().b.y !== 344 + S; i += 1) {
        tickFrames(1);
        up.push(where().b.y);
      }
      expect(up.filter((y) => y > 344 + S && y < 344 + SS).length).toBeGreaterThan(3);
      expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, c: { x: 500, y: 344 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a say still waiting when the tab is hidden shows on return, the cursors below landed', () => {
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    tickFrames(2);
    expect(byKey('a').dataset.sayWait).toBe('true');
    const visibility = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    };
    try {
      visibility('hidden');
      clock += 1500;
      visibility('visible');
      flush();
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
    expect(where().b).toEqual({ x: 500, y: 344 + SS });
    expect(byKey('a').dataset.sayWait).toBeUndefined();
  });

  it("a long name's pill counts at its width: a target on it, past the default width, joins its column", () => {
    render(<AgentCursorLayer />);
    send(event({ agent: { id: 'long', name: 'A rather long agent name', color: '#3FC1A5', verified: false }, ...session('a', 1), target: { x: 300, y: 300 } }));
    flush();
    // 120 px right, 10 down: on that name pill (about 190 px wide), past a
    // default 80 px one.
    send(event({ ...session('b', 2), target: { x: 420, y: 310 } }));
    flush();
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S } });
  });

  it('under reduced motion a say shows at once and the cursors below are there on the next frame', () => {
    reduceMotion(true);
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    tickFrames(1);
    expect(byKey('a').dataset.sayWait).toBeUndefined();
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + SS }, c: { x: 500, y: 344 + SS + S } });
  });

  it('a waiting say is hidden by CSS and fades in when the wait ends; never under reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
    // Waiting ('true') or in the Agent log only ('log'): hidden either way.
    const rule = css.match(/^\.agent-cursor\[data-say-wait\] \.agent-cursor__say \{([^}]*)\}/m);
    expect(rule?.[1]).toMatch(/animation: none;/);
    expect(rule?.[1]).toMatch(/opacity: 0;/);
    const layer = readFileSync(resolve(__dirname, '../src/components/canvas/AgentCursorLayer.tsx'), 'utf8');
    // Under reduced motion it takes its place at once (capped: no wait).
    expect(layer).toMatch(/if \(prefersReducedMotion\(\)\) \{\n\s+setSay\.current\('hold'\);\n\s+decideSay\.current\(true\);/);
  });
});


describe('round 4e: the head leads its column, says find room or wait for the log, columns cap at 3, zoom and fonts (review 7, GM r17)', () => {
  type Entry = { dragging?: boolean; internals: { positionAbsolute: { x: number; y: number } } };
  const session = (key: string, ordinal: number) => ({ session: { key: key.repeat(12), ordinal } });
  const byKey = (k: string) => cursors().find((el) => el.dataset.session === k.repeat(12))!;
  const where = () => Object.fromEntries(cursors().map((el) => [el.dataset.session!.slice(0, 1), at(el)]));
  const painted = (el: HTMLElement) => el.querySelector('.agent-cursor__say') !== null && el.dataset.sayWait === undefined;
  /** A cursor as drawn this frame, in screen px: its say counts once it shows, on its side. */
  const shapeOf = (el: HTMLElement) => {
    const p = at(el);
    const [tx, ty, z] = pane.transform;
    const name = el.querySelector('.agent-cursor__name')!.textContent!;
    const say = el.querySelector('.agent-cursor__say');
    const w = labelWidths(name, say?.textContent);
    return cursorShape({ x: p.x * z + tx, y: p.y * z + ty }, painted(el) && (el.dataset.saySide === 'left' ? 'left' : true), w.nameW, w.sayW);
  };
  const drawn = () => cursors().filter((el) => el.dataset.leaving !== 'true' && el.dataset.collapsed !== 'true');
  /** Any two drawn cursors meeting: closer than 2 px, or an arrow beside a label that isn't its own. */
  const anyMeet = () => {
    const shapes = drawn().map(shapeOf);
    for (const [i, a] of shapes.entries()) for (const b of shapes.slice(i + 1)) if (cursorsMeet(a, b)) return true;
    return false;
  };
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  /** One frame, with the timers (and performance.now) a frame on too. */
  const frame = () => {
    act(() => { vi.advanceTimersByTime(1000 / 60); });
    tickFrames(1);
  };
  const column = (keys = ['a', 'b', 'c'], target: AgentPresenceEvent['target'] = { nodeId: 'n1' }) => {
    for (const [i, key] of keys.entries()) {
      send(event({ ...session(key, i + 1), target }));
      flush();
    }
  };

  // Review 7, MEDIUM-1 (P1): the head nudges its own target within its
  // stamp radius. The members follow its drawn tip, never under the step.
  it.each([[0, -10], [12, 0], [0, 10], [-12, -8]])('the head moves (%s, %s) by its own event: the column glides with it, never under the step, nothing meets', (dx, dy) => {
    render(<AgentCursorLayer />);
    column(['a', 'b', 'c'], { x: 300, y: 300 });
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S }, c: { x: 300, y: 300 + 2 * S } });
    send(event({ ...session('a', 1), target: { x: 300 + dx, y: 300 + dy } }));
    let maxJump = 0;
    let minStep = Infinity;
    let meetFrames = 0;
    let moving = 0;
    let prev = where();
    for (let i = 0; i < 120; i += 1) {
      tickFrames(1);
      const w = where();
      for (const k of ['b', 'c']) maxJump = Math.max(maxJump, Math.hypot(w[k].x - prev[k].x, w[k].y - prev[k].y));
      if (w.b.y !== prev.b.y || w.b.x !== prev.b.x) moving += 1;
      minStep = Math.min(minStep, w.b.y - w.a.y, w.c.y - w.b.y);
      if (anyMeet()) meetFrames += 1;
      prev = w;
    }
    flush();
    expect(where()).toEqual({
      a: { x: 300 + dx, y: 300 + dy }, b: { x: 300 + dx, y: 300 + dy + S }, c: { x: 300 + dx, y: 300 + dy + 2 * S },
    });
    // A glide over many frames, at about the head's own pace and
    // eb3d2477's glide (1.2 to 1.6 px a frame at most; review 7 saw 10 to
    // 14.4 px jumps).
    expect(moving).toBeGreaterThan(8);
    expect(maxJump).toBeLessThan(1.7);
    expect(minStep).toBeGreaterThanOrEqual(S - 1e-6);
    expect(meetFrames).toBe(0);
  });

  it('a head carried by its node still carries its column in the same frame (a ride, not a glide)', () => {
    render(<AgentCursorLayer />);
    column();
    for (let i = 1; i <= 10; i += 1) {
      const next = new Map(lookupRef.current) as Map<string, Entry>;
      const node = next.get('n1')!;
      next.set('n1', { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: { x: 400, y: 300 - 3 * i } } });
      lookupRef.current = next as never;
      notifyStore();
      tickFrames(1);
      expect(where()).toEqual({ a: { x: 500, y: 344 - 3 * i }, b: { x: 500, y: 344 - 3 * i + S }, c: { x: 500, y: 344 - 3 * i + 2 * S } });
    }
  });

  // Review 7, MEDIUM-2 (P3, P5; they pin F24): a flyer landing under the
  // speaking cursor holds its say.
  it('a say on the head while the cursor below acts in the same moment: the say waits for it, never painted over its arrow', () => {
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    send(event({ ...session('b', 2), target: { nodeId: 'n1' }, action: 'look' }));
    let waited = 0;
    let shownMeeting = 0;
    for (let i = 0; i < 90; i += 1) {
      tickFrames(1);
      if (!painted(byKey('a'))) waited += 1;
      else if (anyMeet()) shownMeeting += 1;
    }
    expect(waited).toBeGreaterThan(3);
    expect(shownMeeting).toBe(0);
    expect(painted(byKey('a'))).toBe(true);
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + SS }, c: { x: 500, y: 344 + SS + S } });
  });

  it.each([['a', 'b'], ['b', 'a']])('two says at once (%s, then %s): each waits for the column below it, nothing meets', (first, second) => {
    render(<AgentCursorLayer />);
    column();
    const says: Record<string, string> = { a: 'Checking the prompt', b: 'Reading the brief now' };
    for (const k of [first, second]) send(event({ ...session(k, k === 'a' ? 1 : 2), target: { nodeId: 'n1' }, say: says[k] }));
    let meetFrames = 0;
    for (let i = 0; i < 90; i += 1) {
      tickFrames(1);
      if (anyMeet()) meetFrames += 1;
    }
    expect(meetFrames).toBe(0);
    expect(painted(byKey('a')) && painted(byKey('b'))).toBe(true);
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + SS }, c: { x: 500, y: 344 + 2 * SS } });
  });

  it('a flyer passing through elsewhere doesn\'t hold a say', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b']);
    // e flies across the canvas far from a's say room.
    send(event({ ...session('e', 3), target: { x: 100, y: 100 } }));
    flush();
    send(event({ ...session('e', 3), target: { x: 900, y: 120 } }));
    tickFrames(2);
    send(event({ ...session('b', 2), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    tickFrames(1);
    expect(painted(byKey('b'))).toBe(true);
  });

  // GM r17 item 2: another column in the way on the right.
  const blocker = (key: string, ordinal: number, x: number, y: number, extra: Partial<AgentPresenceEvent> = {}) => {
    send(event({ ...session(key, ordinal), target: { x, y }, ...extra }));
    flush();
  };

  it('a say with another column\'s arrow on its right moves left of its own arrow, right edge 4 px left of the tip, and moves nobody', () => {
    render(<AgentCursorLayer />);
    blocker('a', 1, 300, 300);
    blocker('e', 2, 360, 346);
    const before = where();
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    tickFrames(2);
    const a = byKey('a');
    expect(a.dataset.saySide).toBe('left');
    expect(painted(a)).toBe(true);
    expect(anyMeet()).toBe(false);
    flush();
    expect(where()).toEqual(before);
  });

  it('no room on either side: the say waits, then after 600 ms shows in the Agent log only, and comes back once the room clears (pins the cap)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      blocker('a', 1, 300, 300);
      blocker('e', 2, 360, 346);
      blocker('f', 3, 210, 346);
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const t0 = performance.now();
      const a = byKey('a');
      let loggedAt = -1;
      for (let i = 0; i < 60 && loggedAt < 0; i += 1) {
        frame();
        expect(painted(a)).toBe(false);
        if (a.dataset.sayWait === 'log') loggedAt = performance.now() - t0;
        else expect(a.dataset.sayWait).toBe('true');
      }
      expect(loggedAt).toBeGreaterThan(600);
      expect(loggedAt).toBeLessThan(640);
      // Off the canvas, still said: the cursor's label keeps it, and the
      // Agent log has it (agentLogStore).
      expect(a.getAttribute('aria-label')).toBe('Claude: Checking the prompt');
      for (let i = 0; i < 10; i += 1) frame();
      expect(a.dataset.sayWait).toBe('log');
      // e goes: the right side clears, and the say, still current, shows.
      send(event({ ...session('e', 2), target: { nodeId: 'n2' } }));
      let back = -1;
      for (let i = 0; i < 90 && back < 0; i += 1) {
        frame();
        if (painted(a)) back = i;
        if (painted(a)) expect(anyMeet()).toBe(false);
      }
      expect(back).toBeGreaterThan(0);
      expect(a.dataset.saySide).toBeUndefined();
      expect(performance.now() - t0).toBeLessThan(AGENT_SAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('another cursor\'s say pill counts as in the way (review 7, LOW-2 M4)', () => {
    render(<AgentCursorLayer />);
    blocker('a', 1, 300, 300);
    // e, below and to the left, says first: its say pill runs 1 px under
    // a's say row, on both sides of a's arrow; its arrow and name are clear.
    blocker('e', 2, 180, 321);
    send(event({ ...session('e', 2), target: { x: 180, y: 321 }, say: 'Reading the brief and the prompt' }));
    tickFrames(2);
    expect(painted(byKey('e'))).toBe(true);
    expect(byKey('e').dataset.saySide).toBeUndefined();
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    tickFrames(10);
    expect(byKey('a').dataset.sayWait).toBe('true');
    expect(anyMeet()).toBe(false);
  });

  it('another cursor\'s pills count at their measured widths, not a default (review 7, LOW-2 M5)', () => {
    render(<AgentCursorLayer />);
    blocker('a', 1, 300, 300);
    blocker('e', 1, 150, 326, { agent: { id: 'e', name: 'A very long agent name for the pill', color: '#5B9DFF', verified: true } });
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    tickFrames(10);
    expect(byKey('a').dataset.sayWait).toBe('true');
    expect(anyMeet()).toBe(false);
  });

  it('a say waits for a cursor still flying to a spot under it, however far away it is (r17 item 3)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b']);
    send(event({ ...session('c', 3), target: { x: 2400, y: 1400 } }));
    flush();
    // c flies in from far off to join under b, as a speaks.
    send(event({ ...session('c', 3), target: { nodeId: 'n1' } }));
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    let shownAt = -1;
    for (let i = 0; i < 90 && shownAt < 0; i += 1) {
      tickFrames(1);
      if (painted(byKey('a'))) shownAt = i;
    }
    // b is clear of the say after about 14 frames; c's flight takes longer.
    expect(shownAt).toBeGreaterThan(24);
    flush();
    expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + SS }, c: { x: 500, y: 344 + SS + S } });
  });

  it('a zoom mid-glide keeps the glide where it is on screen: the step it has so far, in that very frame (review 7, MEDIUM-3)', () => {
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    tickFrames(4);
    const screenY = (k: string) => at(byKey(k)).y * pane.transform[2] + pane.transform[1];
    const before = [screenY('b') - screenY('a'), screenY('c') - screenY('b')];
    expect(before[0]).toBeGreaterThan(S + 1);
    expect(before[0]).toBeLessThan(SS - 1);
    for (const z of [0.5, 1.7]) {
      pane.transform = [0, 0, z];
      notifyStore();
      expect(screenY('b') - screenY('a')).toBeCloseTo(before[0], 6);
      expect(screenY('c') - screenY('b')).toBeCloseTo(before[1], 6);
    }
  });

  // GM r17 item 1: a column draws at most 3.
  describe('the count cursor', () => {
    const rectFor = (el: Element): DOMRect => {
      if (el === pane.dom) return new DOMRect(0, 0, 1440, 900);
      const cursor = el.closest<HTMLElement>('.agent-cursor');
      const p = cursor ? at(cursor) : { x: -999, y: -999 };
      if (el.classList.contains('agent-cursor__name')) return new DOMRect(p.x + 15, p.y + 17, 50, 20);
      return new DOMRect(0, 0, 0, 0);
    };
    beforeEach(() => {
      pane.dom = document.createElement('div');
      document.body.appendChild(pane.dom);
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return rectFor(this);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      pane.dom?.remove();
    });
    const pointer = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })); });
    const list = (el: HTMLElement) => [...el.querySelectorAll('.agent-cursor__list-name')].map((n) => n.textContent);

    it('four or more: two in full, then one neutral arrow with "2 more" that lists the names on hover; the later arrivals fade out into it', () => {
      render(<AgentCursorLayer />);
      column(['a', 'b', 'c', 'd']);
      const c = byKey('c');
      const d = byKey('d');
      expect(where()).toEqual({ a: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, c: { x: 500, y: 344 + 2 * S }, d: { x: 500, y: 344 + 2 * S } });
      expect(c.dataset.count).toBe('2');
      expect(c.querySelector('.agent-cursor__name')!.textContent).toBe('2 more');
      expect(c.style.getPropertyValue('--agent-color')).toBe('#52525b');
      expect(c.getAttribute('aria-label')).toBe('2 more: Claude · 3, Claude · 4');
      expect(c.getAttribute('role')).toBe('status');
      // Not focusable, as no cursor is.
      expect(c.querySelector('[tabindex]')).toBeNull();
      expect(c.hasAttribute('tabindex')).toBe(false);
      expect(d.dataset.collapsed).toBe('true');
      expect(d.getAttribute('aria-hidden')).toBe('true');
      expect(Number(d.style.opacity)).toBeLessThan(0.01);
      expect(list(c)).toEqual(['Claude · 3', 'Claude · 4']);
      expect(c.dataset.hover).toBeUndefined();
      const p = at(c);
      pointer(p.x + 30, p.y + 25);
      expect(c.dataset.hover).toBe('true');
      pointer(1400, 880);
      expect(c.dataset.hover).toBeUndefined();
      // Up to three names, then how many more.
      for (const [k, ordinal] of [['e', 5], ['f', 6]] as const) {
        send(event({ ...session(k, ordinal), target: { nodeId: 'n1' } }));
        flush();
      }
      expect(where().e).toEqual(where().c);
      expect(c.querySelector('.agent-cursor__name')!.textContent).toBe('4 more');
      expect(list(c)).toEqual(['Claude · 3', 'Claude · 4', 'Claude · 5', '1 more']);
      expect(c.getAttribute('aria-label')!.startsWith('4 more')).toBe(true);
    });

    it('members leave: the count cursor opens back into full cursors on the layout spring, nothing jumps', () => {
      render(<AgentCursorLayer />);
      column(['a', 'b', 'c', 'd']);
      act(() => {
        const s = useAgentPresenceStore;
        const agents = { ...s.getState().agents };
        for (const k of Object.keys(agents)) if (agents[k].session?.key === 'a'.repeat(12)) delete agents[k];
        s.setState({ agents });
      });
      const path: Record<string, { x: number; y: number }>[] = [];
      for (let i = 0; i < 80; i += 1) {
        tickFrames(1);
        path.push(where());
      }
      flush();
      expect(byKey('c').dataset.count).toBeUndefined();
      expect(byKey('d').dataset.collapsed).toBeUndefined();
      expect(Number(byKey('d').style.opacity)).toBe(1);
      expect(where()).toMatchObject({ b: { x: 500, y: 344 }, c: { x: 500, y: 344 + S }, d: { x: 500, y: 344 + 2 * S } });
      for (let i = 1; i < path.length; i += 1) {
        for (const k of ['b', 'c', 'd']) expect(Math.abs(path[i][k].y - path[i - 1][k].y)).toBeLessThan(12);
      }
      // A glide: c passes through the frames between.
      expect(path.filter((w) => w.c.y > 344 + S + 1 && w.c.y < 344 + 2 * S - 1).length).toBeGreaterThan(3);
    });
  });

  // Review 7, MEDIUM-3: a zoom one frame after a say, while the column glides.
  const zoomRuns: [string, (f: number) => [number, number, number][]][] = [
    // setViewport over 300 ms: one smooth step a frame.
    ['setViewport 1 → 0.5', (f) => (f >= 1 && f <= 18 ? [[0, 0, 1 - (0.5 * f) / 18]] : [])],
    // Keyboard zoom: a few discrete steps, frames apart.
    ['keyboard zoom in, then out', (f) => (f === 1 ? [[0, 0, 1.2]] : f === 4 ? [[0, 0, 1.44]] : f === 8 ? [[0, 0, 1.2]] : f === 12 ? [[0, 0, 1]] : f === 15 ? [[0, 0, 0.833]] : [])],
    // Pinch: several wheel events a frame, zooming about the pointer.
    ['pinch about the pointer', (f) => (f >= 1 && f <= 14 ? [1, 2, 3].map((k) => {
      const z = 1 - (0.4 * ((f - 1) * 3 + k)) / 42;
      return [700 * (1 - z), 400 * (1 - z), z] as [number, number, number];
    }) : [])],
  ];
  const zoomGlide = (zoomAt: (f: number) => [number, number, number][]) => {
    render(<AgentCursorLayer />);
    column();
    send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
    tickFrames(1);
    let minAB = Infinity;
    let minBC = Infinity;
    let meetFrames = 0;
    const screenY = (k: string) => at(byKey(k)).y * pane.transform[2] + pane.transform[1];
    const check = () => {
      minAB = Math.min(minAB, screenY('b') - screenY('a'));
      minBC = Math.min(minBC, screenY('c') - screenY('b'));
      if (anyMeet()) meetFrames += 1;
    };
    for (let f = 1; f <= 60; f += 1) {
      for (const t of zoomAt(f)) {
        pane.transform = t;
        notifyStore();
        // Carried in the zoom's own frame.
        check();
      }
      tickFrames(1);
      check();
    }
    flush();
    expect(minAB).toBeGreaterThanOrEqual(S - 1e-6);
    expect(minBC).toBeGreaterThanOrEqual(S - 1e-6);
    expect(meetFrames).toBe(0);
    expect(screenY('b') - screenY('a')).toBeCloseTo(SS, 6);
    expect(screenY('c') - screenY('b')).toBeCloseTo(S, 6);
  };
  it.each(zoomRuns)('%s, starting one frame after a say: the steps stay in screen px while the column glides, nothing meets', (_name, zoomAt) => {
    zoomGlide(zoomAt);
  });
  // #219 r3h: the same, with performance.now() as a browser has it, a little
  // past the last frame's timestamp and later on each read. A zoom's carry
  // read the clock once per cursor, so the member above stepped at t and
  // this one at t + a few µs: hold() took the one above for one still to
  // step and left this one off the floor, 40.89 px apart (CI part 3, whose
  // worker clock had run past the frames' clock; a fresh local worker's
  // hadn't). The carry steps every cursor in the frame it happens in.
  it.each(zoomRuns)('%s, starting one frame after a say, the clock past the frame: the steps stay in screen px while the column glides, nothing meets', (_name, zoomAt) => {
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock + 4 + (reads += 0.001));
    try {
      zoomGlide(zoomAt);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Review 7, MEDIUM-4: a pill measured before its font loaded.
  it('fonts that finish loading measure the pills again: a cursor whose arrow the wider name now reaches joins its column', () => {
    let loaded = false;
    class StubCanvas {
      getContext() {
        return { font: '', measureText: (text: string) => ({ width: text.length * (loaded ? 9 : 6) }) };
      }
    }
    const fonts = new EventTarget() as EventTarget & { load: ReturnType<typeof vi.fn> };
    fonts.load = vi.fn(() => Promise.resolve([]));
    vi.stubGlobal('OffscreenCanvas', StubCanvas);
    const realFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      const agent = { id: 'g', name: 'Ελληνικός πράκτορας', color: '#5B9DFF', verified: true };
      render(<AgentCursorLayer />);
      send(event({ ...session('d', 1), agent, target: { x: 300, y: 300 } }));
      flush();
      expect(fonts.load).toHaveBeenCalledWith('600 11px Inter', 'Ελληνικός πράκτορας');
      const narrow = labelWidths(agent.name, '').nameW;
      loaded = true;
      const wide = labelWidths(agent.name, '').nameW;
      loaded = false;
      expect(wide - narrow).toBeGreaterThan(30);
      // Its arrow halfway between the two right edges, on the name's row.
      const x = 300 + AGENT_CURSOR_PILL.left + (narrow + wide) / 2;
      send(event({ ...session('b', 2), target: { x, y: 310 } }));
      flush();
      expect(where().b).toEqual({ x, y: 310 });
      loaded = true;
      act(() => { fonts.dispatchEvent(new Event('loadingdone')); });
      flush();
      // Now measured as drawn: b's arrow is by g's name, so it joins.
      expect(where().b).toEqual({ x: 300, y: 300 + S });
    } finally {
      if (realFonts) Object.defineProperty(document, 'fonts', realFonts);
      else delete (document as unknown as { fonts?: unknown }).fonts;
      vi.unstubAllGlobals();
    }
  });


  // GM r18 item 3: the layout counts only what is drawn. A say in the Agent
  // log keeps no room under its cursor; when it comes back, the cursors
  // below glide first and then it fades in (the review 6 order).
  it('a say in the Agent log reserves no room; coming back, the column glides first, then the say fades in, nothing jumps (r18 item 3)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column(['a', 'b'], { x: 300, y: 300 });
      // Another column on each side of a's say row, clear of a and b.
      blocker('e', 3, 400, 318);
      blocker('f', 4, 150, 322);
      const before = where();
      expect(before.b).toEqual({ x: 300, y: 300 + S });
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const a = byKey('a');
      for (let i = 0; i < 60 && a.dataset.sayWait !== 'log'; i += 1) frame();
      expect(a.dataset.sayWait).toBe('log');
      // In the log: b settles back at a name step, no say step kept.
      for (let i = 0; i < 90; i += 1) frame();
      expect(a.dataset.sayWait).toBe('log');
      expect(where().b.y - where().a.y).toBeCloseTo(S, 6);
      expect(where().e).toEqual(before.e);
      expect(where().f).toEqual(before.f);
      // e goes: the right side clears. b glides down to the say step first,
      // then the say fades in.
      send(event({ ...session('e', 3), target: { nodeId: 'n2' } }));
      let prev = where();
      let shownAt = -1;
      let gliding = 0;
      for (let i = 0; i < 120 && shownAt < 0; i += 1) {
        frame();
        const w = where();
        expect(Math.abs(w.b.y - prev.b.y)).toBeLessThan(4);
        expect(w.b.y - w.a.y).toBeGreaterThanOrEqual(S - 1e-6);
        if (w.b.y !== prev.b.y) gliding += 1;
        if (painted(a)) {
          shownAt = i;
          expect(w.b.y - w.a.y).toBeGreaterThanOrEqual(stackStepPx(true) - 0.01);
          expect(anyMeet()).toBe(false);
        } else {
          expect(a.dataset.sayWait).toBeDefined();
        }
        prev = w;
      }
      expect(shownAt).toBeGreaterThan(3);
      expect(gliding).toBeGreaterThan(3);
      expect(a.dataset.saySide).toBeUndefined();
      flush();
      expect(where().b.y - where().a.y).toBeCloseTo(stackStepPx(true), 6);
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r18 item 1: a folded member's say is in the Agent log only. Once it
  // unfolds, a say still current shows by the normal order.
  it('a folded member\'s say shows only in the Agent log; unfolded while still current, it shows by the normal order (r18 item 1)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b', 'c', 'd']);
    const before = where();
    const d = byKey('d');
    expect(d.dataset.collapsed).toBe('true');
    const said = event({ ...session('d', 4), target: { nodeId: 'n1' }, say: 'Reading the brief' });
    send(said);
    flush();
    expect(agentActionEntry(said)?.message).toBe('Reading the brief');
    expect(d.dataset.collapsed).toBe('true');
    expect(painted(d)).toBe(false);
    expect(d.querySelector('.agent-cursor__say')).toBeNull();
    // No room kept for it, and the count cursor draws no say either.
    expect(where()).toEqual(before);
    expect(painted(byKey('c'))).toBe(false);
    // a leaves: d unfolds as the last full cursor, and its say, still
    // current, shows below it.
    act(() => {
      const st = useAgentPresenceStore;
      const agents = { ...st.getState().agents };
      for (const k of Object.keys(agents)) if (agents[k].session?.key === 'a'.repeat(12)) delete agents[k];
      st.setState({ agents });
    });
    // The unfold renders after the column's frames have run: nothing but
    // d's own say is left to wake its loop.
    flush();
    flush();
    expect(d.dataset.collapsed).toBeUndefined();
    expect(painted(d)).toBe(true);
    expect(anyMeet()).toBe(false);
  });


  // GM r19 item 2: hold still. A say that another column blocks waits with
  // nothing moving; it goes to the log with every position unchanged.
  it('a say blocked by another column holds with nothing moving, and goes to the log leaving every position unchanged (r19 item 2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column(['a', 'b'], { x: 300, y: 300 });
      blocker('e', 3, 400, 318);
      blocker('f', 4, 150, 322);
      const before = where();
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const a = byKey('a');
      for (let i = 0; i < 120; i += 1) {
        frame();
        expect(where()).toEqual(before);
        expect(painted(a)).toBe(false);
      }
      expect(a.dataset.sayWait).toBe('log');
      expect(where()).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('once the blocker goes, the column glides and then the say fades in; the cap counts only the hold, not the glide (r19 item 2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column(['a', 'b'], { x: 300, y: 300 });
      blocker('e', 3, 400, 318);
      blocker('f', 4, 150, 322);
      const before = where();
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const t0 = performance.now();
      const a = byKey('a');
      // Held 540 ms (32 frames), nothing moving.
      for (let i = 0; i < 32; i += 1) {
        frame();
        expect(where()).toEqual(before);
      }
      expect(a.dataset.sayWait).toBe('true');
      send(event({ ...session('e', 3), target: { nodeId: 'n2' } }));
      let prev = where();
      let gliding = 0;
      let shownAt = -1;
      for (let i = 0; i < 120 && shownAt < 0; i += 1) {
        frame();
        const w = where();
        expect(Math.abs(w.b.y - prev.b.y)).toBeLessThan(4);
        expect(w.b.y - w.a.y).toBeGreaterThanOrEqual(S - 1e-6);
        if (w.b.y !== prev.b.y) gliding += 1;
        expect(a.dataset.sayWait).not.toBe('log');
        if (painted(a)) {
          shownAt = i;
          expect(w.b.y - w.a.y).toBeGreaterThanOrEqual(stackStepPx(true) - 0.01);
          expect(performance.now() - t0).toBeGreaterThan(600);
        }
        prev = w;
      }
      // The glide ran past the 600 ms since the say came, and still it shows.
      expect(gliding).toBeGreaterThan(3);
      expect(shownAt).toBeGreaterThan(4);
      expect(a.dataset.saySide).toBeUndefined();
      expect(anyMeet()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });


  // GM r19: the Agent log names each say by the cursor's own label, the
  // string its pill shows, from one helper.
  it('the Agent log names each line as its cursor\'s pill does ("Claude · 3"), for every cursor in a column (r19)', () => {
    render(<AgentCursorLayer />);
    const sent = (['a', 'b', 'c', 'd'] as const).map((k, i) => {
      const e = event({ ...session(k, i + 1), target: { nodeId: 'n1' }, say: `Step ${k}` });
      send(e);
      flush();
      return [k, e] as const;
    });
    for (const [k, e] of sent) {
      const pill = byKey(k).querySelector('.agent-cursor__name')!.textContent;
      const logged = agentActionEntry(e)!.agent!.name;
      // The count cursor's pill shows "2 more"; its own label is what the
      // cursor's other members are listed by.
      const own = byKey(k).dataset.count ? 'Claude · 3' : pill;
      expect(logged).toBe(own);
    }
    expect(sent.map(([, e]) => agentActionEntry(e)!.agent!.name)).toEqual(['Claude', 'Claude · 2', 'Claude · 3', 'Claude · 4']);
    // The folded member's list name, too.
    expect([...byKey('c').querySelectorAll('.agent-cursor__list-name')].map((n) => n.textContent)).toEqual(['Claude · 3', 'Claude · 4']);
    // No session, or a malformed one: the bare name, as the cursor shows it.
    expect(agentActionEntry(event({ say: 'x' }))!.agent!.name).toBe('Claude');
    expect(agentActionEntry(event({ say: 'x', session: { key: 'not-hex', ordinal: 3 } as never }))!.agent!.name).toBe('Claude');
  });

  // GM r19 check: the full cursors are the column's earliest arrivals,
  // whatever numbers their sessions carry.
  it('the two full cursors are the earliest arrivals, whatever their numbers; the latest fold (r19 check)', () => {
    render(<AgentCursorLayer />);
    // Arrival order a (·6), b (·3), c (·5), d (·4): numbers out of order.
    for (const [k, ordinal] of [['a', 6], ['b', 3], ['c', 5], ['d', 4]] as const) {
      send(event({ ...session(k, ordinal), target: { nodeId: 'n1' } }));
      flush();
    }
    const full = drawn().filter((el) => !el.dataset.count).map((el) => el.dataset.session!.slice(0, 1));
    expect(full.sort()).toEqual(['a', 'b']);
    expect(byKey('c').dataset.count).toBe('2');
    expect(byKey('d').dataset.collapsed).toBe('true');
    expect(where().a.y).toBeLessThan(where().b.y);
    expect([...byKey('c').querySelectorAll('.agent-cursor__list-name')].map((n) => n.textContent)).toEqual(['Claude · 5', 'Claude · 4']);
  });


  it('a say whose room is taken again mid-glide holds again: it never shows over the blocker, gives its room back, and goes to the log (r19 item 2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column(['a', 'b'], { nodeId: 'n1' });
      const a0 = where().a;
      // Another column already in the way on the left.
      blocker('f', 4, a0.x - 150, a0.y + 22);
      // e rests on n2, out of the way.
      send(event({ ...session('e', 3), target: { nodeId: 'n2' } }));
      flush();
      send(event({ ...session('a', 1), target: { nodeId: 'n1' }, say: 'Checking the prompt' }));
      frame();
      frame();
      const a = byKey('a');
      expect(a.dataset.sayWait).toBe('true');
      // b has begun gliding down for the say.
      expect(where().b.y - where().a.y).toBeGreaterThan(S);
      // n2 is carried so e lands in the say's room on the right.
      const move = (dx: number, dy: number) => {
        const next = new Map(lookupRef.current) as Map<string, Entry>;
        const node = next.get('n2')!;
        next.set('n2', { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: {
          x: node.internals.positionAbsolute.x + dx, y: node.internals.positionAbsolute.y + dy } } } as Entry);
        lookupRef.current = next as never;
        notifyStore();
      };
      for (let i = 0; i < 4; i += 1) {
        move(-(1000 - (a0.x + 100)) / 4, 18 / 4);
        frame();
      }
      for (let i = 0; i < 90; i += 1) {
        frame();
        expect(painted(a)).toBe(false);
      }
      expect(a.dataset.sayWait).toBe('log');
      expect(where().b.y - where().a.y).toBeCloseTo(S, 6);
    } finally {
      vi.useRealTimers();
    }
  });


  // Review 8 / GM r21: a merge lays the joined column out in arrival
  // order; a cursor that changes slot glides there, nothing jumps.
  it('P3 live: in the merge the later cursor aimed higher stays on top, the earlier one on its own target, the count glides under it, nothing jumps (r21, r24 Q1)', () => {
    render(<AgentCursorLayer />);
    blocker('a', 1, 300, 386);
    blocker('b', 2, 300, 300);
    blocker('c', 3, 300, 300);
    expect(where()).toMatchObject({ a: { x: 300, y: 386 }, b: { x: 300, y: 300 }, c: { x: 300, y: 300 + S } });
    send(event({ ...session('d', 4), target: { x: 300, y: 300 } }));
    const path: Record<string, { x: number; y: number }>[] = [];
    for (let i = 0; i < 150; i += 1) {
      tickFrames(1);
      path.push(where());
    }
    flush();
    // a and b are the two earliest, drawn in full: b aims 86 px higher, so
    // it goes in above a and stays on its target; a stays on its own; c is
    // the count, one step under a.
    expect(where()).toMatchObject({ b: { x: 300, y: 300 }, a: { x: 300, y: 386 }, c: { x: 300, y: 386 + S } });
    expect(byKey('c').dataset.count).toBe('2');
    expect(byKey('d').dataset.collapsed).toBe('true');
    // An 86 px glide on the land spring stays well under 20 px a frame; a
    // jump is 86 px in one frame and a step that changes far faster than the
    // spring accelerates.
    const step = (k: string, i: number) => path[i][k].y - path[i - 1][k].y;
    for (let i = 1; i < path.length; i += 1) {
      for (const k of ['a', 'b', 'c']) {
        expect(Math.abs(step(k, i))).toBeLessThan(20);
        if (i > 1) expect(Math.abs(step(k, i) - step(k, i - 1))).toBeLessThan(8);
      }
      expect(path[i].a.y).toBe(386);
      expect(path[i].b.y).toBe(300);
    }
    // c glides the 86 px down over many frames.
    expect(path.filter((w) => w.c.y > 300 + S + 1 && w.c.y < 386 + S - 1).length).toBeGreaterThan(8);
  });

  // GM r21 Q2: "earliest" is the backend's arrival order, so a reload (a
  // replay, oldest last event first) draws the same two in full.
  it('after a reload the same two cursors are drawn in full: the backend\'s arrival order, not who spoke last (r21)', () => {
    const arrive = (k: string, o: number, since: number, extra: Partial<AgentPresenceEvent> = {}) =>
      event({ ...session(k, o), target: { nodeId: 'n1' }, since, ...extra });
    const first = render(<AgentCursorLayer />);
    for (const [k, o] of [['a', 1], ['b', 2], ['c', 3], ['d', 4]] as const) {
      send(arrive(k, o, 1000 * o));
      flush();
    }
    // The head goes on speaking; its arrival doesn't change.
    send(arrive('a', 1, 1000, { say: 'Head still talking' }));
    flush();
    const shape = () => cursors().filter((el) => el.dataset.leaving !== 'true').map((el) => [el.dataset.session!.slice(0, 1), el.dataset.count ?? (el.dataset.collapsed ? 'folded' : 'full')]).sort();
    const live = shape();
    expect(live).toEqual([['a', 'full'], ['b', 'full'], ['c', '2'], ['d', 'folded']]);
    first.unmount();
    act(() => { useAgentPresenceStore.getState().clear(); });
    // A fresh tab: the replay comes oldest last event first, so the head,
    // which spoke last, comes last; its arrival is still the earliest.
    render(<AgentCursorLayer />);
    const replayed = (k: string, o: number, ago: number, extra: Partial<AgentPresenceEvent> = {}) =>
      ({ ...arrive(k, o, 1000 * o, extra), replay: true, secondsAgo: ago });
    act(() => {
      useAgentPresenceStore.getState().replay([replayed('b', 2, 8), replayed('c', 3, 7), replayed('d', 4, 6), replayed('a', 1, 0.5, { say: 'Head still talking' })] as never);
    });
    flush();
    expect(shape()).toEqual(live);
    expect(where().a.y).toBeLessThan(where().b.y);
    expect(painted(byKey('a'))).toBe(true);
  });

  // Review 8, MEDIUM-2: the count cursor's own member leaves. It exits as
  // the count ("3 more", grey), and the new count waits unseen until it is
  // gone: never more than three shown.
  it('five in a column, the count cursor\'s member leaves: it exits as "3 more", the full cursors stay at full opacity, the new count waits, at most 3 shown on every frame (review 8, GM r22)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b', 'c', 'd', 'e']);
    const c = byKey('c');
    expect(c.dataset.count).toBe('3');
    act(() => {
      const st = useAgentPresenceStore;
      const agents = { ...st.getState().agents };
      for (const k of Object.keys(agents)) if (agents[k].session?.key === 'c'.repeat(12)) delete agents[k];
      st.setState({ agents });
    });
    let exitFrames = 0;
    for (let i = 0; i < 120; i += 1) {
      tickFrames(1);
      const shown = cursors().filter((el) => Number(el.style.opacity) > 0.05);
      expect(shown.length).toBeLessThanOrEqual(3);
      // Only the count's member leaves: the full cursors stay at full
      // opacity on every frame of its exit (GM r22, 3a).
      expect(Number(byKey('a').style.opacity)).toBe(1);
      expect(Number(byKey('b').style.opacity)).toBe(1);
      const leaving = cursors().find((el) => el.dataset.session === 'c'.repeat(12));
      if (leaving && Number(leaving.style.opacity) > 0.05) {
        exitFrames += 1;
        // Still the count: its pill, its grey, its number.
        expect(leaving.dataset.count).toBe('3');
        expect(leaving.querySelector('.agent-cursor__name')!.textContent).toBe('3 more');
        expect(leaving.style.getPropertyValue('--agent-color')).toBe('#52525b');
      }
    }
    flush();
    expect(exitFrames).toBeGreaterThan(2);
    const d = byKey('d');
    expect(d.dataset.count).toBe('2');
    expect(d.querySelector('.agent-cursor__name')!.textContent).toBe('2 more');
    expect(Number(d.style.opacity)).toBe(1);
    expect(byKey('e').dataset.collapsed).toBe('true');
    expect(cursors().find((el) => el.dataset.session === 'c'.repeat(12))).toBeUndefined();
  });

  // Review 8, LOW-2 V2 (r18): the count cursor never draws a say of its own.
  // Review 8, V32: a cursor flying through the say's room makes the say
  // wait for it (it passes), not move aside as for a column at rest there.
  it('a flyer in the say\'s room makes it wait through its arrow and its name pill, then it shows on its own side; never moved left for a flyer (review 8 V32, GM r22)', () => {
    render(<AgentCursorLayer />);
    blocker('a', 1, 300, 300);
    blocker('e', 2, 400, 318);
    // e takes off along the say's row, out of its way; a speaks as it goes.
    send(event({ ...session('e', 2), target: { x: 470, y: 318 } }));
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    tickFrames(1);
    const a = byKey('a');
    expect(a.dataset.sayWait).toBe('true');
    // The flyer's whole drawn block counts, arrow and name pill (GM r22):
    // the say waits while the pill passes too, so no frame draws a say
    // over it, and then shows on its own side.
    let waited = 0;
    for (let i = 0; i < 40; i += 1) {
      tickFrames(1);
      expect(a.dataset.saySide).toBeUndefined();
      expect(anyMeet()).toBe(false);
      if (!painted(a)) waited += 1;
    }
    // In 4i the say showed on the next frame, over the passing name pill.
    expect(waited).toBeGreaterThan(3);
    expect(painted(a)).toBe(true);
  });

  // Review 8, V5 and V6: another column on the right, and the cursor
  // below still a say step short (it waits on both sides). The say never
  // shows on the left until the one below has glided clear; capped at
  // once (reduced motion), it takes the left, never the right over the
  // other column.
  it('right side taken, the cursor below still gliding: the left say waits for the glide (review 8 V5)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b'], { x: 300, y: 300 });
    blocker('e', 3, 400, 318);
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    const a = byKey('a');
    let shownAt = -1;
    for (let i = 0; i < 90; i += 1) {
      tickFrames(1);
      const w = where();
      if (painted(a)) {
        if (shownAt < 0) shownAt = i;
        expect(a.dataset.saySide).toBe('left');
        expect(w.b.y - w.a.y).toBeGreaterThanOrEqual(SS - 0.01);
      }
      expect(anyMeet()).toBe(false);
    }
    expect(shownAt).toBeGreaterThan(4);
  });

  it('right side taken, capped at once (reduced motion): the say takes the left, never the right over the other column (review 8 V6)', () => {
    reduceMotion(true);
    render(<AgentCursorLayer />);
    column(['a', 'b'], { x: 300, y: 300 });
    blocker('e', 3, 400, 318);
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
    tickFrames(1);
    const a = byKey('a');
    expect(painted(a)).toBe(true);
    expect(a.dataset.saySide).toBe('left');
    tickFrames(2);
    expect(a.dataset.saySide).toBe('left');
    expect(anyMeet()).toBe(false);
  });

  // Review 8, V9: blocked again after a wait began, the say holds afresh:
  // its 600 ms cap counts from the new hold, not from the first wait.
  it('a say blocked again after its wait began holds a full 600 ms before the log (review 8 V9)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      column(['a', 'b'], { x: 300, y: 300 });
      blocker('e', 3, 400, 318);
      blocker('f', 4, 150, 322);
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const a = byKey('a');
      for (let i = 0; i < 32; i += 1) frame();
      expect(a.dataset.sayWait).toBe('true');
      // e goes: the wait begins (the column glides) ...
      send(event({ ...session('e', 3), target: { nodeId: 'n2' } }));
      for (let i = 0; i < 3; i += 1) frame();
      // ... and a third column comes to rest in the way on the right again.
      blocker('g', 5, 400, 318);
      const reblocked = performance.now();
      let loggedAt = -1;
      for (let i = 0; i < 90 && loggedAt < 0; i += 1) {
        frame();
        expect(painted(a)).toBe(false);
        if (a.dataset.sayWait === 'log') loggedAt = performance.now() - reblocked;
      }
      expect(loggedAt).toBeGreaterThan(600);
      expect(loggedAt).toBeLessThan(700);
    } finally {
      vi.useRealTimers();
    }
  });

  // Live r4i: after a reload the graph measures its nodes after the replay.
  // A cursor on a node moves from the node's corner into its header then;
  // that is no carry, so it keeps the backend's arrival and heads the column.
  it('a node measured after the replay keeps its cursor\'s backend arrival: no carry, it heads the column (live r4i)', () => {
    const unmeasured = new Map(lookupRef.current) as Map<string, Entry & { measured?: unknown }>;
    const n1 = unmeasured.get('n1')!;
    unmeasured.set('n1', { ...n1, measured: undefined });
    lookupRef.current = unmeasured as never;
    render(<AgentCursorLayer />);
    send(event({ ...session('d', 1), agent: { id: 'pair', name: 'Pair', color: '#FF9F43', verified: true }, target: { nodeId: 'n1' }, since: 1000 }));
    send(event({ ...session('a', 1), target: { x: 500, y: 344 }, since: 2000 }));
    send(event({ ...session('b', 2), target: { x: 500, y: 344 }, since: 3000 }));
    flush();
    expect(where().d).toEqual({ x: 400, y: 300 });
    lookupRef.current = new Map(lookupRef.current).set('n1', n1) as never;
    notifyStore();
    flush();
    expect(where()).toEqual({ d: { x: 500, y: 344 }, a: { x: 500, y: 344 + S }, b: { x: 500, y: 344 + 2 * S } });
  });

  // #211 follow-up (review 9, LOW-3; GM r23 item 2): the backend's new
  // arrival for a cursor a node move carried (agentPresenceArrival) moves
  // it in the column, in every tab alike, with a glide.
  it('a new backend arrival with no event moves the cursor to its place in the column, gliding (r23 item 2, the rank-change branch)', () => {
    render(<AgentCursorLayer />);
    for (const [k, o] of [['a', 1], ['b', 2], ['c', 3]] as const) {
      send(event({ ...session(k, o), target: { x: 300, y: 300 }, since: 1000 * o }));
      flush();
    }
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S }, c: { x: 300, y: 300 + 2 * S } });
    act(() => { useAgentPresenceStore.getState().arrive([{ agentId: 'claude', key: 'a'.repeat(12), ordinal: 1, since: 4000 }]); });
    const seq = byKey('a').dataset;
    let prev = where();
    let maxStep = 0;
    for (let i = 0; i < 150; i += 1) {
      tickFrames(1);
      const w = where();
      for (const k of ['a', 'b', 'c']) maxStep = Math.max(maxStep, Math.abs(w[k].y - prev[k].y));
      prev = w;
    }
    flush();
    // b heads now, c under it, a last: it arrived now.
    expect(where()).toEqual({ b: { x: 300, y: 300 }, c: { x: 300, y: 300 + S }, a: { x: 300, y: 300 + 2 * S } });
    expect(maxStep).toBeLessThan(20);
    expect(byKey('a').dataset).toBe(seq);
    // The same arrival again changes nothing.
    act(() => { useAgentPresenceStore.getState().arrive([{ agentId: 'claude', key: 'a'.repeat(12), ordinal: 1, since: 4000 }]); });
    flush();
    expect(where().a).toEqual({ x: 300, y: 300 + 2 * S });
  });

  // The node is dragged, then dropped: the carried cursor lands on the
  // column and comes after its members, though it arrived first and its key
  // sorts first (so neither its old arrival nor a tie puts it ahead).
  const dragNode = (id: string, to: { x: number; y: number }, steps = 10) => {
    const node = lookupRef.current.get(id) as Entry;
    const from = node.internals.positionAbsolute;
    for (let i = 1; i <= steps; i += 1) {
      const next = new Map(lookupRef.current) as Map<string, Entry>;
      next.set(id, { ...node, dragging: i < steps, internals: { ...node.internals, positionAbsolute: {
        x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps } } });
      lookupRef.current = next as never;
      notifyStore();
      tickFrames(1);
    }
  };

  // GM r47 Q1: while a node is dragged, the tab previews a carry the
  // backend will count (the target chain changes): the carried cursor is
  // drawn last in the column it passes. Display only; the backend's arrival
  // governs at the drop.
  const dragHeld = (id: string, to: { x: number; y: number }, steps = 10) => {
    const node = lookupRef.current.get(id) as Entry;
    const from = node.internals.positionAbsolute;
    for (let i = 1; i <= steps; i += 1) {
      const next = new Map(lookupRef.current) as Map<string, Entry>;
      next.set(id, { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: {
        x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps } } });
      lookupRef.current = next as never;
      notifyStore();
      frame();
    }
  };
  const drop = (id: string) => {
    const next = new Map(lookupRef.current) as Map<string, Entry>;
    next.set(id, { ...(next.get(id) as Entry), dragging: false });
    lookupRef.current = next as never;
    notifyStore();
    frame();
  };
  const settle = (ms: number) => { for (let t = 0; t < ms; t += 1000 / 60) frame(); };
  const intoColumn = (carried: [string, number][] = [['a', 500]]) => {
    for (const [k, since] of carried) {
      send(event({ ...session(k, k === 'a' ? 3 : 4), target: { nodeId: 'n2' }, since }));
      flush();
    }
    for (const [k, o] of [['d', 1], ['e', 2]] as const) {
      send(event({ ...session(k, o), target: { x: 500, y: 344 }, since: 1000 * o }));
      flush();
    }
  };
  const arrive = (k: string, ordinal: number, since: number) => act(() => {
    useAgentPresenceStore.getState().arrive([{ agentId: 'claude', key: k.repeat(12), ordinal, since }]);
  });

  it('a drag into a column draws the carry last while it passes, and nothing moves at the drop when the backend agrees (r47 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      expect(where()).toEqual({ a: { x: 1000, y: 344 }, d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S } });
      dragHeld('n2', { x: 400, y: 300 });
      // Held still over the column, longer than the preview's hold: the
      // drag keeps it.
      settle(CARRY_PREVIEW_HOLD_MS + 1000);
      // Mid-drag: a arrived first (500), but its chain changed, so it is
      // drawn last; the column's members never move for it.
      const last = { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } };
      expect(where()).toEqual(last);
      // The drop, then the backend's arrival a moment later: nothing moves.
      drop('n2');
      for (let i = 0; i < 6; i += 1) { frame(); expect(where()).toEqual(last); }
      arrive('a', 3, 9000);
      for (let i = 0; i < 150; i += 1) { frame(); expect(where()).toEqual(last); }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a drag back out of the column puts the carried cursor back in its old slot (r47 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(800);
      expect(where().a).toEqual({ x: 500, y: 344 + 2 * S });
      dragHeld('n2', { x: 900, y: 300 });
      settle(800);
      const home = { a: { x: 1000, y: 344 }, d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S } };
      expect(where()).toEqual(home);
      // Dropped where it started: no arrival comes, and nothing moves.
      drop('n2');
      settle(2500);
      expect(where()).toEqual(home);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a backend that disagrees at the drop wins: the carried cursor glides back to its place on the layout spring (r47 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(800);
      drop('n2');
      // No arrival comes (forced: the backend counted no carry).
      settle(CARRY_PREVIEW_HOLD_MS - 200);
      expect(where().a).toEqual({ x: 500, y: 344 + 2 * S });
      const path: number[] = [];
      for (let i = 0; i < 200; i += 1) { frame(); path.push(where().a.y); }
      // a is the earliest arrival again: it heads the column, d and e under it.
      expect(where()).toEqual({ a: { x: 500, y: 344 }, d: { x: 500, y: 344 + S }, e: { x: 500, y: 344 + 2 * S } });
      // A glide, not a jump: many frames between, none over 20 px.
      expect(path.filter((y) => y > 345 && y < 344 + 2 * S - 1).length).toBeGreaterThan(8);
      for (let i = 1; i < path.length; i += 1) expect(Math.abs(path[i] - path[i - 1])).toBeLessThan(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two cursors on one dragged node keep their order between themselves in the preview and after (rule 101, r47 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      // b arrived first, a second: their keys sort the other way, so only
      // their arrivals keep this order.
      send(event({ ...session('b', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('a', 4), target: { nodeId: 'n2' }, since: 600 }));
      flush();
      send(event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000 }));
      flush();
      expect(where()).toEqual({ b: { x: 1000, y: 344 }, a: { x: 1000, y: 344 + S }, d: { x: 500, y: 344 } });
      dragHeld('n2', { x: 400, y: 300 });
      settle(800);
      const order = { d: { x: 500, y: 344 }, b: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } };
      expect(where()).toEqual(order);
      drop('n2');
      arrive('b', 3, 9000);
      arrive('a', 4, 9001);
      for (let i = 0; i < 120; i += 1) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r52 Q1, as r62 rules it: on the way in, a's arrow meets d's label
  // while their targets are still over 16 apart (a's target 304 to 327,
  // d's 344): the column joins by overlap alone. During the drag the carry
  // takes the slot the r24 insert gives it as the newest arrival there too,
  // the same rule as in chain range, so its slot only ever moves one way.
  const dragFrames = (id: string, path: { x: number; y: number }[], each: () => void) => {
    const node = lookupRef.current.get(id) as Entry;
    for (const p of path) {
      const next = new Map(lookupRef.current) as Map<string, Entry>;
      next.set(id, { ...node, dragging: true, internals: { ...node.internals, positionAbsolute: p } });
      lookupRef.current = next as never;
      notifyStore();
      frame();
      each();
    }
  };
  /** How many of `others` are drawn above `k`: its slot in their column. */
  const slotOf = (k: string, others: string[]) => {
    const w = where();
    return others.filter((o) => w[o].y < w[k].y - 1e-9).length;
  };
  /** n2 drawn somewhere else from the start (before any cursor reports). */
  const n2At = (p: { x: number; y: number }, extra: Record<string, unknown> = {}) => {
    const n2 = lookup.get('n2') as unknown as Entry;
    lookupRef.current = new Map(lookup).set('n2', { ...n2, ...extra, internals: { ...n2.internals, positionAbsolute: p } } as never) as never;
  };

  // Review 2's trace (pr219r2-repro.txt): d aimed at 344, e at 384 (more
  // than 16 below), a carried straight down through both. Before r62, a went
  // to the bottom in the band (430.7), up past e in d's chain (397.3), and
  // down again past it (439.2). Now the band and chain range give one slot:
  // a's slot only moves down the column, at any zoom.
  it.each([1, 0.5, 2])('a straight drag through the band and two chains at zoom %s: the carry\'s slot moves one way only, with no flip (r62)', (z) => {
    fakeTimers();
    try {
      pane.transform = [0, 0, z];
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000 }));
      flush();
      send(event({ ...session('e', 2), target: { x: 500, y: 384 }, since: 2000 }));
      flush();
      // Above the column, clear of it (a's target 344 - 160 / zoom).
      const start = 344 - 160 / z;
      dragHeld('n2', { x: 400, y: start - 44 });
      settle(800);
      expect(where().a).toEqual({ x: 500, y: start });
      expect(slotOf('a', ['d', 'e'])).toBe(0);
      // Down 2 canvas units a frame to 424, every frame checked.
      const path = Array.from({ length: Math.round((424 - start) / 2) }, (_, i) => ({ x: 400, y: start - 44 + 2 * (i + 1) }));
      const slots: number[] = [];
      dragFrames('n2', path, () => {
        const slot = slotOf('a', ['d', 'e']);
        if (slots.length > 0) expect(slot).toBeGreaterThanOrEqual(slots[slots.length - 1]);
        if (slots[slots.length - 1] !== slot) slots.push(slot);
      });
      settle(800);
      expect(slotOf('a', ['d', 'e'])).toBe(2);
      if (z !== 1) return;
      // At zoom 1, review 2's geometry: the head of the column in the band,
      // the middle slot in d's chain (e aims over 16 below a), the bottom in
      // e's: one way.
      expect(slots).toEqual([0, 1, 2]);
      const last = { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } };
      expect(where()).toEqual(last);
      // Dropped at 424, out of every chain (40 from e), as it started: the
      // backend counts no arrival, and its arrival order lays it out the
      // same way, so nothing moves through the hold.
      drop('n2');
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(last); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r65: the head-to-bottom move, in the d/e-at-344 case. a heads the
  // column in the band (327), then joins d's chain one unit on (328) and
  // goes to the bottom, past both members, as they close up under nothing.
  // One glide on the layout spring for all three: they start on the same
  // frame, keep pace (no member reaches its slot ahead of the others) and
  // settle on the same frame. Under reduced motion it is one frame.
  const headToBottom = () => {
    intoColumn();
    dragHeld('n2', { x: 400, y: 283 }); // a's target at 327: the band
    settle(800);
    expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
    const before = where();
    dragFrames('n2', [{ x: 400, y: 284 }], () => {}); // 328: in d's chain
    return before;
  };
  it('the head-to-bottom move is one glide for the carry and both members: same first frame, same pace, same last frame (r65)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      const from = headToBottom();
      const to = { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } };
      const ys = [where()];
      for (let i = 0; i < 120; i += 1) { frame(); ys.push(where()); }
      expect(where()).toEqual(to);
      const keys = ['a', 'd', 'e'] as const;
      // Progress along its own move, 0 at the start, 1 on its slot.
      const progress = (k: typeof keys[number], w: Record<string, { y: number }>) => (w[k].y - from[k].y) / (to[k].y - from[k].y);
      const first = (k: typeof keys[number]) => ys.findIndex((w) => Math.abs(w[k].y - from[k].y) > 1e-6);
      const settled = (k: typeof keys[number]) => ys.findIndex((w, i) => ys.slice(i).every((v) => v[k].y === to[k].y));
      expect(new Set(keys.map(first)).size).toBe(1);
      expect(first('a')).toBeLessThanOrEqual(1);
      expect(new Set(keys.map(settled)).size).toBe(1);
      // A glide, not a jump: many frames between, and each lands from
      // within the rest distance (0.2 px), not pulled onto its slot early.
      expect(settled('a') - first('a')).toBeGreaterThan(8);
      for (const k of keys) expect(Math.abs(ys[settled(k) - 1][k].y - to[k].y)).toBeLessThan(0.2);
      for (const w of ys) {
        const p = keys.map((k) => progress(k, w));
        // Same pace: nobody ahead of the others by more than a pixel's worth.
        expect(Math.max(...p) - Math.min(...p)).toBeLessThan(1 / 25 + 1e-9);
        // Nobody on its slot while another is still off its own.
        const on = keys.map((k) => w[k].y === to[k].y);
        expect(on.every(Boolean) || !on.some(Boolean)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('under reduced motion the head-to-bottom move is instant: one frame, all three (r65)', () => {
    fakeTimers();
    try {
      reduceMotion(true);
      render(<AgentCursorLayer />);
      headToBottom();
      expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } });
      for (let i = 0; i < 30; i += 1) { frame(); expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } }); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r66, bound 1: the rest gate changes only when cursors count as at
  // rest. A held cursor keeps drawing its spring position (it isn't snapped
  // or frozen), and what shows when it comes to rest doesn't wait for the
  // column: a still pointer over d's slot hovers d on d's own rest, not when
  // the column lands. (Audit: hover is the one visible thing keyed to rest;
  // see the round 3e notes.)
  it('a cursor held by the column draws its spring position, and a still pointer hovers it on its own rest, not the column\'s (r66)', () => {
    fakeTimers();
    pane.dom = document.createElement('div');
    document.body.appendChild(pane.dom);
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === pane.dom) return new DOMRect(0, 0, 1440, 900);
      const cursor = this.closest<HTMLElement>('.agent-cursor');
      const p = cursor ? at(cursor) : { x: -999, y: -999 };
      if (this.classList.contains('agent-cursor__pointer')) return new DOMRect(p.x, p.y, 20, 22);
      if (this.classList.contains('agent-cursor__name')) return new DOMRect(p.x + 15, p.y + 17, 60, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    try {
      render(<AgentCursorLayer />);
      act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 505, clientY: 350 })); });
      headToBottom();
      const d = byKey('d');
      expect(d.dataset.hover).toBeUndefined();
      const frames: { y: number; hover: boolean; flying: boolean; landed: boolean }[] = [];
      for (let i = 0; i < 90; i += 1) {
        frame();
        const w = where();
        frames.push({ y: w.d.y, hover: d.dataset.hover === 'true', flying: d.style.willChange !== 'auto',
          landed: w.a.y === 344 + 2 * S && w.d.y === 344 && w.e.y === 344 + S });
      }
      // Its own rest, as the land spring counts it: within 0.2 px of its slot
      // and slower than 2 px/s.
      const still = (i: number) => i > 0 && Math.abs(frames[i].y - 344) < 0.2 && Math.abs(frames[i].y - frames[i - 1].y) * 60 < 2;
      const ownRest = frames.findIndex((f, i) => still(i));
      const hovered = frames.findIndex((f) => f.hover);
      const landed = frames.findIndex((f) => f.landed);
      // The column holds d past its own rest (the gate is on).
      expect(landed - ownRest).toBeGreaterThan(3);
      // Hovered on d's own rest, before the column lands.
      expect(hovered).toBeGreaterThanOrEqual(0);
      expect(hovered).toBeLessThanOrEqual(ownRest + 1);
      expect(hovered).toBeLessThan(landed);
      // Held: still on the spring, drawn where it is, not snapped or frozen.
      const held = frames.slice(ownRest + 1, landed);
      expect(held.every((f) => f.flying && f.y !== 344)).toBe(true);
      expect(new Set(held.map((f) => f.y)).size).toBeGreaterThan(2);
      // And it lands with no visible snap.
      expect(Math.abs(frames[landed - 1].y - 344)).toBeLessThan(0.2);
    } finally {
      rects.mockRestore();
      pane.dom.remove();
      vi.useRealTimers();
    }
  });

  // GM r66, bound 2: the hold is capped. A drag that keeps retargeting the
  // carry keeps its glide from settling (its spot is the column's bottom,
  // while its node, the spring's carrier, keeps moving), which would hold d
  // and e off their rest for as long as the person drags. For 2 s of wobble
  // inside d's chain, no member waits more than AGENT_CURSOR_REST_HOLD_MAX_MS
  // past its own rest: it lands on its own.
  it('a 2 s wobble drag that keeps the carry gliding holds no member past the 300 ms cap (r66)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      const capFrames = Math.ceil(AGENT_CURSOR_REST_HOLD_MAX_MS / (1000 / 60)) + 2;
      const slot = { d: 344, e: 344 + S };
      const held = { d: 0, e: 0 };
      const worst = { d: 0, e: 0 };
      const landedOnOwn = { d: false, e: false };
      // 2 s: n2 swings a's target from 328 to 340 and back, a unit a frame.
      const path = Array.from({ length: 120 }, (_, i) => {
        const k = i % 24;
        return { x: 400, y: 284 + (k < 12 ? k : 24 - k) };
      });
      let prev = where();
      dragFrames('n2', path, () => {
        const w = where();
        for (const k of ['d', 'e'] as const) {
          const el = byKey(k);
          const y = w[k].y;
          // Held: at rest as the land spring counts it (within 0.2 px of its
          // slot, slower than 2 px/s), still on the spring.
          if (el.style.willChange !== 'auto' && Math.abs(y - slot[k]) < 0.2 && Math.abs(y - prev[k].y) * 60 < 2) held[k] += 1;
          else held[k] = 0;
          if (el.style.willChange === 'auto' && y === slot[k]) landedOnOwn[k] = true;
          worst[k] = Math.max(worst[k], held[k]);
        }
        prev = w;
      });
      expect(AGENT_CURSOR_REST_HOLD_MAX_MS).toBe(300); // GM r66
      for (const k of ['d', 'e'] as const) {
        expect(worst[k], k).toBeLessThanOrEqual(capFrames);
        // The cap is what ended the hold: it ran close to the full 300 ms.
        expect(worst[k], k).toBeGreaterThanOrEqual(capFrames - 4);
        expect(landedOnOwn[k], k).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 3's probe (GM r75.1 and r75.2), kept as a test: r65's
  // head-to-bottom move, then k plain frames, then the hand crosses back
  // one unit (a's target 328 -> 327: the head again). Every k from 0 to 49
  // crosses on some frame of the glide: k = 0 to 2 are r75.2's wobble back
  // mid-glide (the column floor's push), the gate frame (about k = 30) and
  // the frames the 300 ms cap fires on are r75.1's. No frame moves any
  // cursor more than its spring step: the largest one-frame step the land
  // spring takes in the clean head-to-bottom glide, for a (101 px) and for d
  // and e (25 px), with 2% for a glide that reverses (a back from past its
  // slot goes a little further than 101 px).
  const springSteps = () => {
    fakeTimers();
    try {
      const view = render(<AgentCursorLayer />);
      headToBottom();
      const out: Record<string, number> = { a: 0, d: 0, e: 0 };
      let prev = where();
      for (let i = 0; i < 120; i += 1) {
        frame();
        const w = where();
        for (const k of ['a', 'd', 'e']) out[k] = Math.max(out[k], Math.abs(w[k].y - prev[k].y));
        prev = w;
      }
      view.unmount();
      return out;
    } finally {
      // The run leaves no trace for the test that reads it.
      useAgentPresenceStore.getState().clear();
      lookupRef.current = lookup;
      frames = [];
      frameIds = [];
      vi.useRealTimers();
    }
  };
  // GM r65: wobbling across the 16 boundary follows the hand, with no
  // hysteresis. a's target goes back and forth over 328 (16 from d), with
  // steps that stay on one side in between. Each crossing is exactly one
  // move (one unbroken run of frames for the members); a step that crosses
  // nothing moves no member; and once a move settles, nothing moves.
  it('a wobble across the 16 boundary: each crossing is one move, nothing moves between crossings, no hysteresis (r65), and a wobble back 1 to 3 frames on moves nothing past its spring step (r75.2)', () => {
    const spring = springSteps();
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 283 });
      settle(800);
      const steps = [329, 327, 329, 331, 329, 327, 325, 327, 329, 327, 328, 327];
      let aT = 327;
      for (const next of steps) {
        const crosses = (aT >= 328) !== (next >= 328);
        dragFrames('n2', [{ x: 400, y: next - 44 }], () => {});
        const ys = [where()];
        for (let i = 0; i < 90; i += 1) { frame(); ys.push(where()); }
        // Runs of frames in which a member moved.
        let runs = 0;
        let moving = false;
        for (let i = 1; i < ys.length; i += 1) {
          const now = ['d', 'e'].some((k) => ys[i][k].y !== ys[i - 1][k].y);
          if (now && !moving) runs += 1;
          moving = now;
        }
        expect(runs, `${aT} -> ${next}`).toBe(crosses ? 1 : 0);
        // Settled by the end: the last 20 frames still.
        for (let i = ys.length - 20; i < ys.length; i += 1) expect(ys[i]).toEqual(ys[ys.length - 1]);
        // Where the hand is says where a is: the bottom in d's chain, else the head.
        const w = ys[ys.length - 1];
        expect(w, `${aT} -> ${next}`).toEqual(next >= 328
          ? { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } }
          : { a: { x: 500, y: next }, d: { x: 500, y: next + S }, e: { x: 500, y: next + 2 * S } });
        aT = next;
      }
      // The hand back across the boundary 1, 2 and 3 frames after a
      // crossing, both ways (GM r75.2): no frame moves a cursor more than
      // its spring step, and each pair ends where the hand is.
      for (const back of [1, 2, 3]) {
        for (const [there, home] of [[328, 327], [327, 328]]) {
          let prev = where();
          const rec = () => {
            const w = where();
            for (const k of ['a', 'd', 'e']) expect(Math.abs(w[k].y - prev[k].y), `${k}: ${home} -> ${there} -> ${home} in ${back}`).toBeLessThanOrEqual(spring[k] * 1.02);
            prev = w;
          };
          dragFrames('n2', [{ x: 400, y: there - 44 }], rec);
          for (let i = 1; i < back; i += 1) { frame(); rec(); }
          dragFrames('n2', [{ x: 400, y: home - 44 }], rec);
          for (let i = 0; i < 90; i += 1) { frame(); rec(); }
          expect(where()).toEqual(home >= 328
            ? { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } }
            : { a: { x: 500, y: home }, d: { x: 500, y: home + S }, e: { x: 500, y: home + 2 * S } });
          // Back on its slot: no member is drawn under the others any more.
          expect(cursors().filter((el) => el.dataset.crossing === 'true')).toEqual([]);
          // The next pair starts from the other side.
          dragFrames('n2', [{ x: 400, y: there - 44 }], () => {});
          for (let i = 0; i < 90; i += 1) frame();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // And with each frame's callbacks in reverse order (review 4, drag LOW-1:
  // a member stepping before the one above read a stale floor; at k = 0, d
  // and e moved 8.59 px in one frame).
  it.each(Array.from({ length: 50 }, (_, k) => k).flatMap((k) => [[k, false], [k, true]] as const))('the hand crosses back %s frames into the head-to-bottom glide: no frame moves a cursor more than its spring step (r75.1, r75.2; frame order reversed: %s)', (k, reversed) => {
    const bound = springSteps();
    // The clean glide's steps: a's is 101 px of spring, d's and e's 25.
    expect(bound.a).toBeGreaterThan(8);
    expect(bound.d).toBeLessThan(4);
    fakeTimers();
    reverseFrames = reversed;
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      let prev = where();
      const worst: Record<string, number> = { a: 0, d: 0, e: 0 };
      const rec = () => {
        const w = where();
        for (const key of ['a', 'd', 'e']) worst[key] = Math.max(worst[key], Math.abs(w[key].y - prev[key].y));
        prev = w;
      };
      for (let i = 0; i < k; i += 1) { frame(); rec(); }
      dragFrames('n2', [{ x: 400, y: 283 }], rec);
      for (let i = 0; i < 80; i += 1) { frame(); rec(); }
      for (const key of ['a', 'd', 'e']) expect(worst[key], `${key} at k=${k}`).toBeLessThanOrEqual(bound[key] * 1.02);
      // And it ends where the hand is: a heads the column again.
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 4, drag LOW-1 (PROBE2): in r65's head-to-bottom glide d and e
  // close up in lockstep, a step apart, and pass no one: only the carry is
  // marked crossing, whichever cursor's frame runs first. A floor read from
  // the member above before it stepped marked e crossing on every frame.
  it.each([false, true])('the head-to-bottom glide marks only the carry crossing, in either frame order (review 4, drag LOW-1; reversed: %s)', (reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 283 });
      settle(800);
      reverseFrames = reversed;
      dragFrames('n2', [{ x: 400, y: 284 }], () => {});
      let marked = 0;
      for (let i = 0; i < 60; i += 1) {
        frame();
        const w = where();
        expect(w.e.y - w.d.y, `frame ${i}`).toBeCloseTo(S, 9);
        expect(['d', 'e'].filter((k) => byKey(k).dataset.crossing === 'true'), `frame ${i}`).toEqual([]);
        if (byKey('a').dataset.crossing === 'true') marked += 1;
      }
      expect(marked).toBeGreaterThan(3);
      expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r85 NIT: two members crossing at once keep their column's order
  // between themselves, the upper on top, whatever the DOM's order. In
  // [a, d, e], d and e both marked crossing: e comes after d in the DOM (it
  // would draw on top by DOM order), but d's depth is 1 and e's 2, so d's
  // z-index (10 - depth, agentCursor.css) is over e's. Unmarked, no depth.
  it('two crossing members draw in column order, the upper on top, not in DOM order (r85 NIT)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 283 });
      settle(800);
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
      const field = fieldOf() as unknown as { crossing: Set<string>; placers: Map<string, () => void> };
      const keyOf = (k: string) => [...field.placers.keys()].find((x) => x.endsWith(k.repeat(12)))!;
      const z = (k: string) => 10 - Number(byKey(k).style.getPropertyValue('--agent-cursor-crossing-depth'));
      expect(cursors().indexOf(byKey('e'))).toBeGreaterThan(cursors().indexOf(byKey('d')));
      for (const k of ['d', 'e']) field.crossing.add(keyOf(k));
      act(() => { for (const k of ['e', 'd']) field.placers.get(keyOf(k))!(); });
      expect(byKey('d').style.getPropertyValue('--agent-cursor-crossing-depth')).toBe('1');
      expect(byKey('e').style.getPropertyValue('--agent-cursor-crossing-depth')).toBe('2');
      expect(z('d')).toBeGreaterThan(z('e'));
      // A crossing orders its whole column (r106: one band, over every
      // unmarked cursor): the head a, above both, draws over them too.
      expect(byKey('a').dataset.columnOrder).toBe('true');
      expect(zOf(byKey('a'))).toBeGreaterThan(zOf(byKey('d')));
      for (const k of ['d', 'e']) field.crossing.delete(keyOf(k));
      act(() => { for (const k of ['d', 'e']) field.placers.get(keyOf(k))!(); });
      for (const k of ['d', 'e']) {
        expect(byKey(k).dataset.crossing).toBeUndefined();
        expect(byKey(k).style.getPropertyValue('--agent-cursor-crossing-depth')).toBe('');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 4, layout LOW-1 (PROBE1): a crossing mark ends with the glide
  // however it ends. A stall or a hidden tab lands everything on a caught-up
  // frame, and a stale or replayed event snaps a cursor to its spot: neither
  // went through hold, which cleared the mark only on a frame of its own, so
  // d stayed drawn under every live cursor at rest.
  it.each(['stall', 'replay'] as const)('a crossing mark goes when the glide ends on a %s, not only on its own landing (review 4, layout LOW-1)', (how) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      frame();
      dragFrames('n2', [{ x: 400, y: 283 }], () => {});
      frame();
      frame();
      const marked = () => ['a', 'd', 'e'].filter((k) => byKey(k).dataset.crossing === 'true');
      expect(marked()).toContain('d');
      // 1 s with no frames (a hidden tab), then frames again: the others
      // land on their caught-up frame, which holds no one under them. On a
      // replay, d's event comes again meanwhile, as a reconnect gives it,
      // and snaps it to its spot.
      act(() => { vi.advanceTimersByTime(1000); });
      clock += 1000;
      if (how === 'replay') {
        act(() => { useAgentPresenceStore.getState().apply({ ...event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000 }), replay: true, secondsAgo: 0 } as never); });
      }
      tickFrames(1);
      for (let i = 0; i < 5; i += 1) frame();
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
      expect(frames.length).toBe(0);
      expect(marked()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r75.2: mid-glide, a member may sit less than a step under the one
  // above; the one above draws on top. d and e glide back under a with no
  // floor push, and every frame one of them is less than a step under the
  // member above (or passed by it), it is marked as crossing, which draws
  // it under every live cursor (agentCursor.css). Landed, the mark is gone.
  it.each([0, 1, 2].flatMap((k) => [[k, false], [k, true]] as const))('the hand back %s frames into the head-to-bottom glide: a member less than a step under the one above draws under it (r75.2; frame order reversed: %s)', (k, reversed) => {
    fakeTimers();
    reverseFrames = reversed;
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      for (let i = 0; i < k; i += 1) frame();
      let close = 0;
      const check = () => {
        const w = where();
        for (const [up, k2] of [['a', 'd'], ['d', 'e']] as const) {
          if (w[k2].y - w[up].y < S - 0.5) {
            close += 1;
            expect(byKey(k2).dataset.crossing, `${k2} under ${up} at ${w[k2].y - w[up].y}`).toBe('true');
            expect(byKey(up).dataset.crossing).toBeUndefined();
          }
        }
      };
      dragFrames('n2', [{ x: 400, y: 283 }], check);
      for (let i = 0; i < 80; i += 1) { frame(); check(); }
      expect(close).toBeGreaterThan(3);
      expect(cursors().filter((el) => el.dataset.crossing === 'true')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The cap's frame (r75.1): r66's wobble inside d's chain keeps the carry
  // gliding, so d and e are held until the 300 ms cap lands them on their
  // own. The hand crosses back to the head on frame n of the wobble, for
  // every n from 20 to 60: the frames the cap fires on are among them. No
  // frame moves d or e more than their spring step, and a no more than its
  // own plus the unit a frame the hand moves its node.
  it.each(Array.from({ length: 41 }, (_, i) => 20 + i))('the hand crosses back on frame %s of a wobble held by the cap: no frame moves a cursor more than its spring step (r75.1)', (n) => {
    const bound = springSteps();
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      let prev = where();
      const worst: Record<string, number> = { a: 0, d: 0, e: 0 };
      const rec = () => {
        const w = where();
        for (const key of ['a', 'd', 'e']) worst[key] = Math.max(worst[key], Math.abs(w[key].y - prev[key].y));
        prev = w;
      };
      const path = Array.from({ length: n }, (_, i) => {
        const k = i % 24;
        return { x: 400, y: 284 + (k < 12 ? k : 24 - k) };
      });
      dragFrames('n2', path, rec);
      dragFrames('n2', [{ x: 400, y: 283 }], rec);
      for (let i = 0; i < 80; i += 1) { frame(); rec(); }
      expect(worst.d, `d at n=${n}`).toBeLessThanOrEqual(bound.d * 1.02);
      expect(worst.e, `e at n=${n}`).toBeLessThanOrEqual(bound.e * 1.02);
      expect(worst.a, `a at n=${n}`).toBeLessThanOrEqual(bound.a * 1.02 + 1);
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Round 3b's band test, updated to r62: it encoded the literal bottom slot
  // in the band (d and e never moved). As the newest arrival, a carry from
  // above aims more than 16 over d and e, so the insert puts it at the head
  // in the band, and at the bottom once it is within 16 of them (r24 insert,
  // as the backend does at the drop). One way: it never comes back up.
  it('a drag through the overlap band into a column: the carry heads it in the band, then goes to the bottom in chain range, never back (r62, was r52 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      // Above the column, clear of it: a's target at 284.
      dragHeld('n2', { x: 400, y: 240 });
      settle(800);
      expect(where()).toEqual({ a: { x: 500, y: 284 }, d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S } });
      // Down 2 px a frame through the band (304 to 327) and into the chain
      // (328 on), every frame checked.
      const path = Array.from({ length: 30 }, (_, i) => ({ x: 400, y: 242 + 2 * i }));
      let lowest = where().a.y;
      let slot = 0;
      let headed = false;
      const check = () => {
        const w = where();
        // a only ever goes down (back up by no more than the layout
        // spring's overshoot), and its slot only down the column.
        expect(w.a.y).toBeGreaterThanOrEqual(lowest - 3);
        const now = slotOf('a', ['d', 'e']);
        expect(now).toBeGreaterThanOrEqual(slot);
        slot = now;
        lowest = Math.max(lowest, w.a.y);
        // In the band, a heads the column on its own target: d steps under it.
        if (w.d.y > 344 + 1e-9) headed = true;
        // Never above their own slots, past the spring's overshoot.
        expect(w.d.y).toBeGreaterThanOrEqual(344 - 1);
        expect(w.e.y).toBeGreaterThanOrEqual(344 + S - 1);
      };
      dragFrames('n2', path, check);
      expect(headed).toBe(true);
      for (let i = 0; i < 60; i += 1) { frame(); check(); }
      expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Round 3b's band drop test, updated to r62: the band slot is now the
  // newest arrival's, which for a carry aimed more than 16 over every member
  // is the head, its arrival-order slot too. So the drop moves nothing.
  it('a drop inside the overlap band: the backend\'s arrival order is the slot it already has, so nothing moves (r62, was r52 Q1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      // a's target at 314: 30 above d's, so its chain is unchanged, and the
      // backend sends no arrival for the drop (r24).
      dragHeld('n2', { x: 400, y: 270 });
      settle(800);
      const order = { a: { x: 500, y: 314 }, d: { x: 500, y: 314 + S }, e: { x: 500, y: 314 + 2 * S } };
      expect(where()).toEqual(order);
      drop('n2');
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // r52 Q1's one accepted motion, still there under r62: a's chain holds f
  // (both aimed at 290 to 300) and doesn't change, but the drag pushes f
  // onto d, so d joins the column. As the newest arrival, a goes under f;
  // at the drop the backend counts no arrival, and a's own (the earliest)
  // puts it back at the head, with one glide at once, not after the hold.
  it('a drop inside the band where the arrival order differs: one glide at the drop to the backend\'s order (r52 Q1, r62)', () => {
    fakeTimers();
    try {
      n2At({ x: 400, y: 246 }); // a's target (500, 290)
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('d', 1), target: { x: 500, y: 380 }, since: 1000 }));
      flush();
      send(event({ ...session('f', 2), target: { x: 500, y: 300 }, since: 1500 }));
      flush();
      expect(where()).toEqual({ a: { x: 500, y: 290 }, f: { x: 500, y: 290 + S }, d: { x: 500, y: 380 } });
      // 10 down: f meets d; a, carried, is laid out as the newest arrival.
      // (4 down makes no join: the test above.)
      dragHeld('n2', { x: 400, y: 256 });
      settle(800);
      expect(where()).toEqual({ f: { x: 500, y: 300 }, a: { x: 500, y: 300 + S }, d: { x: 500, y: 300 + 2 * S } });
      drop('n2');
      const path: { a: number; f: number }[] = [];
      for (let i = 0; i < 60; i += 1) { frame(); path.push({ a: where().a.y, f: where().f.y }); }
      const order = { a: { x: 500, y: 300 }, f: { x: 500, y: 300 + S }, d: { x: 500, y: 300 + 2 * S } };
      // Within a second of the drop, well before the hold ends.
      expect(where()).toEqual(order);
      expect(path.filter((p) => p.a > 301 && p.a < 300 + S - 1).length).toBeGreaterThan(4);
      for (let i = 1; i < path.length; i += 1) expect(Math.abs(path[i].a - path[i - 1].a)).toBeLessThan(20);
      // The hold runs out with no arrival: nothing moves again.
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r65 (round 3c's join check, approved): a carry can't make the join
  // it previews. a and f share a chain (aimed at 290 and 300); a 4 px drag
  // pushes f to 4 px short of a step above d. As the newest arrival a would
  // go under f and push f onto d, a join made by the preview itself. Read at
  // a's own arrival there is no join, so nothing swaps, mid-drag or at the drop.
  it('a 4 px drag of a chained pair makes no join of its own: nothing swaps (r65)', () => {
    fakeTimers();
    try {
      n2At({ x: 400, y: 246 }); // a's target (500, 290)
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('d', 1), target: { x: 500, y: 380 }, since: 1000 }));
      flush();
      send(event({ ...session('f', 2), target: { x: 500, y: 300 }, since: 1500 }));
      flush();
      const path: Record<string, { x: number; y: number }>[] = [];
      dragFrames('n2', [1, 2, 3, 4].map((dy) => ({ x: 400, y: 246 + dy })), () => path.push(where()));
      settle(800);
      const held = { a: { x: 500, y: 294 }, f: { x: 500, y: 294 + S }, d: { x: 500, y: 380 } };
      expect(where()).toEqual(held);
      // a heads on every frame, f a step under it, d never moves.
      for (const w of path) {
        expect(w.a.y).toBeLessThan(w.f.y);
        expect(w.d).toEqual({ x: 500, y: 380 });
      }
      drop('n2');
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Rule 101 in the band (review 2, LOW-2 F4): two carries on one dragged
  // node that join a column by overlap keep their order between themselves.
  it('two carries on one node through the overlap band keep their order between themselves, and nothing moves at the drop (rule 101, r62)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      // b arrived first, a second: their keys sort the other way.
      send(event({ ...session('b', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('a', 4), target: { nodeId: 'n2' }, since: 600 }));
      flush();
      send(event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000 }));
      flush();
      dragHeld('n2', { x: 400, y: 270 }); // both at 314: d is 30 below, no chain change
      settle(800);
      const order = { b: { x: 500, y: 314 }, a: { x: 500, y: 314 + S }, d: { x: 500, y: 314 + 2 * S } };
      expect(where()).toEqual(order);
      drop('n2');
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 2, LOW-1 (r62 units): the chain is canvas units, and so is the
  // insert's 16. At zoom 2, a at 332 is 12 from d (in d's chain) but 24
  // screen px above it; at zoom 0.5, a at 358 is 26 above e but 13 screen
  // px. Either way a sits between d and e, as the backend will order it.
  it.each([[2, 332], [0.5, 358]])('at zoom %s a carry held at %s, in d\'s chain, goes in after d and before e: the insert compares in canvas units like the chain (r62)', (z, aT) => {
    fakeTimers();
    try {
      pane.transform = [0, 0, z];
      render(<AgentCursorLayer />);
      intoColumn();
      send(event({ ...session('e', 2), target: { x: 500, y: 384 }, since: 2000 }));
      flush();
      dragHeld('n2', { x: 400, y: aT - 44 });
      settle(800);
      const w = where();
      expect(w.a.x).toBe(500);
      expect(w.d.y).toBe(344);
      expect(w.a.y).toBeGreaterThan(w.d.y);
      expect(w.e.y).toBeGreaterThan(w.a.y);
      // The drop and the backend's arrival (the chain changed): nothing moves.
      drop('n2');
      arrive('a', 3, 9000);
      for (let i = 0; i < 120; i += 1) { frame(); expect(where()).toEqual(w); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 2, MEDIUM (r62), as r75.3 rules it: a cursor on a port is drawn
  // on the port, and counts as its node's header point for the chain, on
  // both sides. a is carried to 2 px above c's drawn point: their drawn
  // targets join one column, but a's chain (c at n1's header, 107 away)
  // doesn't change, so the backend sends no arrival. The band is measured
  // in chain space too: a is nowhere near c's header, so it joins c's
  // column in plain arrival order (a first), mid-drag as at the drop.
  // Nothing moves at the drop (review 3, drag MEDIUM-1: it swapped there).
  it('a carry onto a port cursor\'s drawn point: no chain preview and no band slot (the port counts at its node\'s header), so nothing moves at the drop (r62, r75.3)', () => {
    fakeTimers();
    try {
      const n1 = lookup.get('n1') as unknown as Entry & { internals: { handleBounds: unknown } };
      lookupRef.current = new Map(lookup).set('n1', { ...n1, internals: { ...n1.internals,
        handleBounds: { source: [{ id: 'text', x: 185, y: 100, width: 10, height: 10 }], target: [] } } } as never) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: 'text' }, since: 1000 }));
      flush();
      expect(where()).toEqual({ a: { x: 1000, y: 344 }, c: { x: 590, y: 405 } });
      dragHeld('n2', { x: 490, y: 359 }); // a at (590, 403)
      settle(800);
      const order = { a: { x: 590, y: 403 }, c: { x: 590, y: 403 + S } };
      expect(where()).toEqual(order);
      drop('n2');
      for (let t = 0; t < CARRY_PREVIEW_HOLD_MS + 1000; t += 1000 / 60) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r75.3, the shared traces (backend/tests/fixtures/cursor_chains.json,
  // also run by test_agent_cursor_followups.py through carry_nodes): a,
  // arrived first, carried by n2 frame by frame along the path, then held
  // there and dropped; h, a port cursor on n1, arrived second. Onto h's
  // drawn tip from any side, a's chain never changes (h counts at its
  // node's header) and the band is measured in chain space, so a joins h's
  // column in plain arrival order: its slot is the one the drop gives,
  // mid-drag as after it. Onto h's node header, r65's head-then-bottom path
  // holds, and the backend's arrival at the drop moves nothing. (h is c
  // here: session keys are hex.)
  type Box = { x: number; y: number; width: number; height: number };
  type Trace = { name: string; zoom: number; h: { node: Box; handle: string; port: Box }; carry: { width: number; height: number };
    path: [number, number][]; arrivalFrom: number | null; slots: number[] };
  const traces = (JSON.parse(readFileSync(resolve(__dirname, '../../backend/tests/fixtures/cursor_chains.json'), 'utf8')) as { traces: Trace[] }).traces;
  it('the shared fixture holds the r75.3 traces at zoom 0.5, 1 and 2, and r85\'s at 0.25 and 0.1 and on a left input near the header', () => {
    expect(new Set(traces.map((t) => t.zoom))).toEqual(new Set([0.1, 0.25, 0.5, 1, 2]));
    expect(traces.filter((t) => t.h.port.x < 0 && t.h.port.y === 62).map((t) => t.zoom).sort()).toEqual([0.25, 0.25, 0.25, 0.5, 0.5, 0.5, 1, 1, 1]);
    expect(traces.filter((t) => t.arrivalFrom === null).length).toBeGreaterThanOrEqual(9);
    expect(traces.filter((t) => t.arrivalFrom !== null).length).toBeGreaterThanOrEqual(3);
  });
  it.each(traces.map((t) => [t.name, t] as const))('%s (r75.3)', (_name, t) => {
    fakeTimers();
    try {
      pane.transform = [0, 0, t.zoom];
      const n1 = { id: 'n1', measured: { width: t.h.node.width, height: t.h.node.height },
        internals: { positionAbsolute: { x: t.h.node.x, y: t.h.node.y }, handleBounds: { source: [{ id: t.h.handle, ...t.h.port }], target: [] } } };
      const n2 = { id: 'n2', measured: { ...t.carry },
        internals: { positionAbsolute: { x: t.path[0][0], y: t.path[0][1] }, handleBounds: { source: [], target: [] } } };
      lookupRef.current = new Map([['n1', n1], ['n2', n2]]) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: t.h.handle }, since: 1000 }));
      flush();
      const slots: number[] = [];
      let frameAt = -1;
      let bottomAt: number | null = null;
      dragFrames('n2', t.path.map(([x, y]) => ({ x, y })), () => {
        frameAt += 1;
        const slot = slotOf('a', ['c']);
        if (slots[slots.length - 1] !== slot) slots.push(slot);
        if (slot === 1 && bottomAt === null) bottomAt = frameAt;
      });
      // Onto the header: a starts for the bottom on the frame its chain
      // takes h in (the backend's arrival from there on), never before, and
      // is drawn past h within the glide (a few frames on).
      if (t.arrivalFrom !== null) {
        expect(bottomAt, t.name).toBeGreaterThanOrEqual(t.arrivalFrom);
        expect(bottomAt, t.name).toBeLessThanOrEqual(t.arrivalFrom + 12);
      }
      // Held there, still dragging, past every glide: its mid-drag slot.
      dragFrames('n2', Array.from({ length: 60 }, () => ({ x: t.path[t.path.length - 1][0], y: t.path[t.path.length - 1][1] })), () => {
        const slot = slotOf('a', ['c']);
        if (slots[slots.length - 1] !== slot) slots.push(slot);
      });
      expect(slots, t.name).toEqual(t.slots);
      const held = where();
      drop('n2');
      if (t.arrivalFrom !== null) arrive('a', 3, 9000);
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS + 1000; ms += 1000 / 60) { frame(); expect(where(), t.name).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 4, MEDIUM-1 (GM r85 rule b), the reviewers' probes kept as
  // tests: a carried onto a port cursor's drawn tip, at zooms and port
  // spots the shared traces don't all cover. The band's chain-space join is
  // the zoom-1 join in canvas units at every zoom, so a carry on the tip
  // never reaches h's node header there however far out the view is. Its
  // slot in h's column never goes to the bottom mid-drag (from below, the
  // r24 insert puts h first until a is within 16 of it, r80), the held
  // frames move nothing, and nothing moves at the drop.
  type Probe = { zoom: number; from: 'above' | 'left' | 'below' | 'diagonal'; node: Box; port: Box; side: 'source' | 'target'; end: [number, number]; far?: number; slots?: number[] };
  const fixtureH = { node: { x: 400, y: 300, width: 280, height: 180 }, port: { x: 225, y: 150, width: 16, height: 16 } };
  const probes: [string, Probe][] = [
    // PROBE3 (layout lens): the fixture's port, 2 units off its tip (633, 458).
    ...([[0.25, 'above'], [0.1, 'above'], [0.25, 'left'], [0.1, 'left'], [0.25, 'below'], [0.1, 'below'], [4, 'above'], [4, 'below'], [3, 'left']] as const)
      .map(([zoom, from]): [string, Probe] => [`PROBE3: the fixture's port at zoom ${zoom} from ${from}`, { zoom, from, ...fixtureH, side: 'source',
        end: from === 'below' ? [533, 416] : from === 'left' ? [531, 414] : [533, 412] }]),
    // PROBE4 (layout lens): an output port near the header row, tip (680, 358), header (540, 344).
    // From the left, a's target (y 358) passes 14 under the header on its
    // way: in h's chain there, a real arrival had it dropped, so the bottom
    // slot then and back to the head past it (the r65 path both ways).
    ...([[1, 'above'], [0.75, 'above'], [0.5, 'above'], [0.5, 'left'], [0.5, 'below'], [1, 'left'], [0.75, 'below']] as const)
      .map(([zoom, from]): [string, Probe] => [`PROBE4: an output port near the header at zoom ${zoom} from ${from}`, { zoom, from,
        node: fixtureH.node, port: { x: 272, y: 50, width: 16, height: 16 }, side: 'source',
        end: from === 'below' ? [580, 316] : from === 'left' ? [578, 314] : [580, 312], slots: from === 'left' ? [0, 1, 0] : undefined }]),
    // PROBE5 (layout lens): a left input at y 62, tip (400, 370).
    ...([[0.5, 'above'], [0.5, 'below'], [0.6, 'above'], [0.4, 'above'], [1, 'above']] as const)
      .map(([zoom, from]): [string, Probe] => [`PROBE5: a left input at y 62 at zoom ${zoom} from ${from}`, { zoom, from,
        node: fixtureH.node, port: { x: -8, y: 62, width: 16, height: 16 }, side: 'source',
        end: from === 'below' ? [300, 330] : [300, 322] }]),
    // PROBE5 (drag-live lens): combine-text's left input, from the upper left
    // on the live drag's diagonal; and the fixture's port from above at 0.25-0.45.
    ...[0.5, 0.6, 0.75, 1].map((zoom): [string, Probe] => [`PROBE5 live: a left input from the upper left at zoom ${zoom}`, { zoom, from: 'diagonal',
      node: { x: 400, y: 300, width: 200, height: 180 }, port: { x: -18, y: 80.39, width: 10, height: 10 }, side: 'target', end: [287, 341.39] }]),
    ...[0.25, 0.35, 0.45].map((zoom): [string, Probe] => [`PROBE5 live: the fixture's port from above at zoom ${zoom}`, { zoom, from: 'above', ...fixtureH, side: 'source',
      end: [533, 412], far: 318 }]),
  ];
  it.each(probes)('%s: no band slot on the tip, nothing moves while held or at the drop (review 4, MEDIUM-1; r85)', (_name, p) => {
    fakeTimers();
    try {
      pane.transform = [0, 0, p.zoom];
      const far = p.far ?? 400 / p.zoom;
      const n = Math.round(far / 2);
      const path: [number, number][] = p.from === 'diagonal'
        ? Array.from({ length: 61 }, (_, i) => [250 + (37 * i) / 60, 100 + (241.39 * i) / 60])
        : Array.from({ length: n + 1 }, (_, i) => {
          const d = far * (1 - i / n);
          return p.from === 'above' ? [p.end[0], p.end[1] - d] : p.from === 'below' ? [p.end[0], p.end[1] + d] : [p.end[0] - d, p.end[1]];
        });
      const handle = { id: 'text', ...p.port };
      const n1 = { id: 'n1', measured: { width: p.node.width, height: p.node.height },
        internals: { positionAbsolute: { x: p.node.x, y: p.node.y }, handleBounds: p.side === 'source' ? { source: [handle], target: [] } : { source: [], target: [handle] } } };
      const n2 = { id: 'n2', measured: { width: 200, height: 120 },
        internals: { positionAbsolute: { x: path[0][0], y: path[0][1] }, handleBounds: { source: [], target: [] } } };
      lookupRef.current = new Map([['n1', n1], ['n2', n2]]) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: 'text' }, since: 1000 }));
      flush();
      const slots: number[] = [];
      const note = () => {
        const slot = slotOf('a', ['c']);
        if (slots[slots.length - 1] !== slot) slots.push(slot);
      };
      dragFrames('n2', path.map(([x, y]) => ({ x, y })), note);
      const last = path[path.length - 1];
      dragFrames('n2', Array.from({ length: 30 }, () => ({ x: last[0], y: last[1] })), note);
      const held = where();
      dragFrames('n2', Array.from({ length: 30 }, () => ({ x: last[0], y: last[1] })), () => { note(); expect(where()).toEqual(held); });
      expect(slots[slots.length - 1]).toBe(0);
      expect(slots, 'never the bottom slot mid-drag').toEqual(p.slots ?? (p.from === 'below' && slots.length > 1 ? [1, 0] : [0]));
      drop('n2');
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS + 1000; ms += 1000 / 60) { frame(); expect(where()).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r75.3: the band slot needs a new member of the column the carry is
  // drawn in. a and f share a chain (aimed at 290 and 300), f a step under
  // a. n1's header point, where c (on a port low on n1's left, drawn at
  // (400, 451)) counts, is at (500, 380). a carried 20 down to 310 takes f
  // down with it, and in chain space f's label now meets c's header point:
  // c joins a's column there, new. But c is drawn far off, so a's drawn
  // column is still just f's, no chain changed, and its order stays plain
  // arrival order (a first). Nothing swaps, mid-drag or at the drop.
  it('a carry whose chain-space column takes in a cursor drawn elsewhere keeps its drawn column\'s arrival order (r75.3)', () => {
    fakeTimers();
    try {
      n2At({ x: 400, y: 246 }); // a's target (500, 290)
      const n1 = lookup.get('n1') as unknown as Entry & { internals: { handleBounds: unknown } };
      lookupRef.current = new Map(lookupRef.current).set('n1', { ...n1, internals: { ...n1.internals, positionAbsolute: { x: 400, y: 336 },
        handleBounds: { source: [{ id: 'text', x: -5, y: 110, width: 10, height: 10 }], target: [] } } } as never) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('f', 2), target: { x: 500, y: 300 }, since: 1000 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: 'text' }, since: 1500 }));
      flush();
      expect(where()).toEqual({ a: { x: 500, y: 290 }, f: { x: 500, y: 290 + S }, c: { x: 400, y: 451 } });
      const path: Record<string, { x: number; y: number }>[] = [];
      dragFrames('n2', Array.from({ length: 10 }, (_, i) => ({ x: 400, y: 248 + 2 * i })), () => path.push(where()));
      settle(800);
      const held = { a: { x: 500, y: 310 }, f: { x: 500, y: 310 + S }, c: { x: 400, y: 451 } };
      expect(where()).toEqual(held);
      for (const w of path) expect(w.a.y).toBeLessThan(w.f.y);
      drop('n2');
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS + 1000; ms += 1000 / 60) { frame(); expect(where()).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 4, layout LOW-2 B3: the column before the carry is read in chain
  // space too. a rides n2 and aims at (555, 344), 15 right of n1's header
  // point (540, 344), where c counts (its port is drawn at (454, 344)): c is
  // in a's chain-space column before the carry and after it, so no band
  // slot. Carried 30 left, a's drawn tip meets c's: they join one drawn
  // column, in plain arrival order (a first), and nothing moves at the drop.
  // Read before the carry in drawn space, c would count as new, and a would
  // take the newest-arrival slot under it mid-drag.
  it('a member already in the carry\'s chain-space column before the carry gives it no band slot (review 4, B3)', () => {
    fakeTimers();
    try {
      n2At({ x: 455, y: 300 }); // a's target (555, 344)
      const n1 = lookup.get('n1') as unknown as Entry & { internals: { handleBounds: unknown } };
      lookupRef.current = new Map(lookupRef.current).set('n1', { ...n1, measured: { width: 280, height: 180 }, internals: { ...n1.internals, positionAbsolute: { x: 400, y: 300 },
        handleBounds: { source: [{ id: 'text', x: 49, y: 39, width: 10, height: 10 }], target: [] } } } as never) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: 'text' }, since: 1000 }));
      flush();
      expect(where()).toEqual({ a: { x: 555, y: 344 }, c: { x: 454, y: 344 } });
      const path: Record<string, { x: number; y: number }>[] = [];
      dragFrames('n2', Array.from({ length: 15 }, (_, i) => ({ x: 453 - 2 * i, y: 300 })), () => path.push(where()));
      settle(800);
      const held = { a: { x: 525, y: 344 }, c: { x: 525, y: 344 + S } };
      expect(where()).toEqual(held);
      for (const w of path) expect(w.a.y).toBeLessThanOrEqual(w.c.y);
      drop('n2');
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS + 1000; ms += 1000 / 60) { frame(); expect(where()).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r85 rule b, both sides of the band read: before the carry too, the
  // chain-space column is the zoom-1 join, whatever the view's zoom. At
  // zoom 0.25 a starts 110 canvas units above c (and 30 left): drawn, their
  // labels already meet, so they share a column in plain arrival order (a
  // first), but they are not in band range in canvas units. Carried down to
  // 10 above c (still over 16 away: no chain), a comes into band range, c
  // is a new member there, and a takes the newest-arrival slot (r62), under
  // c. At the drop the backend counts no arrival, so a glides back to the
  // head once, r52's one accepted motion. Read before the carry at the
  // view's zoom, c would already count as in range and a would never move.
  it('at zoom 0.25 the band range before the carry is the zoom-1 join too: a carry coming into it takes the band slot (r85 rule b)', () => {
    fakeTimers();
    try {
      pane.transform = [0, 0, 0.25];
      n2At({ x: 370, y: 190 }); // a's target (470, 234): 30 left of c, 110 above
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { x: 500, y: 344 }, since: 1000 }));
      flush();
      settle(400);
      expect(slotOf('a', ['c'])).toBe(0);
      expect(where().a.x).toBe(where().c.x); // one drawn column already
      const slots: number[] = [];
      const note = () => {
        const slot = slotOf('a', ['c']);
        if (slots[slots.length - 1] !== slot) slots.push(slot);
      };
      dragFrames('n2', Array.from({ length: 50 }, (_, i) => ({ x: 370, y: 192 + 2 * i })), note);
      dragFrames('n2', Array.from({ length: 48 }, () => ({ x: 370, y: 290 })), note);
      expect(slots).toEqual([0, 1]);
      drop('n2');
      settle(CARRY_PREVIEW_HOLD_MS + 1000);
      expect(slotOf('a', ['c'])).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The layer's shared field, read through a cursor's view (its props):
   *  for the bookkeeping no frame shows. */
  const fieldOf = () => {
    const el = cursors()[0] as unknown as Record<string, unknown>;
    let fiber = el[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))!] as { memoizedProps?: { field?: unknown }; return: unknown } | null;
    while (fiber && !fiber.memoizedProps?.field) fiber = fiber.return as typeof fiber;
    return fiber!.memoizedProps!.field as { heldSince: Map<string, number>; draggedNodes: Set<string> };
  };

  // Review 3, layout LOW-1 R4: a member whose loop stopped (its node
  // deleted mid-glide) doesn't hold the column's rest. a, gliding to the
  // bottom, loses n2 three frames in: d and e land on their own rest, not
  // held to the 300 ms cap by a cursor that will never step again.
  it('a member whose node goes mid-glide holds no one: the others land on their own rest (review 3, R4)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      for (let i = 0; i < 3; i += 1) frame();
      const next = new Map(lookupRef.current);
      next.delete('n2');
      lookupRef.current = next;
      notifyStore();
      const slot = { d: 344, e: 344 + S };
      const ownRest = { d: -1, e: -1 };
      const landed = { d: -1, e: -1 };
      let prev = where();
      for (let i = 0; i < 60; i += 1) {
        frame();
        const w = where();
        for (const k of ['d', 'e'] as const) {
          const y = w[k].y;
          if (ownRest[k] < 0 && Math.abs(y - slot[k]) < 0.2 && Math.abs(y - prev[k].y) * 60 < 2) ownRest[k] = i;
          if (landed[k] < 0 && byKey(k).style.willChange === 'auto' && y === slot[k]) landed[k] = i;
        }
        prev = w;
      }
      for (const k of ['d', 'e'] as const) {
        expect(landed[k], k).toBeGreaterThanOrEqual(0);
        // Within a frame of its own rest (the cap would be 18 frames on).
        expect(landed[k] - Math.max(ownRest[k], 0), k).toBeLessThanOrEqual(2);
        // Nor does it keep its column in glide order (GM r95): it glides no more.
        expect(byKey(k).dataset.columnOrder, k).toBeUndefined();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 3, layout LOW-1 C3/C4: a node widened under a port cursor on its
  // left side leaves the port (its drawn point) where it was, but moves its
  // header point, where the chain counts it. That alone must reach the
  // layout. n1, 60 wide, has c on its left input port, drawn at (400, 340),
  // its header at (430, 340). a, carried onto (430, 344), takes c into its
  // chain: the preview lays it out last, under c. n1 widened to 300 puts
  // c's header at (550, 340): a's chain is empty again, as it was before the
  // carry, and nothing in the band, so a heads c's column in plain arrival
  // order, and the drop moves nothing.
  it('a node resized under a port cursor moves its chain point only, and the carry beside it follows that (review 3, C3 and C4)', () => {
    fakeTimers();
    try {
      const n1 = { id: 'n1', measured: { width: 60, height: 80 },
        internals: { positionAbsolute: { x: 400, y: 300 }, handleBounds: { source: [{ id: 'in', x: -5, y: 35, width: 10, height: 10 }], target: [] } } };
      lookupRef.current = new Map(lookup).set('n1', n1 as never) as never;
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }));
      flush();
      send(event({ ...session('c', 1), target: { nodeId: 'n1', handle: 'in' }, since: 1000 }));
      flush();
      expect(where().c).toEqual({ x: 400, y: 340 });
      dragHeld('n2', { x: 330, y: 300 }); // a at (430, 344)
      settle(800);
      expect(slotOf('a', ['c'])).toBe(1);
      const wide = new Map(lookupRef.current);
      wide.set('n1', { ...n1, measured: { width: 300, height: 80 } });
      lookupRef.current = wide;
      notifyStore();
      settle(800);
      const order = { a: { x: 430, y: 344 }, c: { x: 430, y: 344 + S } };
      expect(where()).toEqual(order);
      drop('n2');
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS + 1000; ms += 1000 / 60) { frame(); expect(where()).toEqual(order); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 3, layout LOW-1 N2: a node deleted mid-drag ends its drag on the
  // frame its cursor sees it gone, and the wait for the backend starts
  // there: the settle is set on that frame, not left to a timer set for an
  // earlier carry.
  it('a node deleted mid-drag starts the preview\'s wait on that frame (review 3, N2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(200);
      const settles = settleTimers();
      const next = new Map(lookupRef.current);
      next.delete('n2');
      lookupRef.current = next;
      notifyStore();
      tickFrames(1);
      expect(settles()).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 3, layout NIT-1: a landing the column held reads the hover boxes
  // once, on the cursor's own rest, not again when the column lands.
  it('a held landing reads its hover boxes on one frame only (review 3, NIT-1)', () => {
    fakeTimers();
    pane.dom = document.createElement('div');
    document.body.appendChild(pane.dom);
    const reads: Element[] = [];
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === pane.dom) return new DOMRect(0, 0, 1440, 900);
      reads.push(this);
      const cursor = this.closest<HTMLElement>('.agent-cursor');
      const p = cursor ? at(cursor) : { x: -999, y: -999 };
      if (this.classList.contains('agent-cursor__pointer')) return new DOMRect(p.x, p.y, 20, 22);
      if (this.classList.contains('agent-cursor__name')) return new DOMRect(p.x + 15, p.y + 17, 60, 20);
      return new DOMRect(0, 0, 0, 0);
    });
    try {
      render(<AgentCursorLayer />);
      act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 505, clientY: 350 })); });
      headToBottom();
      const d = byKey('d');
      let readFrames = 0;
      let landedAt = -1;
      for (let i = 0; i < 90; i += 1) {
        reads.length = 0;
        frame();
        if (reads.some((el) => d.contains(el))) readFrames += 1;
        if (landedAt < 0 && d.style.willChange === 'auto') landedAt = i;
      }
      expect(landedAt).toBeGreaterThan(0);
      expect(readFrames).toBe(1);
    } finally {
      rects.mockRestore();
      pane.dom.remove();
      vi.useRealTimers();
    }
  });

  // Review 3, drag NIT-1: a cursor that lands holds nothing: its hold's
  // start goes with the landing, not on its next glide.
  it('the column lands and no cursor keeps a hold (review 3, drag NIT-1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      for (let i = 0; i < 90; i += 1) frame();
      expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } });
      expect([...fieldOf().heldSince.keys()]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 3, layout NIT-2: every cursor on a dragged node forgotten mid-drag
  // ends that node's drag: no cursor will report it again.
  it('a dragged node whose cursors are all forgotten mid-drag is no longer held (review 3, NIT-2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(200);
      expect(fieldOf().draggedNodes.has('n2')).toBe(true);
      act(() => {
        const st = useAgentPresenceStore;
        const agents = { ...st.getState().agents };
        for (const k of Object.keys(agents)) if (agents[k].session?.key === 'a'.repeat(12)) delete agents[k];
        st.setState({ agents });
      });
      flush();
      expect(fieldOf().draggedNodes.has('n2')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 4, layout LOW-2 F2: one of two cursors on a dragged node
  // forgotten keeps the node's drag: the other still rides it, and its drop
  // is a drop. a and b ride n2 into d's chain and are previewed under d; the
  // hand holds still past the preview's hold, then b leaves, and its view
  // goes on the frame before the drop. The drop starts the wait for the
  // backend's arrival there, so a keeps its slot until the arrival comes;
  // were n2's drag dropped with b, the drop would go unseen and a would
  // glide back at once, then again to the bottom on the arrival.
  it('a dragged node keeps its drag while another cursor still rides it when one is forgotten (review 4, F2)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      for (const [k, since, o] of [['a', 500, 3], ['b', 600, 4]] as const) {
        send(event({ ...session(k, o), target: { nodeId: 'n2' }, since }));
        flush();
      }
      send(event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000 }));
      flush();
      dragHeld('n2', { x: 400, y: 300 });
      settle(CARRY_PREVIEW_HOLD_MS + 500);
      expect(where()).toEqual({ d: { x: 500, y: 344 }, a: { x: 500, y: 344 + S }, b: { x: 500, y: 344 + 2 * S } });
      const field = fieldOf() as unknown as { released: Set<string>; draggedNodes: Set<string> };
      act(() => {
        const st = useAgentPresenceStore;
        const agents = { ...st.getState().agents };
        for (const k of Object.keys(agents)) if (agents[k].session?.key === 'b'.repeat(12)) delete agents[k];
        st.setState({ agents });
      });
      // b fades out; its view goes (released, forgotten on the next read).
      for (let i = 0; i < 200 && field.released.size === 0; i += 1) frame();
      expect(field.released.size).toBe(1);
      drop('n2');
      // b's faded view may still be in the DOM: d's and a's spots only.
      const da = () => { const w = where(); return { d: w.d, a: w.a }; };
      const held = { d: { x: 500, y: 344 }, a: { x: 500, y: 344 + S } };
      expect(da()).toEqual(held);
      for (let ms = 0; ms < 1000; ms += 1000 / 60) { frame(); expect(da()).toEqual(held); }
      arrive('a', 3, 9000);
      for (let ms = 0; ms < CARRY_PREVIEW_HOLD_MS; ms += 1000 / 60) { frame(); expect(da()).toEqual(held); }
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 2, LOW-2 F6: an event of the carried cursor's own, at the same
  // spot, ends the preview at once: the backend's arrival for it stands.
  it('the carried cursor\'s own event during the hold ends the preview at once (review 2, F6)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(800);
      expect(where().a).toEqual({ x: 500, y: 344 + 2 * S });
      drop('n2');
      settle(200);
      // A nudge of its own, inside its stamp radius: it keeps its arrival
      // (500), so it heads the column again, before the hold ends.
      send(event({ ...session('a', 3), target: { x: 504, y: 344 }, since: 500, action: 'look' }));
      settle(700); // still inside the 1.5 s hold
      expect(where()).toEqual({ a: { x: 504, y: 344 }, d: { x: 504, y: 344 + S }, e: { x: 504, y: 344 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  /** The carry preview's wait timers set from now on (settleCarries). */
  const settleTimers = () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    return () => spy.mock.calls.filter(([fn]) => String(fn).includes('settleCarries')).length;
  };

  // Review 2, LOW-2 F7: a carried cursor forgotten mid-drag takes its
  // preview with it: nothing is left to settle, so no cursor is woken for
  // it when the hold runs out.
  it('a carried cursor that goes mid-drag leaves no preview to settle (review 2, F7)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(200);
      act(() => {
        const st = useAgentPresenceStore;
        const agents = { ...st.getState().agents };
        for (const k of Object.keys(agents)) if (agents[k].session?.key === 'a'.repeat(12)) delete agents[k];
        st.setState({ agents });
      });
      flush(); // a's exit, then every cursor at rest
      expect(frames.length).toBe(0);
      // Past the hold: no wake, no frame asked for.
      act(() => { vi.advanceTimersByTime(CARRY_PREVIEW_HOLD_MS + 500); });
      expect(frames.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 2, NIT-1: a node deleted mid-drag ends that drag (no drop will
  // come), so its preview ends after the hold and its timer stops; and no
  // timer outlives the layer.
  it('a node deleted mid-drag ends its drag: the preview\'s timer stops after the hold (review 2, NIT-1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(200);
      const settles = settleTimers();
      const next = new Map(lookupRef.current);
      next.delete('n2');
      lookupRef.current = next;
      notifyStore();
      settle(CARRY_PREVIEW_HOLD_MS + 300);
      const base = settles();
      settle(1000);
      expect(settles()).toBe(base);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no carry timer outlives the layer (review 2, NIT-1)', () => {
    fakeTimers();
    try {
      const view = render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 300 });
      settle(200);
      const settles = settleTimers();
      view.unmount();
      act(() => { vi.advanceTimersByTime(3 * CARRY_PREVIEW_HOLD_MS); });
      expect(settles()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 2, LOW-2 F11: the backend's word that an arrival is its own, at
  // the same number, changes the tie-break to the key, in every tab alike.
  it('an arrival that becomes the backend\'s own at the same number re-sorts a tie by key (review 2, F11)', () => {
    render(<AgentCursorLayer />);
    send(event({ ...session('b', 2), target: { x: 300, y: 300 } }));
    flush();
    send(event({ ...session('a', 1), target: { x: 300, y: 300 } }));
    flush();
    // No backend arrival: this tab's landing order, b first.
    expect(where()).toEqual({ b: { x: 300, y: 300 }, a: { x: 300, y: 300 + S } });
    arrive('a', 1, 0);
    arrive('b', 2, 0);
    flush();
    expect(where()).toEqual({ a: { x: 300, y: 300 }, b: { x: 300, y: 300 + S } });
  });

  it('a carry with no backend arrival is no arrival: the cursor keeps its place (r24 Q2)', () => {
    render(<AgentCursorLayer />);
    // e on n1 arrived first; a came later to a point just clear under it.
    send(event({ ...session('e', 3), target: { nodeId: 'n1' }, since: 500 }));
    flush();
    send(event({ ...session('a', 1), target: { x: 500, y: 394 }, since: 1000 }));
    flush();
    expect(where()).toEqual({ e: { x: 500, y: 344 }, a: { x: 500, y: 394 } });
    // n1 dropped 12 px lower: e now meets a. The arrow joins the column in
    // this tab only (overlap joins are the tab's), and the backend's chain
    // (targets 38 px apart) didn't change: no arrival. e still heads, and a
    // steps under it.
    dragNode('n1', { x: 400, y: 312 });
    flush();
    expect(where()).toEqual({ e: { x: 500, y: 356 }, a: { x: 500, y: 356 + S } });
  });

  // Review 9, LOW-2: equal arrivals tie-break by the cursor's key, the same
  // in every tab, never by which landed first here.
  it('two cursors with the same backend arrival stack by key in every tab, whichever lands first', () => {
    const order = () => Object.entries(where()).sort((p, q) => p[1].y - q[1].y).map(([k]) => k);
    const first = render(<AgentCursorLayer />);
    send(event({ ...session('b', 2), target: { x: 300, y: 300 }, since: 7000 }));
    flush();
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, since: 7000 }));
    flush();
    const one = order();
    first.unmount();
    act(() => { useAgentPresenceStore.getState().clear(); });
    render(<AgentCursorLayer />);
    send(event({ ...session('a', 1), target: { x: 300, y: 300 }, since: 7000 }));
    flush();
    send(event({ ...session('b', 2), target: { x: 300, y: 300 }, since: 7000 }));
    flush();
    expect(order()).toEqual(one);
    expect(one).toEqual(['a', 'b']);
  });

  // Review 9, NIT-2: the head and the count's member leave together; the
  // new count still waits for the old one's exit (keyed by its group).
  it('the head and the count cursor\'s member leave in one moment: never more than 3 shown (review 9 NIT-2)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(byKey('c').dataset.count).toBe('4');
    act(() => {
      const st = useAgentPresenceStore;
      const agents = { ...st.getState().agents };
      for (const k of Object.keys(agents)) if (['a', 'c'].some((g) => agents[k].session?.key === g.repeat(12))) delete agents[k];
      st.setState({ agents });
    });
    let exitFrames = 0;
    for (let i = 0; i < 120; i += 1) {
      tickFrames(1);
      const live = cursors().filter((el) => el.dataset.session !== 'a'.repeat(12));
      const shown = live.filter((el) => Number(el.style.opacity) > 0.05);
      expect(shown.length).toBeLessThanOrEqual(3);
      if (cursors().some((el) => el.dataset.session === 'c'.repeat(12) && Number(el.style.opacity) > 0.05)) exitFrames += 1;
    }
    flush();
    expect(exitFrames).toBeGreaterThan(2);
    expect(byKey('e').dataset.count).toBe('2');
  });

  // Review 9, LOW-6: a say capped while a cursor keeps moving through its
  // room shows where nothing is drawn, moving cursors included: never on
  // top of it.
  it('a say capped while another cursor keeps moving through its room shows on the free side, never over it (review 9 LOW-6)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      blocker('a', 1, 300, 300);
      blocker('e', 2, 400, 318);
      // e takes off along the say's row and never stops: it turns back
      // every 6 frames.
      send(event({ ...session('e', 2), target: { x: 470, y: 318 } }));
      frame();
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const a = byKey('a');
      let flip = true;
      let shownAt = -1;
      for (let i = 0; i < 90; i += 1) {
        if (i % 6 === 5) {
          flip = !flip;
          send(event({ ...session('e', 2), target: { x: flip ? 470 : 400, y: 318 } }));
        }
        frame();
        if (painted(a)) {
          if (shownAt < 0) shownAt = i;
          expect(a.dataset.saySide).toBe('left');
          expect(anyMeet()).toBe(false);
        }
      }
      expect(shownAt).toBeGreaterThan(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a say capped with a still cursor on its left and one that never stops on its right goes to the log, never back to waiting (#219 review 1, NIT-1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      blocker('a', 1, 300, 300);
      blocker('f', 3, 150, 318); // still, across the left say's row
      blocker('e', 2, 400, 318);
      send(event({ ...session('e', 2), target: { x: 470, y: 318 } }));
      frame();
      send(event({ ...session('a', 1), target: { x: 300, y: 300 }, say: 'Checking the prompt' }));
      const a = byKey('a');
      let flip = true;
      let loggedAt = -1;
      const states: string[] = [];
      for (let i = 0; i < 150; i += 1) {
        if (i % 6 === 5) {
          flip = !flip;
          send(event({ ...session('e', 2), target: { x: flip ? 470 : 400, y: 318 } }));
        }
        frame();
        expect(painted(a)).toBe(false);
        states.push(a.dataset.sayWait ?? '-');
        if (loggedAt < 0 && a.dataset.sayWait === 'log') loggedAt = i;
      }
      // Held at the cap, then the Agent log once the cap is up again, while
      // e still moves; with the bounce it went back to waiting and the cap
      // started over, so it never got there.
      expect(loggedAt, states.join('')).toBeGreaterThan(0);
      expect(loggedAt).toBeLessThan(100);
    } finally {
      vi.useRealTimers();
    }
  });

  // #219 review 5, MEDIUM-1 (R5PROBE_B, kept): a cursor at rest, no frame
  // for a while (every cursor rested), then an event woke it and a zoom came
  // before its first frame. The zoom's carry stepped it at the field's
  // frameTime, from the last frame anyone drew, and left its clock there:
  // its first frame saw a gap past the stall threshold and landed it with
  // no flight and no ring (2 s idle), or jumped its flight's first frame
  // 187 px (100 ms idle). The control has no zoom. performance.now() as a
  // browser has it, a little past the frame (the r3h tests' mock).
  it.each([[true, 2000], [false, 2000], [true, 100]] as const)('an event after an idle spell, a zoom before its first frame (%s, idle %s ms): it flies there and the click rings (review 5, MEDIUM-1)', (zoomFirst, idle) => {
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock + 4 + (reads += 0.001));
    try {
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 1), target: { x: 300, y: 300 } }));
      flush();
      const x0 = at(byKey('a')).x;
      expect(x0).toBe(300);
      clock += idle;
      send(event({ ...session('a', 1), target: { x: 700, y: 300 }, action: 'click' }));
      if (zoomFirst) { pane.transform = [0, 0, 0.95]; notifyStore(); }
      const xs: number[] = [];
      let rippled = false;
      for (let i = 0; i < 120 && frames.length > 0; i += 1) {
        tickFrames(1);
        xs.push(at(byKey('a')).x);
        if (ripple()) rippled = true;
      }
      const inFlight = xs.filter((x) => x > x0 + 5 && x < 695).length;
      expect(inFlight, JSON.stringify(xs.slice(0, 5))).toBeGreaterThan(15);
      // Its first frame steps a frame or two of its flight (the carry's
      // own step, then the frame's), not the gap's 187 px.
      expect(xs[0] - x0).toBeLessThan(40);
      expect(xs[xs.length - 1]).toBe(700);
      expect(rippled).toBe(true);
    } finally {
      vi.restoreAllMocks();
      pane.transform = [0, 0, 1];
    }
  });

  // Review 5, NIT-2 and M18: a carry's time before any frame has run is one
  // value for the whole carry, and never past the next frame's timestamp, as
  // a clock read can be. (No cursor has a motion before a frame, so no carry
  // steps one then: the value is pinned here, on the field.)
  it('a carry before any frame steps at a time no later than the next frame, the same for every cursor (review 5, NIT-2)', () => {
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock + 40 + (reads += 0.001));
    try {
      render(<AgentCursorLayer />);
      send(event({ ...session('a', 1), target: { x: 300, y: 300 } }));
      const field = fieldOf() as unknown as { carryTime: () => number; frameTime: number };
      expect(field.frameTime).toBe(-Infinity);
      const first = field.carryTime();
      expect(field.carryTime()).toBe(first);
      expect(first).toBeLessThanOrEqual(clock + 1000 / 60);
      tickFrames(1);
      expect(field.frameTime).toBe(clock);
      expect(field.carryTime()).toBe(clock);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Review 5, NIT-2: a frame stamped behind the field's frameTime (a time a
  // carry stepped at that ran ahead of it, or a clock that went back) is
  // still that frame: frameTime follows it, so hold() still tells a member
  // above that is still to step from one that has (the floor read from it
  // marked e crossing on every frame of the head-to-bottom glide, review 4),
  // and no step runs backwards on a negative dt. In either frame order.
  it.each((['ahead', 'back'] as const).flatMap((how) => [2, 6, 10, 14].flatMap((at) => [[how, at, false], [how, at, true]] as const)))('a frame stamped behind frameTime (%s, %s frames into the glide) is still its own frame: the head-to-bottom glide keeps its step and marks only the carry (review 5, NIT-2; reversed: %s)', (how, k0, reversed) => {
    const bound = springSteps();
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      dragHeld('n2', { x: 400, y: 283 });
      settle(800);
      reverseFrames = reversed;
      dragFrames('n2', [{ x: 400, y: 284 }], () => {});
      for (let i = 0; i < k0; i += 1) frame();
      const field = fieldOf() as unknown as { frameTime: number };
      if (how === 'ahead') field.frameTime = clock + 50;
      else clock -= 40;
      const to = { d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } };
      let prev = where();
      for (let i = 0; i < 60; i += 1) {
        frame();
        const w = where();
        expect(w.e.y - w.d.y, `frame ${i}`).toBeCloseTo(S, 9);
        expect(['d', 'e'].filter((k) => byKey(k).dataset.crossing === 'true'), `frame ${i}`).toEqual([]);
        // Never more than the spring's step.
        for (const k of ['a', 'd', 'e'] as const) {
          expect(Math.abs(w[k].y - prev[k].y), `${k} frame ${i}`).toBeLessThanOrEqual(bound[k] * 1.02);
        }
        prev = w;
      }
      expect(where()).toEqual(to);
    } finally {
      vi.useRealTimers();
    }
  });

  // And the case the stale-floor guard is for (review 4, drag LOW-1): the
  // hand back to the head k frames into the glide, each frame's callbacks in
  // reverse order, with frames stamped behind frameTime from there on.
  it.each([0, 1, 2, 3].flatMap((k) => [[k, 'ahead'], [k, 'back']] as const))('the hand crosses back %s frames into the glide, frames stamped behind frameTime (%s): no frame moves a cursor more than its spring step (review 5, NIT-2)', (k, how) => {
    const bound = springSteps();
    fakeTimers();
    reverseFrames = true;
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      let prev = where();
      const worst: Record<string, number> = { a: 0, d: 0, e: 0 };
      const rec = () => {
        const w = where();
        for (const key of ['a', 'd', 'e']) worst[key] = Math.max(worst[key], Math.abs(w[key].y - prev[key].y));
        prev = w;
      };
      for (let i = 0; i < k; i += 1) { frame(); rec(); }
      const field = fieldOf() as unknown as { frameTime: number };
      if (how === 'ahead') field.frameTime = clock + 50;
      else clock -= 40;
      dragFrames('n2', [{ x: 400, y: 283 }], rec);
      for (let i = 0; i < 80; i += 1) { frame(); rec(); }
      for (const key of ['a', 'd', 'e']) expect(worst[key], `${key} at k=${k}`).toBeLessThanOrEqual(bound[key] * 1.02);
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 5, LOW-1 and LOW-2 (R5PROBE_A, kept): r65's head-to-bottom move,
  // then the hand straight back to the head with each frame's callbacks in
  // reverse order: d is marked crossing at rest (r89). Then 1 s with no
  // frames (a stall, a hidden tab), or a replay of a's event meanwhile:
  // a lands on its caught-up frame, or snaps to its spot, and neither went
  // through holdBelow, so d kept its mark (and its order z-index) at
  // rest with no frame of its own to end it.
  it.each(['stall', 'replay'] as const)('a member marked crossing at rest loses its mark when the one above lands on a %s (review 5, LOW-1 and LOW-2)', (how) => {
    fakeTimers();
    reverseFrames = true;
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      const field = fieldOf() as unknown as { motions: Map<string, { landing: unknown; plan: unknown }>; placers: Map<string, () => void> };
      const keyOf = (c: string) => [...field.placers.keys()].find((x) => x.endsWith(c.repeat(12)))!;
      dragFrames('n2', [{ x: 400, y: 283 }], () => {});
      let found = '';
      for (let i = 0; i < 40 && !found; i += 1) {
        for (const c of ['d', 'e']) {
          const m = field.motions.get(keyOf(c));
          if (byKey(c).dataset.crossing === 'true' && m && !m.landing && !m.plan) found = c;
        }
        if (!found) frame();
      }
      // The case: a member at rest, marked.
      expect(found).toBe('d');
      act(() => { vi.advanceTimersByTime(1000); });
      clock += 1000;
      if (how === 'replay') {
        act(() => { useAgentPresenceStore.getState().apply({ ...event({ ...session('a', 3), target: { nodeId: 'n2' }, since: 500 }), replay: true, secondsAgo: 0 } as never); });
      }
      tickFrames(1);
      for (let i = 0; i < 30; i += 1) frame();
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
      expect(frames.length).toBe(0);
      expect(['a', 'd', 'e'].filter((c) => byKey(c).dataset.crossing === 'true')).toEqual([]);
      expect(cursors().filter((el) => el.style.getPropertyValue('--agent-cursor-crossing-depth') !== '')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r95 (review 5, drag-live LOW-1): the carry dragged back out of the
  // band goes from the bottom slot to the head, past e and then d. Only the
  // member right under a cursor was ever judged crossing, so e, later in the
  // DOM than a, drew over a for a frame or two as a passed it. While a glide
  // lasts the whole column draws in column order, the head on top: a over d
  // over e, whatever the DOM's order; after it, normal order returns.
  /** How this cursor paints against the others in the layer: its z-index
   *  (agentCursor.css: 10 - depth when marked, 11 + rank aloft, else 1), then the
   *  DOM's order. */
  const paintRank = (k: string): [number, number] => {
    const el = byKey(k);
    const marked = el.dataset.crossing === 'true' || el.dataset.columnOrder === 'true';
    const z = el.dataset.aloft === 'true' ? 11 + Number(el.style.getPropertyValue('--agent-cursor-aloft'))
      : marked ? 10 - Number(el.style.getPropertyValue('--agent-cursor-crossing-depth')) : 1;
    return [z, cursors().indexOf(el)];
  };
  const drawnOver = (up: string, down: string) => {
    const [a, b] = [paintRank(up), paintRank(down)];
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  };
  it.each([false, true])('the carry going from the bottom slot back to the head draws over both members it passes, then the column\'s order is back (GM r95; reversed: %s)', (reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      settle(1200);
      expect(where()).toEqual({ d: { x: 500, y: 344 }, e: { x: 500, y: 344 + S }, a: { x: 500, y: 344 + 2 * S } });
      expect(cursors().filter((el) => el.dataset.columnOrder === 'true')).toEqual([]);
      // a before e in the DOM: by DOM order alone e draws over a.
      expect(cursors().indexOf(byKey('a'))).toBeLessThan(cursors().indexOf(byKey('e')));
      reverseFrames = reversed;
      let passing = 0;
      let ordered = 0;
      const check = (label: string) => {
        const w = where();
        if (byKey('a').dataset.columnOrder === 'true') ordered += 1;
        // Wherever a's label is within a step of a member's, a draws over it.
        for (const k of ['d', 'e']) {
          if (Math.abs(w.a.y - w[k].y) < S) {
            passing += 1;
            expect(drawnOver('a', k), `a over ${k} ${label}`).toBe(true);
          }
        }
        if (Math.abs(w.d.y - w.e.y) < S) expect(drawnOver('d', 'e'), `d over e ${label}`).toBe(true);
      };
      dragFrames('n2', [{ x: 400, y: 283 }], () => check('on the drag frame'));
      for (let i = 0; i < 90; i += 1) { frame(); check(`frame ${i}`); }
      expect(where()).toEqual({ a: { x: 500, y: 327 }, d: { x: 500, y: 327 + S }, e: { x: 500, y: 327 + 2 * S } });
      // It passed both, over several frames, in column order throughout.
      expect(passing).toBeGreaterThan(3);
      expect(ordered).toBeGreaterThan(5);
      // After the glide, normal order returns: no column order, no depth.
      for (const k of ['a', 'd', 'e']) {
        expect(byKey(k).dataset.columnOrder, k).toBeUndefined();
        expect(byKey(k).dataset.crossing, k).toBeUndefined();
        expect(byKey(k).style.getPropertyValue('--agent-cursor-crossing-depth'), k).toBe('');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r95's other half: column order is for a column while it glides
  // only. A cursor flying and landing alone, a column at rest, and a flight
  // on its arc into a column draw in plain order (a flight passes over by
  // design).
  it('column order holds only while a member of a column of two or more glides (GM r95)', () => {
    fakeTimers();
    try {
      const view = render(<AgentCursorLayer />);
      const anyOrdered = () => cursors().some((el) => el.dataset.columnOrder === 'true');
      // A cursor alone in its column, flying and landing, with another
      // cursor elsewhere: no column to order.
      send(event({ ...session('h', 6), target: { x: 200, y: 200 } }));
      send(event({ ...session('f', 5), target: { x: 900, y: 600 } }));
      for (let i = 0; i < 10; i += 1) frame();
      send(event({ ...session('f', 5), target: { x: 1100, y: 640 } }));
      for (let i = 0; i < 90; i += 1) { frame(); expect(anyOrdered(), `alone, frame ${i}`).toBe(false); }
      view.unmount();
      useAgentPresenceStore.getState().clear();
      frames = [];
      frameIds = [];
      render(<AgentCursorLayer />);
      intoColumn();
      settle(400);
      expect(anyOrdered()).toBe(false);
      // A flight into the column: its arc orders nothing; its landing glide may.
      send(event({ ...session('g', 1), agent: { id: 'pair', name: 'Pair', color: '#FF9F43', verified: true }, target: { x: 500, y: 344 }, since: 3000 }));
      for (let i = 0; i < 120; i += 1) {
        frame();
        const p = at(cursors().find((el) => el.dataset.agent === 'pair')!);
        if (Math.hypot(p.x - 500, p.y - (344 + 2 * S)) > 60) expect(anyOrdered(), `g in flight at ${p.x}, ${p.y}`).toBe(false);
      }
      expect(at(cursors().find((el) => el.dataset.agent === 'pair')!)).toEqual({ x: 500, y: 344 + 2 * S });
      // Landed: the column's normal order.
      expect(anyOrdered()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ===== #219 round 3j (review 6, GM r103) =====
  /** The z-index a cursor draws at in the layer (agentCursor.css, r106):
   *  aloft, 11 + its rank; crossing or in column order, 10 - its depth;
   *  else 1. Every wire is at WIRE_Z. */
  const WIRE_Z = 0;
  const zOf = (el: HTMLElement) => {
    if (el.dataset.aloft === 'true') return 11 + Number(el.style.getPropertyValue('--agent-cursor-aloft'));
    if (el.dataset.crossing === 'true' || el.dataset.columnOrder === 'true') return 10 - Number(el.style.getPropertyValue('--agent-cursor-crossing-depth'));
    return 1;
  };
  const pairAgent = { id: 'pair', name: 'Pair', color: '#FF9F43', verified: true };
  type Motions = { motions: Map<string, { landing: unknown; plan: unknown }>; placers: Map<string, () => void>; aloft: Map<string, unknown> };

  // GM r103 (review 6, LOW-1): g flies into the column d, e while d's say
  // makes e glide (on its first frame, or 6 or 12 frames in). While g flies,
  // and after it lands while anything in the column still moves, it draws
  // over every member, every other cursor and every wire; on the first
  // frame the column is at rest it takes the column's order, and never
  // before. Either frame order.
  it.each([[0, false], [0, true], [6, false], [6, true], [12, false], [30, true]] as const)('a flight draws over the column for its whole flight and takes column order on the first frame of rest (GM r103; say at %s, reversed: %s)', (sayAt, reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      settle(400);
      reverseFrames = reversed;
      const field = fieldOf() as unknown as Motions;
      send(event({ ...session('g', 1), agent: pairAgent, target: { x: 500, y: 344 }, since: 3000 }));
      const g = () => cursors().find((el) => el.dataset.agent === 'pair')!;
      const gKey = [...field.placers.keys()].find((x) => !['a', 'd', 'e'].some((c) => x.endsWith(c.repeat(12))))!;
      let flew = 0;
      let restAt = -1;
      for (let i = 0; i < 120; i += 1) {
        if (i === sayAt) send(event({ ...session('d', 1), target: { x: 500, y: 344 }, since: 1000, say: 'Looking at the prompt node now' }));
        frame();
        const mine = field.motions.get(gKey)!;
        const moving = [...field.motions.values()].some((m) => m.plan !== null || m.landing !== null);
        if (moving || restAt < 0 && (mine.plan !== null || mine.landing !== null)) {
          if (mine.plan !== null) flew += 1;
          // On top: over every other cursor, and over every wire (auto).
          expect(g().dataset.aloft, `frame ${i}`).toBe('true');
          expect(zOf(g()), `frame ${i}`).toBeGreaterThan(10);
          for (const el of cursors()) if (el !== g()) expect(zOf(g()), `over ${el.dataset.session} frame ${i}`).toBeGreaterThan(zOf(el));
          expect(g().dataset.columnOrder, `frame ${i}`).toBeUndefined();
          expect(g().dataset.crossing, `frame ${i}`).toBeUndefined();
        } else {
          if (restAt < 0) restAt = i;
          // From the first frame of rest: its column-order z, the column's
          // normal order with nothing gliding.
          expect(g().dataset.aloft, `frame ${i}`).toBeUndefined();
          expect(g().style.getPropertyValue('--agent-cursor-aloft'), `frame ${i}`).toBe('');
          expect(zOf(g()), `frame ${i}`).toBe(1);
        }
      }
      expect(flew).toBeGreaterThan(8);
      expect(restAt).toBeGreaterThan(0);
      expect(field.aloft.size).toBe(0);
      expect(at(g()).y).toBe(at(byKey('e')).y + S);
    } finally {
      vi.useRealTimers();
    }
  });

  // GM r103 item 3: two flights that overlap, the later-started one on top,
  // whatever their DOM order.
  it.each([false, true])('of two overlapping flights the later-started one draws on top (GM r103; reversed: %s)', (reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      const h = { id: 'h', name: 'Hal', color: '#4F8EF7', verified: true };
      const f = { id: 'f', name: 'Fay', color: '#FF9F43', verified: true };
      const el = (id: string) => cursors().find((c) => c.dataset.agent === id)!;
      send(event({ agent: h, target: { x: 200, y: 200 } }));
      send(event({ agent: f, target: { x: 900, y: 200 } }));
      settle(800);
      expect(cursors().filter((c) => c.dataset.aloft === 'true')).toEqual([]);
      reverseFrames = reversed;
      // h starts first, f a few frames later; they cross mid-way.
      send(event({ agent: h, target: { x: 900, y: 260 } }));
      for (let i = 0; i < 4; i += 1) frame();
      send(event({ agent: f, target: { x: 200, y: 260 } }));
      let both = 0;
      for (let i = 0; i < 90; i += 1) {
        frame();
        if (el('h').dataset.aloft === 'true' && el('f').dataset.aloft === 'true') {
          both += 1;
          expect(zOf(el('f')), `frame ${i}`).toBeGreaterThan(zOf(el('h')));
        }
      }
      expect(both).toBeGreaterThan(5);
      expect(cursors().filter((el) => el.dataset.aloft === 'true')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // And a new event mid-flight starts a new flight: h, flying second, goes
  // under f once f's agent sends it somewhere new.
  it('a new event mid-flight puts that flight on top of one started before it (GM r103)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      const h = { id: 'h', name: 'Hal', color: '#4F8EF7', verified: true };
      const f = { id: 'f', name: 'Fay', color: '#FF9F43', verified: true };
      const el = (id: string) => cursors().find((c) => c.dataset.agent === id)!;
      send(event({ agent: h, target: { x: 200, y: 200 } }));
      send(event({ agent: f, target: { x: 900, y: 200 } }));
      settle(800);
      send(event({ agent: f, target: { x: 200, y: 600 } }));
      for (let i = 0; i < 3; i += 1) frame();
      send(event({ agent: h, target: { x: 900, y: 600 } }));
      for (let i = 0; i < 3; i += 1) frame();
      expect(zOf(el('h'))).toBeGreaterThan(zOf(el('f')));
      send(event({ agent: f, target: { x: 250, y: 650 } }));
      for (let i = 0; i < 3; i += 1) {
        frame();
        expect(el('h').dataset.aloft).toBe('true');
        expect(zOf(el('f')), `frame ${i}`).toBeGreaterThan(zOf(el('h')));
      }
      settle(1500);
      expect(cursors().filter((c) => c.dataset.aloft === 'true')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 6, LOW-3 (R6P_FLIGHT, kept): g's backend arrival is older than
  // d's and e's (two agents sent to one node a moment apart, the far one
  // landing second), so on landing it re-sorts to the head (since 100) or
  // the middle (1500). The members it now sits above wake and glide to
  // their new slots on the layout spring: no frame moves any cursor further
  // than a one-step glide's largest frame. Before, they stayed on their old
  // slots until g reached its own, then jumped 42 px in one frame.
  it.each([[100, false], [100, true], [1500, false], [1500, true]] as const)('a flight landing as an older arrival re-sorts the column with a glide, never a jump (review 6, LOW-3; since %s, reversed: %s)', (since, reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      settle(400);
      reverseFrames = reversed;
      const g = () => cursors().find((el) => el.dataset.agent === 'pair')!;
      send(event({ ...session('g', 1), agent: pairAgent, target: { x: 500, y: 344 }, since }));
      frame();
      const field = fieldOf() as unknown as Motions;
      const gKey = [...field.placers.keys()].find((x) => !['a', 'd', 'e'].some((c) => x.endsWith(c.repeat(12))))!;
      const ys = () => ({ d: at(byKey('d')), e: at(byKey('e')), g: at(g()) });
      let landedAt = -1;
      let prev = ys();
      let worst = 0;
      for (let i = 0; i < 150; i += 1) {
        frame();
        const w = ys();
        if (landedAt < 0 && field.motions.get(gKey)!.plan === null) landedAt = i;
        for (const k of ['d', 'e'] as const) worst = Math.max(worst, Math.abs(w[k].y - prev[k].y));
        prev = w;
      }
      const end = since === 100
        ? { g: 344, d: 344 + S, e: 344 + 2 * S }
        : { d: 344, g: 344 + S, e: 344 + 2 * S };
      expect({ g: prev.g.y, d: prev.d.y, e: prev.e.y }).toEqual(end);
      expect(landedAt).toBeGreaterThan(0);
      // One frame's travel on a one-step glide (the layout spring), with a
      // margin; the jump was a whole step.
      expect(worst).toBeLessThan(S / 3);
      expect(frames.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 6, LOW-2 (R6P_MULTIZOOM, kept): n zoom updates between an
  // agent's event and its cursor's first frame (wheel or pinch input not
  // aligned to rAF). Each carry steps no time, so the first frame shows
  // one frame's step of the flight, never n frames at once.
  it.each([1, 3, 6])('%s zoom updates before a woken cursor\'s first frame move it by the zoom alone (review 6, LOW-2)', (n) => {
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock + 4 + (reads += 0.001));
    try {
      const control = (zooms: number) => {
        const view = render(<AgentCursorLayer />);
        send(event({ ...session('a', 1), target: { x: 300, y: 300 } }));
        flush();
        const x0 = at(byKey('a')).x;
        clock += 2000;
        send(event({ ...session('a', 1), target: { x: 700, y: 300 }, action: 'click' }));
        for (let i = 0; i < zooms; i += 1) { pane.transform = [0, 0, 1 - 0.01 * (i + 1)]; notifyStore(); }
        const xs: number[] = [];
        let rippled = false;
        for (let i = 0; i < 120 && frames.length > 0; i += 1) { tickFrames(1); xs.push(at(byKey('a')).x); if (ripple()) rippled = true; }
        view.unmount();
        useAgentPresenceStore.getState().clear();
        frames = [];
        frameIds = [];
        pane.transform = [0, 0, 1];
        return { first: xs[0] - x0, end: xs[xs.length - 1], rippled, inFlight: xs.filter((x) => x > x0 + 5 && x < 695).length };
      };
      const none = control(0);
      const zoomed = control(n);
      expect(zoomed.rippled).toBe(true);
      expect(zoomed.end).toBe(700);
      expect(zoomed.inFlight).toBeGreaterThan(15);
      // Under two frames' travel of the flight with no zoom.
      expect(zoomed.first).toBeLessThan(2 * none.first);
    } finally {
      vi.restoreAllMocks();
      pane.transform = [0, 0, 1];
    }
  });

  // Review 6, NIT-1 (R6P_GONE, kept): a's node is deleted k frames into
  // r65's head-to-bottom glide. Its loop stops where it is; no crossing
  // mark, column order or place on top outlives it, on any cursor, and no
  // frame is left pending. Either frame order.
  it.each([1, 2, 4, 6, 9, 12, 16].flatMap((k) => [[k, false], [k, true]] as const))('a cursor whose node is deleted %s frames into a glide keeps no crossing or column order (review 6, NIT-1; reversed: %s)', (k, reversed) => {
    fakeTimers();
    reverseFrames = reversed;
    try {
      render(<AgentCursorLayer />);
      headToBottom();
      for (let i = 0; i < k; i += 1) frame();
      const next = new Map(lookupRef.current);
      next.delete('n2');
      lookupRef.current = next;
      notifyStore();
      for (let i = 0; i < 90; i += 1) frame();
      for (const c of ['a', 'd', 'e']) {
        expect(byKey(c).dataset.crossing, c).toBeUndefined();
        expect(byKey(c).dataset.columnOrder, c).toBeUndefined();
        expect(byKey(c).dataset.aloft, c).toBeUndefined();
        expect(byKey(c).style.getPropertyValue('--agent-cursor-crossing-depth'), c).toBe('');
      }
      expect(frames.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // And a flight whose node goes mid-air: it stops there, off the top.
  it('a cursor whose node is deleted mid-flight comes down from on top (review 6, NIT-1)', () => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      settle(400);
      send(event({ ...session('d', 1), target: { nodeId: 'n2' }, since: 1000 }));
      for (let i = 0; i < 4; i += 1) frame();
      expect(byKey('d').dataset.aloft).toBe('true');
      const next = new Map(lookupRef.current);
      next.delete('n2');
      lookupRef.current = next;
      notifyStore();
      for (let i = 0; i < 60; i += 1) frame();
      expect(cursors().filter((el) => el.dataset.aloft || el.dataset.crossing || el.dataset.columnOrder)).toEqual([]);
      expect(frames.length).toBe(0);
      // The node back (an undo): its loop runs again, and its next flight
      // is on top as any is.
      lookupRef.current = lookup;
      notifyStore();
      for (let i = 0; i < 60; i += 1) frame();
      send(event({ ...session('d', 1), target: { x: 900, y: 600 }, since: 1000 }));
      for (let i = 0; i < 3; i += 1) frame();
      expect(byKey('d').dataset.aloft).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  // HIGH-1's other half: the order is read at the store's zoom. d rests and
  // e lands 120 canvas units under it: one column at zoom 0.25 (30 screen
  // px apart), two at 1. At 0.25, while e glides, d draws in column order;
  // at 1 it never does.
  it.each([[0.25, true], [1, false]] as const)('the column order is read at the store\'s zoom (%s: a column: %s) (review 6, drag-live HIGH-1)', (z2, column) => {
    fakeTimers();
    try {
      pane.transform = [0, 0, z2];
      render(<AgentCursorLayer />);
      send(event({ ...session('d', 1), target: { x: 500, y: 300 }, since: 1000 }));
      settle(800);
      send(event({ ...session('e', 2), target: { x: 500, y: 420 }, since: 2000 }));
      let ordered = 0;
      for (let i = 0; i < 120; i += 1) { frame(); if (byKey('d').dataset.columnOrder === 'true') ordered += 1; }
      if (column) expect(ordered).toBeGreaterThan(0);
      else expect(ordered).toBe(0);
    } finally {
      pane.transform = [0, 0, 1];
      vi.useRealTimers();
    }
  });

  // GM r106 ratchet: no cursor's z ever goes under the wire layer, and an
  // ordered column never drops under another column's resting cursor,
  // sampled on every frame of r65's head-to-bottom glide and the carry back
  // to the head, with a cursor of another column (h) resting nearby and a
  // flight (f) crossing the canvas. Either frame order.
  it.each([false, true])('no cursor draws under the wires, and a gliding column never under another column\'s cursor, through a full glide (GM r106; reversed: %s)', (reversed) => {
    fakeTimers();
    try {
      render(<AgentCursorLayer />);
      intoColumn();
      send(event({ agent: { id: 'h', name: 'Hal', color: '#4F8EF7', verified: true }, target: { x: 650, y: 340 } }));
      dragHeld('n2', { x: 400, y: 283 });
      settle(800);
      reverseFrames = reversed;
      let ordered = 0;
      const check = (label: string) => {
        const all = cursors().filter((el) => el.dataset.leaving !== 'true');
        const h = all.find((el) => el.dataset.agent === 'h')!;
        for (const el of all) {
          expect(zOf(el), `${el.dataset.session ?? el.dataset.agent} ${label}`).toBeGreaterThan(WIRE_Z);
          if (el.dataset.columnOrder === 'true') {
            ordered += 1;
            if (h.dataset.aloft !== 'true') expect(zOf(el), `${el.dataset.session} over h ${label}`).toBeGreaterThanOrEqual(zOf(h));
          }
        }
      };
      dragFrames('n2', [{ x: 400, y: 284 }], () => check('to the bottom'));
      for (let i = 0; i < 60; i += 1) { frame(); check(`down ${i}`); }
      send(event({ agent: { id: 'f', name: 'Fay', color: '#FF9F43', verified: true }, target: { x: 100, y: 600 } }));
      dragFrames('n2', [{ x: 400, y: 283 }], () => check('drag'));
      for (let i = 0; i < 90; i += 1) { frame(); check(`back ${i}`); }
      expect(ordered).toBeGreaterThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 6, drag-live HIGH-1 (R6PROBE_P, kept): d rests, e flies in to
  // rest under it, and k frames in the zoom goes to z2 and back. Each view
  // read the column order at its own zoom, set at its own tick: one view
  // ordered the column and repainted the other, which un-ordered it at its
  // older zoom and repainted the first, without end (RangeError). The order
  // is worked out once, at the store's zoom: no throw, and every cursor's
  // marks agree with the one field state.
  it.each([[60, 0.25], [80, 0.25], [120, 0.25], [80, 0.5], [120, 0.4], [200, 0.2]] as const)('two views holding different zooms agree on one column order and never recurse (review 6, drag-live HIGH-1; gap %s, zoom %s)', (gap, z2) => {
    for (const k of [2, 6, 10, 14, 18, 22, 26, 30]) {
      cleanup();
      useAgentPresenceStore.getState().clear();
      frames = [];
      frameIds = [];
      pane.transform = [0, 0, 1];
      try {
        render(<AgentCursorLayer />);
        send(event({ ...session('d', 1), target: { x: 500, y: 300 }, since: 1000 }));
        flush();
        send(event({ ...session('e', 2), target: { x: 900, y: 300 }, since: 2000 }));
        flush();
        send(event({ ...session('e', 2), target: { x: 500, y: 300 + gap }, since: 2000 }));
        const field = fieldOf() as unknown as { ordered: Set<string>; aloft: Map<string, unknown>; placers: Map<string, () => void> };
        const agree = (label: string) => {
          for (const key of field.placers.keys()) {
            const el = cursors().find((c) => key.endsWith(c.dataset.session ?? '\0'))!;
            const shown = el.dataset.columnOrder === 'true';
            const want = field.ordered.has(key) && !field.aloft.has(key);
            expect(shown, `${key.slice(-1)} k=${k} ${label}`).toBe(want);
          }
        };
        expect(() => {
          for (let i = 0; i < k; i += 1) tickFrames(1);
          pane.transform = [0, 0, z2];
          notifyStore();
          agree('zoomed');
          for (let i = 0; i < 10 && frames.length > 0; i += 1) { tickFrames(1); agree(`out ${i}`); }
          pane.transform = [0, 0, 1];
          notifyStore();
          for (let i = 0; i < 10 && frames.length > 0; i += 1) { tickFrames(1); agree(`back ${i}`); }
          flush();
        }, `k=${k}`).not.toThrow();
        expect(cursors().length, `k=${k}`).toBe(2);
      } finally {
        pane.transform = [0, 0, 1];
      }
    }
  });

  // HIGH-1's ratchet, on the source: apply() and the marks it paints reach
  // no CursorField method that calls a view back (placers or markers), save
  // syncOrder, which repaints through markers only (they read the field's
  // state) and returns at once when re-entered.
  it('no field method that calls views back can be reached again from apply (review 6, drag-live HIGH-1)', () => {
    const src = readFileSync(resolve(__dirname, '../src/components/canvas/AgentCursorLayer.tsx'), 'utf8');
    const cls = src.slice(src.indexOf('class CursorField {'), src.indexOf('\n}\n', src.indexOf('class CursorField {')));
    const methods = [...cls.matchAll(/\n {2}(?:private |readonly )?([a-zA-Z]+)\([^)]*\)(?::[^{\n]+)? \{\n([\s\S]*?)\n {2}\}\n/g)].map((m) => ({ name: m[1], body: m[2] }));
    expect(methods.length).toBeGreaterThan(20);
    const callsBack = new Set(methods.filter((m) => /\.(placers|markers)\.get\(/.test(m.body) || /this\.wakeAll\(/.test(m.body)).map((m) => m.name));
    // Grow it through the field's own calls.
    for (let grew = true; grew;) {
      grew = false;
      for (const m of methods) {
        if (callsBack.has(m.name)) continue;
        if ([...callsBack].some((n) => new RegExp(`this\\.${n}\\(`).test(m.body))) { callsBack.add(m.name); grew = true; }
      }
    }
    expect(callsBack.has('syncOrder')).toBe(true);
    const body = (start: string) => {
      const at = src.indexOf(start);
      expect(at, start).toBeGreaterThan(0);
      return src.slice(at, src.indexOf('\n    };\n', at));
    };
    const apply = body('    const apply = () => {');
    const paint = body('    const paintMarks = () => {');
    for (const name of callsBack) {
      expect(paint, `paintMarks calls field.${name}`).not.toMatch(new RegExp(`field\\.${name}\\(`));
      if (name !== 'syncOrder') expect(apply, `apply calls field.${name}`).not.toMatch(new RegExp(`field\\.${name}\\(`));
    }
    // syncOrder calls back through markers only, and guards re-entry.
    const sync = methods.find((m) => m.name === 'syncOrder')!.body;
    expect(sync).not.toMatch(/placers/);
    expect(sync).toMatch(/if \(this\.syncing\) return;/);
  });

  it('the count cursor never draws its own say; its member\'s say is in the log only (r18, review 8 V2)', () => {
    render(<AgentCursorLayer />);
    column(['a', 'b', 'c', 'd']);
    const said = event({ ...session('c', 3), target: { nodeId: 'n1' }, say: 'Counting along' });
    send(said);
    flush();
    const c = byKey('c');
    expect(c.dataset.count).toBe('2');
    expect(c.querySelector('.agent-cursor__say')).toBeNull();
    expect(agentActionEntry(said)!.message).toBe('Counting along');
  });
});
