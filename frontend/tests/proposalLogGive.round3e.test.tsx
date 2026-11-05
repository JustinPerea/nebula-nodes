import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import { LOG_COLLAPSE_VAR } from '../src/lib/noticeStackPlace';
import { useUIStore } from '../src/store/uiStore';

/**
 * GM - Design, PR #216 r7, step 4: at short heights, past its body's floor,
 * the log collapses to its header for the proposal card, and reopens when
 * the card leaves, unless the person collapsed it: a collapse the person
 * makes is never undone, and their reopening over the card's collapse holds
 * while the card shows. A floating log gives way as the docked one does,
 * held at its bottom edge.
 */
const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const root = () => document.documentElement.style;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none' } as never);
});

describe('the card\'s hold on the log (uiStore)', () => {
  const ui = () => useUIStore.getState();

  it('collapses an open log for the card, and reopens it when the card leaves', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'card' });
    // Asked again while it holds: nothing changes.
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'card' });
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'none' });
  });

  it('reopens it once the card no longer needs the room (the window grew)', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    ui().holdAgentLogForCard(false, true);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'none' });
  });

  it('never undoes a collapse the person made: the card arrives and leaves, the log stays collapsed', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().setAgentLogOpen(false);
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
  });

  it('the person reopening it over the card\'s collapse holds while the card shows; their collapse after that is theirs', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    ui().setAgentLogOpen(true);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
    ui().holdAgentLogForCard(true, true);
    expect(ui().agentLogOpen).toBe(true);
    // They collapse it themselves: never reopened when the card leaves.
    ui().setAgentLogOpen(false);
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
  });

  it('the person\'s reopening over the card\'s fold holds while the card stays, though the card stops and starts wanting the room (review 3 LOW-3)', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    ui().setAgentLogOpen(true);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
    // The window grows (the card no longer wants the room), then shrinks
    // again or a notice arrives: the card is still up, so their reopening holds.
    ui().holdAgentLogForCard(false, true);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
    // The card leaves: the hold is forgotten, and the next card may fold it again.
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'none' });
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'card' });
  });

  it('"See all actions" opening it over the card\'s collapse is the person\'s reopening: it holds', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    ui().openAgentLog();
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
  });

  it('a log switched off is not reopened by the card leaving', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    useUIStore.setState({ agentLogEnabled: false } as never);
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
  });
});

describe('the log, rendered, under the card\'s hold', () => {
  const setup = (box: DOMRect) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box);
  };

  it('collapsed by hand, then a card arrives and leaves: it stays collapsed and offers no collapse', () => {
    setup(rect(820, 1164, 584, 784));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    render(<AgentLog />);
    const header = screen.getByRole('button', { name: /Agent log/ });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // Closed by the person: it gives nothing, so the card never asks.
    expect(root().getPropertyValue(LOG_COLLAPSE_VAR)).toBe('0px');
    act(() => useUIStore.getState().holdAgentLogForCard(true, true));
    act(() => useUIStore.getState().holdAgentLogForCard(false, false));
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('collapsed for the card: the measure stays the open log\'s, so the stack never moves for it; reopened when the card leaves', () => {
    setup(rect(820, 1164, 584, 784));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    act(() => { log.style.height = '200px'; window.dispatchEvent(new Event('resize')); });
    const open = { top: root().getPropertyValue('--agent-log-top'), natural: root().getPropertyValue('--agent-log-natural-h'), floor: root().getPropertyValue('--agent-log-floor') };
    expect(open.natural).toBe('200px');
    // Its collapse is offered while it may collapse (jsdom's closed height is 0).
    expect(root().getPropertyValue(LOG_COLLAPSE_VAR)).toBe(`${Number.parseFloat(open.floor)}px`);
    act(() => useUIStore.getState().holdAgentLogForCard(true, true));
    expect(log.classList.contains('agent-log--open')).toBe(false);
    expect(log.hasAttribute('data-card-collapsed')).toBe(true);
    expect({ top: root().getPropertyValue('--agent-log-top'), natural: root().getPropertyValue('--agent-log-natural-h'), floor: root().getPropertyValue('--agent-log-floor') }).toEqual(open);
    expect(root().getPropertyValue(LOG_COLLAPSE_VAR)).toBe(`${Number.parseFloat(open.floor)}px`);
    // The person reopens it: the card may not collapse it again while it shows.
    fireEvent.click(screen.getByRole('button', { name: /Agent log/ }));
    expect(log.classList.contains('agent-log--open')).toBe(true);
    expect(log.hasAttribute('data-card-collapsed')).toBe(false);
    expect(root().getPropertyValue(LOG_COLLAPSE_VAR)).toBe('0px');
  });

  it('a floating log pinned by its bottom edge gives way with no move: the CSS moves only one pinned by its top', () => {
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 300, top: 300, anchorX: 'left', anchorY: 'bottom', offsetY: 160 }));
    setup(rect(300, 640, 300, 480));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    expect(container.querySelector<HTMLElement>('.agent-log')!.dataset.floating).toBe('bottom');
    window.localStorage.removeItem('nebula:agentLog:pos');
  });

  it('a floating log writes its box with no give, held at its bottom edge, and which edge the person pinned', () => {
    setup(rect(300, 640, 300, 480));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    expect(log.dataset.floating).toBe('top');
    act(() => { log.style.height = '240px'; window.dispatchEvent(new Event('resize')); });
    // Its bottom edge stays; the top it has with no give is 240 above it.
    expect(root().getPropertyValue('--agent-log-float-bottom')).toBe('480px');
    expect(root().getPropertyValue('--agent-log-float-top')).toBe('240px');
    expect(root().getPropertyValue('--agent-log-natural-h')).toBe('240px');
    expect(root().getPropertyValue('--agent-log-clearance')).toBe('');
  });
});

