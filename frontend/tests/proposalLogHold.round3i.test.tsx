import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import {
  LOG_CARD_FOLD_DESCRIPTION,
  LOG_HOLD_ATTR,
  LOG_SQUEEZE_VAR,
  applyNoticeStack,
  type StackPlace,
} from '../src/lib/noticeStackPlace';
import { useUIStore } from '../src/store/uiStore';

/**
 * GM - Design, PR #216 r11: a floating log gives way held at the edge away
 * from the card (the top with the card under it, the bottom with the card
 * above it), and springs back from that edge when the card leaves; a
 * collapse the person makes wins over the card's give; and the card's fold
 * never reads as the person's collapse.
 */
const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const root = () => document.documentElement;
const ui = () => useUIStore.getState();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  root().removeAttribute(LOG_HOLD_ATTR);
  root().style.removeProperty(LOG_SQUEEZE_VAR);
  window.localStorage.removeItem('nebula:agentLog:pos');
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none' } as never);
  document.body.innerHTML = '';
});

describe('the held edge, written by the region', () => {
  const place = (over: Partial<StackPlace>): StackPlace => ({
    aboveLog: false, lift: 0, cap: 200, mode: 'under', folded: 0, fold: [], more: 0, moreHost: -1, expanded: false,
    keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0, ...over,
  });
  const dom = () => {
    document.body.innerHTML = '<div data-notice-region=""><div class="notice-region__stack"></div></div>';
    return {
      region: document.querySelector<HTMLElement>('[data-notice-region]')!,
      stack: document.querySelector<HTMLElement>('.notice-region__stack')!,
    };
  };

  it('names the edge while the log gives, and keeps it after, so it springs back from there', () => {
    const { region, stack } = dom();
    applyNoticeStack(region, stack, place({ squeeze: 40, hold: 'top', float: 'under' }));
    expect(root().getAttribute(LOG_HOLD_ATTR)).toBe('top');
    expect(root().style.getPropertyValue(LOG_SQUEEZE_VAR)).toBe('40px');
    // The card leaves: the give goes, the edge stays.
    applyNoticeStack(region, stack, place({ squeeze: 0, hold: null }));
    expect(root().style.getPropertyValue(LOG_SQUEEZE_VAR)).toBe('');
    expect(root().getAttribute(LOG_HOLD_ATTR)).toBe('top');
    applyNoticeStack(region, stack, place({ squeeze: 20, hold: 'bottom', float: 'above' }));
    expect(root().getAttribute(LOG_HOLD_ATTR)).toBe('bottom');
  });
});

describe('a floating log held at its top edge (the card under it)', () => {
  // Its box as layouts.css draws it: pinned by its bottom edge at 480, its
  // height natural - squeeze; held at its top, moved up by what it gives.
  const BOTTOM = 480, NATURAL = 180;
  const setup = () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('agent-log')) return rect(0, 0, 0, 0);
      const squeeze = Number.parseFloat(root().style.getPropertyValue(LOG_SQUEEZE_VAR)) || 0;
      const h = NATURAL - squeeze;
      const shift = root().getAttribute(LOG_HOLD_ATTR) === 'top' && this.dataset.floating === 'bottom' ? h - NATURAL : 0;
      return rect(300, 640, BOTTOM - h + shift, BOTTOM + shift);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-log') ? NATURAL : 0;
    });
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 300, top: BOTTOM - NATURAL, offsetY: 640 - BOTTOM, anchorX: 'left', anchorY: 'bottom' }));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
  };

  it('reads the box it has with no give from its held top edge, so the card under it never moves it', () => {
    setup();
    const { container } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    expect(log.dataset.floating).toBe('bottom');
    const box = () => [root().style.getPropertyValue('--agent-log-float-top'), root().style.getPropertyValue('--agent-log-float-bottom')];
    act(() => { log.style.height = `${NATURAL}px`; window.dispatchEvent(new Event('resize')); });
    const open = box();
    expect(open).toEqual([`${BOTTOM - NATURAL}px`, `${BOTTOM}px`]);
    // Giving way under the card: its top stays, its bottom comes up.
    act(() => {
      root().setAttribute(LOG_HOLD_ATTR, 'top');
      root().style.setProperty(LOG_SQUEEZE_VAR, '89px');
      window.dispatchEvent(new Event('resize'));
    });
    expect(log.getBoundingClientRect().top).toBe(BOTTOM - NATURAL);
    expect(box()).toEqual(open);
    // Held at its bottom instead (the card above it): the same box.
    act(() => {
      root().setAttribute(LOG_HOLD_ATTR, 'bottom');
      window.dispatchEvent(new Event('resize'));
    });
    expect(box()).toEqual(open);
  });
});

