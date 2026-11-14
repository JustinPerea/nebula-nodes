import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';
import { HEADER_ICON_X } from '../src/lib/agentCursorMotion';
import { AGENT_CURSOR_DOT } from '../src/lib/agentCursorTuning';

// A React Flow store with one node (what canvasSpace reads), over a pane at the window's origin.
const flow = vi.hoisted(() => {
  const pane = document.createElement('div');
  pane.getBoundingClientRect = () => new DOMRect(0, 0, 1440, 900);
  const nodes = new Map<string, unknown>([['n7', { internals: { positionAbsolute: { x: 600, y: 300 } }, measured: { width: 240, height: 200 } }]]);
  const state = { transform: [0, 0, 1] as number[], nodes: [] as unknown[], nodeLookup: nodes, domNode: pane };
  const api = { getState: () => state, subscribe: () => () => {} };
  return { state, api, pane };
});
vi.mock('@xyflow/react', async (importOriginal) => ({ ...await importOriginal<typeof import('@xyflow/react')>(), useStoreApi: () => flow.api }));

import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { useAgentPresenceStore } from '../src/store/agentPresenceStore';

/**
 * PR #243, GM - Design round 1, ruling 2: a Character cursor whose launcher is
 * the Character node on the canvas rests where a look at any canvas node rests
 * (by the node's icon in its header), not 7.5 px right of the node, where the
 * tip touches the output port. The node's corner dot stays.
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
const boxes = new Map<Element, Box>();
const VIEW: Box = { left: 0, top: 0, width: 1440, height: 900 };
const env: ResolverEnv = {
  query: (selector) => Array.from(document.querySelectorAll(selector)),
  measure: (element) => boxes.get(element) ?? null,
  clip: () => VIEW,
};
const NODE: Box = { left: 600, top: 300, width: 240, height: 200 };
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  useAgentPresenceStore.getState().clear();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
  useAgentPresenceStore.getState().clear();
});

const event = (target: AgentPresenceEvent['target'] = { surface: 'character', itemId: 'c1' }): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { id: 'claude', name: 'Claude', color: '#E8825A', verified: true },
  target, anchorNames: { character: 'Mara' }, action: 'look', say: '', at: 0,
} as AgentPresenceEvent);

/** A node on the canvas (`.react-flow__node`, data-id) whose card carries the launcher. */
function canvasNode(launcher: string, nodeId = 'n7') {
  const wrap = document.createElement('div');
  wrap.className = 'react-flow__node';
  wrap.dataset.id = nodeId;
  const card = document.createElement('div');
  card.setAttribute('data-agent-launcher', launcher);
  wrap.append(card);
  document.body.append(wrap);
  boxes.set(card, NODE);
  boxes.set(wrap, NODE);
  return card;
}

function land(target?: AgentPresenceEvent['target']) {
  render(<AgentScreenLayer canvasMounted env={env} />);
  act(() => { useAgentPresenceStore.getState().apply(event(target)); });
  step(600);
  act(() => { vi.advanceTimersByTime(20); });
}

describe('a Character cursor at its canvas node', () => {
  it('rests by the icon in the node\'s header, where a look at any canvas node rests', () => {
    canvasNode('character:c1');
    land();
    // With no layout to read (jsdom), the rest is the fallback: HEADER_ICON_X in, 44 px down. In the app it is
    // the card's own title row, measured (launcherRestPoint, tests/agentCursorGm1.test.ts).
    expect(tipOf(cursor())).toEqual({ x: NODE.left + HEADER_ICON_X, y: NODE.top + 44 });
    // Not beside the node (right edge + the park's gap): the tip would touch the output port.
    expect(tipOf(cursor())!.x).toBeLessThan(NODE.left + NODE.width);
  });

  it('the corner dot stays on the node\'s top right corner', () => {
    canvasNode('character:c1');
    land();
    expect(parseFloat(dot().style.left)).toBeCloseTo(NODE.left + NODE.width - AGENT_CURSOR_DOT.insetPx, 1);
    expect(parseFloat(dot().style.top)).toBeCloseTo(NODE.top + AGENT_CURSOR_DOT.insetPx, 1);
  });

  it('a Moodboard node rests in its header too: beside it the tip touched the same output port', () => {
    canvasNode('moodboard:b1');
    land({ surface: 'moodboard', itemId: 'b1' });
    expect(tipOf(cursor())).toEqual({ x: NODE.left + HEADER_ICON_X, y: NODE.top + 44 });
  });
});
