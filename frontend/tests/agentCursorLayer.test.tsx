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
import { AGENT_CURSOR_HOVER_SLOP_PX, inkFor, sessionFill } from '../src/lib/agentCursorLook';

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
    expect(cursors()[1].style.transform).toBe('translate(510px, 354px) scale(1)');
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
    expect(before.bbbbbbbbbbbb).toBe('translate(510px, 354px) scale(1)');
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, say: 'Again' }));
    flush();
    expect(where()).toEqual(before);
    send(event({ session: { key: 'bbbbbbbbbbbb', ordinal: 2 }, say: 'Me too' }));
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
    expect(where().bbbbbbbbbbbb).toBe('translate(310px, 310px) scale(1)');
    send(event({ session: { key: 'aaaaaaaaaaaa', ordinal: 1 }, target: { x: 304, y: 300 } }));
    flush();
    // a came first: it is never pushed off its own target. b, 6 px right
    // and 10 down of a's tip, steps on to stay clear of it.
    expect(where().aaaaaaaaaaaa).toBe('translate(304px, 300px) scale(1)');
    expect(where().bbbbbbbbbbbb).toBe('translate(320px, 320px) scale(1)');
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
    expect(byKey.aaaaaaaaaaaa).toEqual({ x: 1010, y: 354 });
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
    expect(where().bbbbbbbbbbbb).toEqual({ x: 320, y: 320 }); // 10 screen px at zoom 0.5
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
    expect(byKey.aaaaaaaaaaaa).toEqual({ x: 810, y: 354 });
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
    expect(where()).toEqual({ bbbbbbbbbbbb: spotOf('n1'), aaaaaaaaaaaa: { x: 510, y: 354 } });
    const frames300 = Math.round(300 / perFrame);
    for (let i = 0; i < frames300; i += 1) {
      // The person's drag (React Flow's dragging flag): carried at any speed.
      moveNode('n1', perFrame, 0, true);
      tickFrames(1);
      const spot = spotOf('n1');
      // Carried: on their spots every frame, the second never on the first's.
      expect(where().bbbbbbbbbbbb).toEqual(spot);
      expect(where().aaaaaaaaaaaa).toEqual({ x: spot.x + 10, y: spot.y + 10 });
    }
    moveNode('n1', 0, 0, false);
    flush();
    const spot = spotOf('n1');
    expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x + 10, y: spot.y + 10 } });
    // And again, back the other way.
    for (let i = 0; i < frames300; i += 1) {
      moveNode('n1', -perFrame, 0);
      tickFrames(1);
    }
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 500, y: 344 }, aaaaaaaaaaaa: { x: 510, y: 354 } });
  });

  it.each([5, 20])('keeps their order when the second one\'s frame runs first, dragged %s px a frame', (perFrame) => {
    render(<AgentCursorLayer />);
    const first = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const second = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...first, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...second, target: { nodeId: 'n1' } }));
    flush();
    // The first speaks again where it is: it now paints, and runs its frame, last.
    send(event({ ...first, target: { nodeId: 'n1' }, action: 'look', say: 'Still here' }));
    flush();
    expect(cursors().map((el) => el.dataset.session)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    for (let i = 0; i < 300 / perFrame; i += 1) {
      moveNode('n1', perFrame, 0);
      tickFrames(1);
      const spot = spotOf('n1');
      expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x + 10, y: spot.y + 10 } });
    }
    flush();
    expect(where()).toEqual({ bbbbbbbbbbbb: { x: 800, y: 344 }, aaaaaaaaaaaa: { x: 810, y: 354 } });
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
    expect(where()).toEqual({ bbbbbbbbbbbb: spot, aaaaaaaaaaaa: { x: spot.x + 10, y: spot.y + 10 } });
  });

  it('a cursor set aside goes back onto its spot on the land spring when the other leaves, not in one jump', () => {
    render(<AgentCursorLayer />);
    const first = { session: { key: 'bbbbbbbbbbbb', ordinal: 1 } };
    const second = { session: { key: 'aaaaaaaaaaaa', ordinal: 2 } };
    send(event({ ...first, target: { nodeId: 'n1' } }));
    flush();
    send(event({ ...second, target: { nodeId: 'n1' } }));
    flush();
    expect(where().aaaaaaaaaaaa).toEqual({ x: 510, y: 354 });
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
    expect(before).toEqual({ claude: { x: 500, y: 344 }, aaaaaaaaaaaa: { x: 510, y: 354 }, bbbbbbbbbbbb: { x: 520, y: 364 } });
    send(pair('aaaaaaaaaaaa', 1, 'look'));
    flush();
    expect(where()).toEqual(before);
  });
});