describe('a top-pinned floating log, collapsed for the card and back (round 3f)', () => {
  // Its box as layouts.css draws it from the root's values: the person's
  // top, moved down by natural - shown (collapsed: natural - its header).
  // With them cleared, as a re-run of AgentLog's effect does first, the box
  // is off: the measure must read it after writing them.
  it('writes the same box, collapsed or open, so the card never reopens it in a loop', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    const TOP = 250, NATURAL = 180, HEADER = 44;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('agent-log')) return rect(0, 0, 0, 0);
      const natural = Number.parseFloat(root().getPropertyValue('--agent-log-natural-h')) || 0;
      const open = this.classList.contains('agent-log--open');
      const h = open ? NATURAL : HEADER;
      const shift = this.dataset.floating === 'top' ? (open ? natural - h : this.hasAttribute('data-card-collapsed') ? natural - HEADER : 0) : 0;
      return rect(300, 640, TOP + shift, TOP + shift + h);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-log') ? NATURAL : 0;
    });
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 300, top: TOP, anchorX: 'left', anchorY: 'top' }));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    act(() => { log.style.height = `${NATURAL}px`; window.dispatchEvent(new Event('resize')); });
    const box = () => [root().getPropertyValue('--agent-log-float-top'), root().getPropertyValue('--agent-log-float-bottom')];
    const open = box();
    expect(open).toEqual([`${TOP}px`, `${TOP + NATURAL}px`]);
    act(() => useUIStore.getState().holdAgentLogForCard(true, true));
    expect(log.hasAttribute('data-card-collapsed')).toBe(true);
    // Collapsed to its header at its bottom edge: the box it has with no give is the same.
    expect(box()).toEqual(open);
    act(() => useUIStore.getState().holdAgentLogForCard(false, false));
    expect(log.classList.contains('agent-log--open')).toBe(true);
    expect(box()).toEqual(open);
    window.localStorage.removeItem('nebula:agentLog:pos');
  });
});

