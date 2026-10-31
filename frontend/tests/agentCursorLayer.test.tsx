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
  const state = { dom: null as HTMLElement | null, api: null as unknown };
  state.api = {
    getState: () => ({ nodeLookup: lookupRef.current, transform: [0, 0, 1], domNode: state.dom }),
    subscribe: () => () => {},
  };
  return state;
});
const lookupRef = vi.hoisted(() => ({ current: new Map() as Map<string, unknown> }));
lookupRef.current = lookup;
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, 1] }),
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
let clock = 0;
/** Run animation frames 1/60 s apart until none is asked for (or the cap). */
const flush = (max = 400) => act(() => {
  for (let i = 0; i < max && frames.length > 0; i += 1) {
    const run = frames;
    frames = [];
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
  clock = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useAgentPresenceStore.getState().clear();
  reduceMotion(false);
  pane.dom = null;
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

