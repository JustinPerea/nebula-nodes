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

import { AgentCursorLayer } from '../src/components/canvas/AgentCursorLayer';
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
/** Run animation frames 1/60 s apart until none is asked for (or the cap). */
const flush = (max = 400) => act(() => {
  for (let i = 0; i < max && frames.length > 0; i += 1) {
    const run = frames;
    frames = [];
    frameIds = [];
    clock += 1000 / 60;
    for (const callback of run) callback(clock);
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

  it('a node dragged slowly under a landed cursor carries no stamp: the cursor already there keeps the spot (review 2, L2)', () => {
    render(<AgentCursorLayer />);
    const A = { session: { key: 'aaaaaaaaaaaa', ordinal: 1 } };
    const B = { session: { key: 'bbbbbbbbbbbb', ordinal: 2 } };
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
      // B never moves: A, carried toward it, is the one arriving (round 4).
      expect(at(cursors().find((el) => el.dataset.session === 'bbbbbbbbbbbb')!)).toEqual({ x: 800, y: 344 });
    }
    flush();
    const byKey = Object.fromEntries(cursors().map((el) => [el.dataset.session, at(el)]));
    // B was there first: it keeps (800, 344); A, arriving on the dragged node, steps aside.
    expect(byKey.bbbbbbbbbbbb).toEqual({ x: 800, y: 344 });
    expect(byKey.aaaaaaaaaaaa).toEqual({ x: 800, y: 344 + S });
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
  it.each(zoomRuns)('%s, starting one frame after a say: the steps stay in screen px while the column glides, nothing meets', (_name, zoomAt) => {
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
  it('P3 live: the earlier column heads the merge, the later cursors glide under it, nothing jumps (r21)', () => {
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
    expect(where()).toMatchObject({ a: { x: 300, y: 386 }, b: { x: 300, y: 386 + S }, c: { x: 300, y: 386 + 2 * S } });
    expect(byKey('c').dataset.count).toBe('2');
    expect(byKey('d').dataset.collapsed).toBe('true');
    // A 128 px glide on the land spring peaks near 15 px a frame; a jump
    // (the column floor snapping b under a, the bug) is 128 px in one frame
    // and a step that changes far faster than the spring accelerates.
    const step = (k: string, i: number) => path[i][k].y - path[i - 1][k].y;
    for (let i = 1; i < path.length; i += 1) {
      for (const k of ['a', 'b', 'c']) {
        expect(Math.abs(step(k, i))).toBeLessThan(20);
        if (i > 1) expect(Math.abs(step(k, i) - step(k, i - 1))).toBeLessThan(8);
      }
      // b and c glide together, a step apart.
      expect(Math.abs(step('b', i) - step('c', i))).toBeLessThan(1);
    }
    // b glides the 128 px down over many frames.
    expect(path.filter((w) => w.b.y > 301 && w.b.y < 386 + S - 1).length).toBeGreaterThan(8);
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
