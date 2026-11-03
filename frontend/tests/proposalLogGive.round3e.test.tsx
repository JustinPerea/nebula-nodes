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

describe('the give, in CSS (GM r7)', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('a floating log gives way as the docked one, on the spring, down to its floor', () => {
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\] \{[^}]*max-height: max\(var\(--agent-log-floor, 0px\), calc\(var\(--agent-log-natural-h, 80vh\) - var\(--agent-log-squeeze, 0px\)\)\);[^}]*transition: max-height 420ms var\(--agent-log-spring\), translate 420ms var\(--agent-log-spring\);/);
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-floating\] \.agent-log__body \{\s*flex: 0 1 auto;\s*min-height: 0;/);
  });

  it('one pinned by its top edge moves down by what it gives, so its bottom edge stays; collapsed for the card too', () => {
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-floating="top"\] \{\s*translate: 0 calc\(var\(--agent-log-natural-h, 0px\) - max\(var\(--agent-log-floor, 0px\), calc\(var\(--agent-log-natural-h, 0px\) - var\(--agent-log-squeeze, 0px\)\)\)\);/);
    expect(css).toMatch(/\.agent-log\[data-card-collapsed\]\[data-floating="top"\] \{\s*translate: 0 calc\(var\(--agent-log-natural-h, 0px\) - var\(--agent-h-closed\)\);/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\],\s*\.agent-log\[data-card-collapsed\]\[data-floating="top"\] \{\s*transition: none;/);
  });

  it('the region asks the store each time it places, with the card or without it', () => {
    const region = readFileSync(resolve(__dirname, '../src/components/NoticeRegion.tsx'), 'utf8');
    expect(region).toMatch(/useUIStore\.getState\(\)\.holdAgentLogForCard\(next\.place\.collapse, next\.place\.mode !== null\)/);
  });
});
