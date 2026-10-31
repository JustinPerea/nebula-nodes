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
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, 1] }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: lookup, transform: [0, 0, 1], domNode: null }), subscribe: () => () => {} }),
}));

import { AgentCursorLayer } from '../src/components/canvas/AgentCursorLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';

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