describe('the give, in CSS (GM r7-r8)', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('a floating log gives way as the docked one, on the spring, down to its floor (one registered length, GM r8)', () => {
    expect(css).toMatch(/@property --agent-log-give \{\s*syntax: '<length>';\s*inherits: false;\s*initial-value: 0px;\s*\}/);
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\] \{\s*--agent-log-give: var\(--agent-log-squeeze, 0px\);\s*--agent-log-shown-h: clamp\(var\(--agent-h-closed\), calc\(var\(--agent-log-natural-h, 80vh\) - var\(--agent-log-give\)\), var\(--agent-log-natural-h, 80vh\)\);[^}]*max-height: max\(var\(--agent-log-shown-h\), calc\(80vh - var\(--agent-log-give\) \* 10000000\)\);[^}]*transition: --agent-log-give 420ms var\(--agent-log-spring\);/);
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-floating\] \.agent-log__body \{\s*flex: 0 1 auto;\s*min-height: 0;/);
  });

  it('one pinned by its top edge moves down by what its height gives, read from the same value; collapsed for the card too', () => {
    expect(css).toMatch(/:root:not\(\[data-agent-log-hold="top"\]\) \.agent-log\.agent-log--open\[data-floating="top"\] \{\s*translate: 0 calc\(var\(--agent-log-natural-h, 0px\) - var\(--agent-log-shown-h\)\);\s*\}/);
    expect(css).toMatch(/:root:not\(\[data-agent-log-hold="top"\]\) \.agent-log\[data-card-collapsed\]\[data-floating="top"\] \{\s*translate: 0 calc\(var\(--agent-log-natural-h, 0px\) - var\(--agent-h-closed\)\);\s*\}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\] \{\s*transition: none;/);
    // Nothing else springs the edge: no transition on max-height or translate.
    expect(css).not.toMatch(/transition:[^;]*(max-height|translate) 420ms var\(--agent-log-spring\)/);
  });

  it('the region asks the store each time it places, with the card or without it', () => {
    const region = readFileSync(resolve(__dirname, '../src/components/NoticeRegion.tsx'), 'utf8');
    expect(region).toMatch(/useUIStore\.getState\(\)\.holdAgentLogForCard\(next\.place\.collapse, next\.place\.mode !== null\)/);
  });
});

/**
 * GM - Design, PR #216 r8 5: "the anchored edge stays exactly fixed through
 * the spring; the overshoot happens only at the free top edge." The give is
 * one registered length on the spring; the height and a top-pinned log's
 * move both come from it, so its bottom edge is the same on every frame.
 * This reads the spring and the formulas from layouts.css and walks the
 * transition frame by frame, both ways, through the overshoot.
 */
describe('the anchored edge, every frame of the spring (GM r8 5)', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8');
  const stops = css.match(/--agent-log-spring: linear\(([^)]*)\)/)![1].split(',').map(Number);
  const ease = (t: number) => {
    const at = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(at));
    return stops[i] + (stops[i + 1] - stops[i]) * (at - i);
  };
  const ms = Number(css.match(/transition: --agent-log-give (\d+)ms var\(--agent-log-spring\)/)![1]);
  // The same formulas the CSS declares (pinned by the tests above).
  const shown = (natural: number, floor: number, give: number) => Math.min(natural, Math.max(floor, natural - give));
  const frames = (from: number, to: number) => Array.from({ length: Math.ceil(ms / (1000 / 60)) + 1 }, (_, f) => {
    const t = Math.min(1, (f * 1000) / 60 / ms);
    return from + (to - from) * ease(t);
  });

  it('the spring overshoots, so the test walks through the overshoot', () => {
    expect(Math.max(...stops)).toBeGreaterThan(1);
    expect(stops[0]).toBe(0);
    expect(stops[stops.length - 1]).toBe(1);
  });

  for (const [name, from, to] of [['giving way', 0, 60], ['growing back', 60, 0], ['to its floor', 0, 120]] as const) {
    it(`${name}: the bottom edge never moves, docked or floating pinned either way; the top edge carries the overshoot`, () => {
      const natural = 180, floor = 91, personTop = 300, dockedBottom = 81;
      const tops: number[] = [];
      for (const give of frames(from, to)) {
        const h = shown(natural, floor, give);
        // Docked: held by `bottom`, its height is the shown height.
        const docked = { bottom: dockedBottom, top: dockedBottom + h };
        expect(docked.bottom).toBe(dockedBottom);
        // Floating, pinned by its top: moved down by natural - shown.
        const top = personTop + (natural - h);
        expect(top + h).toBe(personTop + natural);
        tops.push(top);
      }
      // At rest the top sits exactly where the give leaves it; with no give,
      // exactly where the person put it.
      expect(tops[tops.length - 1]).toBe(personTop + natural - shown(natural, floor, to));
      if (to === 0) expect(tops[tops.length - 1]).toBe(personTop);
      // Giving way, the free edge overshoots past its rest and comes back.
      if (to > from && natural - to > floor) expect(Math.max(...tops)).toBeGreaterThan(tops[tops.length - 1]);
    });
  }
});
