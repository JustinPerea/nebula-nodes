import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';

// One React Flow store, as React Flow gives: a pan or zoom sets `transform`, a node drag sets `nodes`.
const flow = vi.hoisted(() => {
  const state = { transform: [0, 0, 1] as number[], nodes: [] as unknown[], listeners: new Set<() => void>() };
  const api = {
    getState: () => ({ transform: state.transform, nodes: state.nodes }),
    subscribe: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  return { state, api };
});
vi.mock('@xyflow/react', async (importOriginal) => ({ ...await importOriginal<typeof import('@xyflow/react')>(), useStoreApi: () => flow.api }));

import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';

/**
 * PR #233 final review, finding 1: a cursor parked beside a Moodboard node on
 * the canvas (data-agent-launcher="moodboard:<board>") follows a React Flow pan,
 * zoom and node drag, which fire no DOM event.
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
const boxes = new Map<Element, Box>();
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => VIEW,
};
const NODE: Box = { left: 600, top: 300, width: 240, height: 160 };
const tipOf = (el: HTMLElement) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
  return m ? { x: +m[1], y: +m[2] } : null;
};
const cursor = () => document.querySelector<HTMLElement>('.agent-screen-layer .agent-cursor')!;
const dot = () => document.querySelector<HTMLElement>('.agent-launcher-dot:not([data-leaving])')!;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  frames = [];
  clock = 0;
  boxes.clear();
  flow.state.transform = [0, 0, 1];
  flow.state.nodes = [];
  flow.state.listeners.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  useAgentPresenceStore.getState().clear();
  useBoardCanvasStore.setState({ studioBoard: null });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
});

const event = (): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target: { surface: 'moodboard', itemId: 'b1/i1' },
  anchorNames: { board: 'Dusk', image: 1 },
  action: 'click',
  say: '',
  at: 0,
} as AgentPresenceEvent);

/** The node's box moved as React Flow would move it, then the store says so. */
function moveNode(to: Box, change: () => void) {
  const el = document.querySelector('[data-agent-launcher="moodboard:b1"]')!;
  boxes.set(el, to);
  act(() => { change(); for (const listener of [...flow.state.listeners]) listener(); });
  flush();
  act(() => { vi.advanceTimersByTime(20); });
}

function parked() {
  const el = document.createElement('div');
  el.setAttribute('data-agent-launcher', 'moodboard:b1');
  document.body.appendChild(el);
  boxes.set(el, NODE);
  render(<AgentScreenLayer canvasMounted={false} env={env} />);
  act(() => { useAgentPresenceStore.getState().apply(event()); });
  flush();
  act(() => { vi.advanceTimersByTime(20); });
  return { tip: tipOf(cursor())!, dotLeft: parseFloat(dot().style.left) };
}

describe('a cursor parked at a Moodboard node follows the canvas (final review 1)', () => {
  it('follows a pan', () => {
    const before = parked();
    moveNode({ ...NODE, left: NODE.left - 400 }, () => { flow.state.transform = [-400, 0, 1]; });
    expect(tipOf(cursor())!.x).toBeCloseTo(before.tip.x - 400, 0);
    expect(parseFloat(dot().style.left)).toBeCloseTo(before.dotLeft - 400, 0);
  });

  it('follows a zoom', () => {
    const before = parked();
    moveNode({ left: 300, top: 150, width: 120, height: 80 }, () => { flow.state.transform = [0, 0, 0.5]; });
    expect(tipOf(cursor())!.x).toBeLessThan(before.tip.x - 100);
    expect(parseFloat(dot().style.left)).toBeLessThan(before.dotLeft - 100);
  });

  it('follows a node drag', () => {
    const before = parked();
    moveNode({ ...NODE, top: NODE.top + 250 }, () => { flow.state.nodes = [{ id: 'm1', position: { x: 0, y: 250 } }]; });
    expect(tipOf(cursor())!.y).toBeCloseTo(before.tip.y + 250, 0);
    expect(parseFloat(dot().style.top)).toBeGreaterThan(NODE.top + 200);
  });

  it('wakes once a frame however many store changes land in it', () => {
    parked();
    const requested = vi.fn(requestAnimationFrame);
    vi.stubGlobal('requestAnimationFrame', requested);
    act(() => {
      for (let i = 1; i <= 5; i += 1) {
        flow.state.transform = [i, 0, 1];
        for (const listener of [...flow.state.listeners]) listener();
      }
    });
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it('ignores store changes that moved nothing', () => {
    parked();
    const requested = vi.fn(requestAnimationFrame);
    vi.stubGlobal('requestAnimationFrame', requested);
    act(() => { for (const listener of [...flow.state.listeners]) listener(); });
    expect(requested).not.toHaveBeenCalled();
  });
});
