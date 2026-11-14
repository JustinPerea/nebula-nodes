import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentPresenceEvent } from '../src/lib/wsClient';
import type { Box, ResolverEnv } from '../src/lib/agentAnchorResolve';
import { launcherDots, DOT_FADE_MS, DOT_IDLE_OPACITY, type DotEntry } from '../src/lib/agentLauncherDots';
import { AGENT_CURSOR_DOT } from '../src/lib/agentCursorTuning';
import { AgentScreenLayer } from '../src/components/agent-cursor/AgentScreenLayer';
import { AGENT_CURSOR_EXPIRE_MS, AGENT_CURSOR_IDLE_MS, useAgentPresenceStore } from '../src/store/agentPresenceStore';
import { useBoardCanvasStore } from '../src/store/boardCanvasStore';

/**
 * Phase 3 slice 8: the launcher's activity dot (GM - Design 2). A cursor
 * parked at a launcher (its surface isn't open) puts a 6 px agent-colour dot
 * on it; two agents two dots, three two dots and "+1"; the dot dims at the 20 s
 * idle and goes on exit, a new target or the prune. The screen layer draws it.
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
const RAIL_BOX: Box = { left: 8, top: 300, width: 44, height: 44 };
function put(attr: 'anchor' | 'launcher', value: string, box: Box): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(`data-agent-${attr}`, value);
  document.body.appendChild(el);
  boxes.set(el, box);
  return el;
}
const AGENTS = [
  { id: 'claude', name: 'Claude', color: '#E8825A' },
  { id: 'codex', name: 'Codex', color: '#5A8FE8' },
  { id: 'gem', name: 'Gem', color: '#4CAF50' },
];
const event = (who = 0, overrides: Partial<AgentPresenceEvent> = {}): AgentPresenceEvent => ({
  type: 'agentPresence',
  agent: { ...AGENTS[who], verified: true },
  target: { surface: 'moodboard', itemId: 'b1/i1' },
  anchorNames: { board: 'Desert light', image: 22 },
  action: 'click',
  say: 'Added 3 images to “Desert light”',
  at: who,
  since: who + 1,
  ...overrides,
} as AgentPresenceEvent);
const send = (e: AgentPresenceEvent) => act(() => { useAgentPresenceStore.getState().apply(e); });
const dots = () => [...document.querySelectorAll<HTMLElement>('.agent-launcher-dot:not([data-leaving])')];
const more = () => document.querySelector<HTMLElement>('.agent-launcher-dot__more:not([data-leaving])');
const ghosts = () => [...document.querySelectorAll<HTMLElement>('.agent-launcher-dot[data-leaving], .agent-launcher-dot__more[data-leaving]')];

const realMatchMedia = window.matchMedia;
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('reduce'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null,
    dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  frames = [];
  clock = 0;
  boxes.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  reduceMotion(false);
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

const renderLayer = () => render(<AgentScreenLayer canvasMounted={false} env={env} />);
const settle = () => { flush(); act(() => { vi.advanceTimersByTime(20); }); };

describe('the dot on a launcher (PR #233 slice 8)', () => {
  it('shows a 6 px agent-colour dot once the cursor has landed at the rail, and not before', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    expect(dots()).toHaveLength(0); // flying
    settle();
    expect(dots()).toHaveLength(1);
    const dot = dots()[0];
    expect(dot.style.getPropertyValue('--agent-color')).toBe('#E8825A');
    expect(dot.closest('.agent-launcher-dots')?.getAttribute('aria-hidden')).toBe('true');
    expect(parseFloat(dot.style.left)).toBe(RAIL_BOX.left + RAIL_BOX.width - AGENT_CURSOR_DOT.insetPx);
    expect(parseFloat(dot.style.top)).toBe(RAIL_BOX.top + AGENT_CURSOR_DOT.insetPx);
  });

  it('is a corner badge: the dot and its ring stay within the corner, clear of the glyph\'s box (the middle 20 px of a 40 px button)', () => {
    const { px, ringPx, insetPx, gapPx, maxDots } = AGENT_CURSOR_DOT;
    const reach = insetPx + px / 2 + ringPx; // from the corner, to the far side of the first dot's ring
    expect(reach).toBeLessThan(10); // a 20 px glyph in a 40 px button starts 10 px in
    // Both dots: the far side of the second is within the button's top strip, above the glyph.
    expect(insetPx + (maxDots - 1) * (px + gapPx) + px / 2 + ringPx).toBeLessThan(20);
    // The rings touch but do not overlap.
    expect(gapPx).toBeGreaterThanOrEqual(2 * ringPx);
    expect(px).toBe(6);
  });

  it('is on the board row when the dock is open, the rail when it is not', () => {
    put('launcher', 'moodboard:b1', { left: 900, top: 200, width: 280, height: 40 });
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    settle();
    expect(dots()).toHaveLength(1);
    expect(parseFloat(dots()[0].style.left)).toBe(900 + 280 - AGENT_CURSOR_DOT.insetPx); // the row, not the rail
  });

  it('is not shown for a cursor on its item: no launcher, no dot', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    put('anchor', 'moodboard:b1/i1', { left: 900, top: 300, width: 160, height: 120 });
    renderLayer();
    send(event());
    settle();
    expect(dots()).toHaveLength(0);
  });

  it('two agents give two dots side by side, a ring apart, in arrival order', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event(0));
    send(event(1));
    settle();
    const [a, b] = dots();
    expect(dots()).toHaveLength(2);
    expect(a.style.getPropertyValue('--agent-color')).toBe('#E8825A');
    expect(b.style.getPropertyValue('--agent-color')).toBe('#5A8FE8');
    expect(parseFloat(a.style.left) - parseFloat(b.style.left)).toBe(AGENT_CURSOR_DOT.px + AGENT_CURSOR_DOT.gapPx);
    expect(more()).toBeNull();
  });

  it('three agents give two dots and "+1"', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event(0));
    send(event(1));
    send(event(2));
    settle();
    expect(dots()).toHaveLength(2);
    expect(more()?.textContent).toBe('+1');
  });

  it('the "+1" carries no agent colour: it takes the launcher\'s surface and the neutral count style', () => {
    const rail = put('launcher', 'moodboard', RAIL_BOX);
    rail.style.setProperty('--agent-launcher-surface', 'rgb(24, 24, 26)');
    renderLayer();
    send(event(0));
    send(event(1));
    send(event(2));
    settle();
    const pill = more()!;
    expect(pill.style.getPropertyValue('--agent-color')).toBe('');
    expect(pill.style.color).toBe('');
    expect(pill.style.getPropertyValue('--agent-badge-ring')).toBe('rgb(24, 24, 26)');
    // The dots keep their agents' colours.
    expect(dots()[0].style.getPropertyValue('--agent-color')).not.toBe('');
  });
});

describe('the badge ring takes the launcher\'s own surface colour', () => {
  const ringOf = (el: Element | null) => (el as HTMLElement | null)?.style.getPropertyValue('--agent-badge-ring');
  it('a rail launcher and a dock row each get their own host\'s colour, never the rail\'s on a row', () => {
    const rail = put('launcher', 'moodboard', RAIL_BOX);
    rail.style.setProperty('--agent-launcher-surface', 'rgb(24, 24, 26)');
    const row = put('launcher', 'moodboard:b1', { left: 900, top: 200, width: 280, height: 40 });
    row.style.setProperty('--agent-launcher-surface', 'rgb(26, 26, 26)');
    renderLayer();
    send(event(0, { target: { surface: 'moodboard', itemId: 'b1/i1' } }));
    settle();
    // The row is open, so the cursor's launcher is the row; its ring is the row's colour.
    expect(ringOf(dots()[0])).toBe('rgb(26, 26, 26)');
    cleanup();
    boxes.clear();
    document.body.innerHTML = '';
    useAgentPresenceStore.getState().clear();
    const only = put('launcher', 'moodboard', RAIL_BOX);
    only.style.setProperty('--agent-launcher-surface', 'rgb(24, 24, 26)');
    renderLayer();
    send(event(0));
    settle();
    expect(ringOf(dots()[0])).toBe('rgb(24, 24, 26)');
  });

  it('the "+N" pill carries the same ring, and a host that sets none leaves it to the stylesheet', () => {
    const rail = put('launcher', 'moodboard', RAIL_BOX);
    rail.style.setProperty('--agent-launcher-surface', 'rgb(1, 2, 3)');
    renderLayer();
    send(event(0)); send(event(1)); send(event(2));
    settle();
    expect(ringOf(more())).toBe('rgb(1, 2, 3)');
    rail.style.removeProperty('--agent-launcher-surface');
    act(() => { window.dispatchEvent(new Event('resize')); });
    settle();
    expect(ringOf(dots()[0])).toBe('');
  });

  it('the rail and the dock panel each set the variable, to different colours', () => {
    const read = (file: string) => readFileSync(resolve(__dirname, '../src/styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const value = (css: string, selector: string) => {
      const block = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].find(([, sel]) => sel.trim() === selector);
      return /--agent-launcher-surface:\s*([^;]+);/.exec(block?.[2] ?? '')?.[1].trim();
    };
    const rail = value(read('workspace-rail.css'), '.workspace-rail__shell');
    const dock = value(read('panels.css'), '.panel');
    expect(rail).toBeTruthy();
    expect(dock).toBeTruthy();
    expect(dock).not.toBe(rail);
    expect(value(read('workspace-rail.css'), 'body.app-slava-restraint .workspace-rail__shell')).not.toBe(value(read('slava-restraint.css'), 'body.app-slava-restraint .panel'));
    // The dots layer reads the ring from the variable it sets, never a literal beside the host's.
    const dots = read('agentCursorAnywhere.css');
    expect(dots).toMatch(/box-shadow:\s*0 0 0 1\.5px var\(--agent-badge-ring\)/);
  });
});

describe('the dim, and when the dot goes', () => {
  it('dims with its cursor at the 20 s idle, to the cursor\'s own idle opacity', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    settle();
    expect(dots()[0].style.opacity).toBe('1');
    act(() => { vi.advanceTimersByTime(AGENT_CURSOR_IDLE_MS + 50); });
    expect(dots()[0].style.opacity).toBe(String(DOT_IDLE_OPACITY));
    expect(DOT_IDLE_OPACITY).toBe(0.45);
    // A new event wakes it again.
    send(event(0, { say: 'Added image 4 to “Desert light”' }));
    settle();
    expect(dots()[0].style.opacity).toBe('1');
  });

  it('goes when the cursor is sent to its item (a new target): it fades where it was, then is gone', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    settle();
    expect(dots()).toHaveLength(1);
    put('anchor', 'moodboard:b1/i1', { left: 900, top: 300, width: 160, height: 120 });
    act(() => { document.dispatchEvent(new Event('scroll')); });
    settle();
    expect(dots()).toHaveLength(0);
    expect(ghosts().length).toBe(1);
    expect(ghosts()[0].classList.contains('agent-launcher-dot')).toBe(true);
    act(() => { vi.advanceTimersByTime(DOT_FADE_MS + 20); });
    expect(ghosts()).toHaveLength(0);
  });

  it('goes at the 120 s prune', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    settle();
    act(() => { useAgentPresenceStore.getState().prune(Date.now() + AGENT_CURSOR_EXPIRE_MS + 1); });
    expect(dots()).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(DOT_FADE_MS + 20); });
    expect(ghosts()).toHaveLength(0);
  });

  it('an exiting cursor is not counted: three agents become two dots with no "+N" the moment one leaves, though its cursor still fades', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event(0));
    send(event(1));
    send(event(2));
    settle();
    expect(more()?.textContent).toBe('+1');
    const { agents } = useAgentPresenceStore.getState();
    const gem = Object.keys(agents).find((key) => agents[key].id === 'gem')!;
    act(() => { useAgentPresenceStore.setState({ agents: Object.fromEntries(Object.entries(agents).filter(([key]) => key !== gem)) }); });
    // The leaving cursor is still drawn for its fade...
    expect(document.querySelectorAll('.agent-screen-layer .agent-cursor').length).toBe(3);
    // ...but the dots are already for the two that are left.
    expect(dots().map((d) => d.dataset.agentKey)).not.toContain(gem);
    expect(dots()).toHaveLength(2);
    expect(more()).toBeNull();
  });

  it('a deleted board takes its cursors and their dots (GM 4)', () => {
    put('launcher', 'moodboard:b1', { left: 900, top: 200, width: 280, height: 40 });
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event(0));
    send(event(1));
    settle();
    expect(dots()).toHaveLength(2);
    act(() => { useAgentPresenceStore.setState({ agents: {} }); });
    expect(dots()).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(DOT_FADE_MS + 20); });
    expect(ghosts()).toHaveLength(0);
    expect(document.querySelector('.agent-launcher-dots')).toBeNull();
  });

  it('a dot that left is not an a11y or pointer target', () => {
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    settle();
    expect(document.querySelector('.agent-launcher-dots')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('reduced motion', () => {
  it('the dot goes at once, with no fading ghost', () => {
    reduceMotion(true);
    put('launcher', 'moodboard', RAIL_BOX);
    renderLayer();
    send(event());
    step(2);
    act(() => { vi.advanceTimersByTime(20); });
    expect(dots()).toHaveLength(1);
    act(() => { useAgentPresenceStore.setState({ agents: {} }); });
    expect(dots()).toHaveLength(0);
    expect(ghosts()).toHaveLength(0);
  });
});

describe('the grouping rule (launcherDots)', () => {
  const entry = (key: string, arrivedAt: number): DotEntry => ({ key, color: '#fff', arrivedAt, idle: false, launcher: 'l1',
    box: { left: 0, top: 0, width: 40, height: 40 }, surface: '' });
  it('1 or 2 dots, then two dots and "+N" for the agents without one; earliest first, ties by key', () => {
    expect(launcherDots([entry('a', 1)])[0].dots).toHaveLength(1);
    expect(launcherDots([entry('b', 2), entry('a', 2)])[0].dots.map((d) => d.key)).toEqual(['a', 'b']);
    const three = launcherDots([entry('c', 3), entry('a', 1), entry('b', 2)])[0];
    expect(three.dots.map((d) => d.key)).toEqual(['a', 'b']);
    expect(three.more).toBe(1);
    expect(launcherDots([entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)])[0].more).toBe(2);
  });
});