describe('the person\'s collapse wins over the card\'s give (uiStore)', () => {
  it('a log the person collapsed while it gave way stays collapsed when the card leaves', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    // The card squeezes it (no hold), then the person collapses it.
    ui().holdAgentLogForCard(false, true);
    ui().setAgentLogOpen(false);
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
  });

  it('a log the card folded never counts as the person\'s collapse: it reopens when the card leaves', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    ui().holdAgentLogForCard(true, true);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'card' });
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'none' });
    // The person collapsing it after: theirs from then on.
    ui().setAgentLogOpen(false);
    ui().holdAgentLogForCard(true, true);
    ui().holdAgentLogForCard(false, false);
    expect(ui()).toMatchObject({ agentLogOpen: false, agentLogCardHold: 'none' });
  });

  it('the card\'s fold reads as the card\'s in the accessibility tree, the person\'s collapse as a plain collapse', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container } = render(<AgentLog />);
    const header = () => container.querySelector<HTMLElement>('.agent-log__header')!;
    expect(header().hasAttribute('aria-description')).toBe(false);
    act(() => ui().holdAgentLogForCard(true, true));
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(header().getAttribute('aria-description')).toBe(LOG_CARD_FOLD_DESCRIPTION);
    act(() => ui().holdAgentLogForCard(false, false));
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(header().hasAttribute('aria-description')).toBe(false);
    act(() => ui().setAgentLogOpen(false));
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(header().hasAttribute('aria-description')).toBe(false);
  });
});

describe('the held edge and the spring back, in CSS (GM r11)', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
  };

  it('held at the bottom (the card above), a top-pinned log moves down by what it gives', () => {
    expect(rule(':root:not([data-agent-log-hold="top"]) .agent-log.agent-log--open[data-floating="top"]'))
      .toBe('translate: 0 calc(var(--agent-log-natural-h, 0px) - var(--agent-log-shown-h));');
    expect(rule(':root:not([data-agent-log-hold="top"]) .agent-log[data-card-collapsed][data-floating="top"]'))
      .toBe('translate: 0 calc(var(--agent-log-natural-h, 0px) - var(--agent-h-closed));');
  });

  it('held at the top (the card under), a bottom-pinned log moves up by what it gives', () => {
    expect(rule(':root[data-agent-log-hold="top"] .agent-log.agent-log--open[data-floating="bottom"]'))
      .toBe('translate: 0 calc(var(--agent-log-shown-h) - var(--agent-log-natural-h, 0px));');
    expect(rule(':root[data-agent-log-hold="top"] .agent-log[data-card-collapsed][data-floating="bottom"]'))
      .toBe('translate: 0 calc(var(--agent-h-closed) - var(--agent-log-natural-h, 0px));');
    // Nothing else moves a log: the other pinnings keep their edge already.
    expect(css.match(/translate: 0 calc\(var\(--agent/g)).toHaveLength(4);
  });

  it('collapsed for the card it has given all but its header, so it reopens on the tuned spring from there', () => {
    expect(rule('.agent-log[data-card-collapsed]')).toBe('--agent-log-give: calc(var(--agent-log-natural-h, 0px) - var(--agent-h-closed));');
    const open = /\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\] \{([^}]*)\}/.exec(css)![1].replace(/\s+/g, ' ');
    expect(open).toContain('--agent-log-shown-h: clamp(var(--agent-h-closed),');
    expect(open).toContain('transition: --agent-log-give 420ms var(--agent-log-spring);');
    // The resize floor gives way only below it, while it springs back up.
    expect(open).toContain('min-height: min(80px, var(--agent-log-shown-h));');
    // The project's spring, a linear() with overshoot, not a stock ease.
    expect(css).toMatch(/--agent-log-spring: linear\(0, [^)]*1\.022[^)]*, 1\);/);
  });
});
