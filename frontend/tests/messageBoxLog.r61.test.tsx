import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import {
  HEIGHT_STORAGE_KEY,
  clampLogHeight,
  readStoredHeight,
  resizeEdge,
  resizedHeight,
} from '../src/components/panels/agentLogLayout';
import { useUIStore } from '../src/store/uiStore';
import { usePersonThreadStore } from '../src/store/personThreadStore';
import { cascade } from './helpers/logCascade';

/**
 * GM - Design r61 on #225, answer 1 and fix B, with #216's round 3k rules:
 * the person keeps a resize handle. The open log follows its content up to
 * 50vh until the person drags; then their height wins (at least the header,
 * one row and the composer; at most the viewport less the top chrome); a
 * double-click gives it back to the content. Collapsed by the person it is
 * its header, preview and composer; folded for the proposal card it is its
 * header's height, whatever height the person gave it. Read through
 * layouts.css and messageBox.css in load order (the box's sheet comes with
 * the Agent log's chunk, after the app's).
 */
const VIEW_H = 900;
const css = cascade(['styles/layouts.css', 'styles/messageBox.css'], VIEW_H);
const HEADER = 44;

const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let logOffset = 200;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW_H });
  // Docked bottom right (the right edge within 64 px, low in the window).
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(820, 1164, 584, 784));
  logOffset = 200;
  // The log's box (a 1 px border each side), and a token probe's height
  // (AgentLog reads a length token off a probe: height var(--token)).
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offset(this: HTMLElement) {
    if (this.classList.contains('agent-log')) return logOffset;
    const token = this.style.height;
    return token.startsWith('var(') ? css.px(this, token) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function client(this: HTMLElement) {
    return this.classList.contains('agent-log') ? logOffset - 2 : 0;
  });
  usePersonThreadStore.getState().reset();
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.className = '';
  document.body.style.removeProperty('--agent-log-h');
  for (const name of ['--agent-log-squeeze', '--agent-log-natural-h']) document.documentElement.style.removeProperty(name);
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none' } as never);
});

function mount() {
  const { container } = render(<AgentLog />);
  const log = container.querySelector<HTMLElement>('.agent-log')!;
  const handle = () => container.querySelector<HTMLElement>('.agent-log__resize');
  return { log, handle };
}

/** A drag of the handle, from y to y. */
function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, { button: 0, clientY: from, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: to, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: to, pointerId: 1 });
}

describe('the pure parts', () => {
  it('the handle sits on the edge away from the pinned one', () => {
    expect(resizeEdge(null)).toBe('top');
    expect(resizeEdge({ left: 0, top: 0, anchorX: 'left', anchorY: 'bottom' })).toBe('top');
    expect(resizeEdge({ left: 0, top: 0, anchorX: 'left', anchorY: 'top' })).toBe('bottom');
    expect(resizedHeight(200, 600, 300, 'top')).toBe(500);
    expect(resizedHeight(200, 300, 600, 'bottom')).toBe(500);
  });

  it('clamps to the header, one row and the composer, and to the viewport less the chrome', () => {
    expect(clampLogHeight(50, { min: 150, max: 700 })).toBe(150);
    expect(clampLogHeight(900, { min: 150, max: 700 })).toBe(700);
    expect(clampLogHeight(400.4, { min: 150, max: 700 })).toBe(400);
    // A window too short for the min gives the min.
    expect(clampLogHeight(400, { min: 150, max: 100 })).toBe(150);
    expect(readStoredHeight('320')).toBe(320);
    expect(readStoredHeight('nope')).toBeNull();
    expect(readStoredHeight(null)).toBeNull();
  });

  it('the top chrome is the Updates chip’s row and the gap under it', () => {
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    expect(css.px(probe, 'var(--agent-log-top-chrome)')).toBe(24 + 40 + 8);
    probe.remove();
  });
});

describe('r61 answer 1: the person’s height beats the content’s', () => {
  it('following its content it is capped at 50vh; resized, the person’s height wins over the content', () => {
    const { log, handle } = mount();
    expect(log.hasAttribute('data-sized')).toBe(false);
    expect(log.dataset.docked).toBe('true');
    // Content 700 tall: half the viewport.
    expect(css.boxHeight(log, 700)).toBe(VIEW_H / 2);
    expect(css.boxHeight(log, 300)).toBe(300);
    // The handle on the top edge: dragged up 400 from a 200 px log.
    expect(handle()!.dataset.edge).toBe('top');
    act(() => drag(handle()!, 600, 200));
    expect(log.style.height).toBe('600px');
    expect(log.hasAttribute('data-sized')).toBe(true);
    expect(window.localStorage.getItem(HEIGHT_STORAGE_KEY)).toBe('600');
    // Past 50vh, and whatever the content: theirs.
    expect(css.boxHeight(log, 700)).toBe(600);
    expect(css.boxHeight(log, 120)).toBe(600);
    // The measure the card and the chat read is theirs too.
    expect(document.documentElement.style.getPropertyValue('--agent-log-natural-h')).toBe('600px');
    expect(document.body.style.getPropertyValue('--agent-log-h')).toBe('600px');
  });

  it('stays within the viewport less the top chrome', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, -2000));
    // The log's bottom is at 784; the chrome takes 72.
    expect(log.style.height).toBe(`${784 - 72}px`);
  });

  it('a press with no move changes nothing (the first half of a double-click)', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, 600));
    expect(log.style.height).toBe('');
    expect(log.hasAttribute('data-sized')).toBe(false);
  });

  it('a double-click on the handle gives the height back to the content', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, 300));
    expect(log.style.height).toBe('500px');
    act(() => { fireEvent.doubleClick(handle()!); });
    expect(log.style.height).toBe('');
    expect(log.hasAttribute('data-sized')).toBe(false);
    expect(window.localStorage.getItem(HEIGHT_STORAGE_KEY)).toBeNull();
    expect(css.boxHeight(log, 300)).toBe(300);
    expect(css.boxHeight(log, 700)).toBe(VIEW_H / 2);
  });

  it('the arrow keys move the handle; the height is kept across a remount', () => {
    const first = mount();
    act(() => { fireEvent.keyDown(first.handle()!, { key: 'ArrowUp' }); });
    expect(first.log.style.height).toBe('216px');
    cleanup();
    const second = mount();
    expect(second.log.style.height).toBe('216px');
  });
});

describe('#216 round 3k still holds with the person’s height', () => {
  it('folded for the card: its header’s height; it reopens at the person’s height', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, 200));
    act(() => useUIStore.getState().holdAgentLogForCard(true, true));
    expect(log.hasAttribute('data-card-collapsed')).toBe(true);
    expect(log.style.height).toBe('600px');
    expect(css.boxHeight(log, 700)).toBe(HEADER);
    // The measure the card reads stays the open log's.
    expect(document.documentElement.style.getPropertyValue('--agent-log-natural-h')).toBe('600px');
    act(() => useUIStore.getState().holdAgentLogForCard(false, false));
    expect(css.boxHeight(log, 120)).toBe(600);
  });

  it('collapsed by the person: its header, preview and composer, not its open height', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, 200));
    act(() => { fireEvent.click(log.querySelector('.agent-log__header')!); });
    expect(log.classList.contains('agent-log--open')).toBe(false);
    expect(css.boxHeight(log, 132)).toBe(132);
    // No handle on a collapsed log.
    expect(handle()).toBeNull();
  });

  it('while a give is in force, the shown height bounds it, the person’s height too', () => {
    const { log, handle } = mount();
    act(() => drag(handle()!, 600, 200));
    document.documentElement.style.setProperty('--agent-log-squeeze', '100px');
    expect(css.boxHeight(log, 700)).toBe(500);
    document.documentElement.style.setProperty('--agent-log-squeeze', '0px');
    expect(css.boxHeight(log, 700)).toBe(600);
  });

  it('following its content, the measure the card reads is the height it has with no give', () => {
    logOffset = 300;
    const { log } = mount();
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--agent-log-natural-h')).toBe('300px');
    // A give in force (the registered length, mid-spring): the box is 200 now,
    // but the measure keeps 300, so the card's line never moves for it.
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if (el !== log) return style;
      return new Proxy(style, { get: (target, key) => (key === 'getPropertyValue'
        ? (name: string) => (name === '--agent-log-give' ? '100px' : target.getPropertyValue(name))
        : Reflect.get(target, key)) });
    });
    logOffset = 200;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(root.getPropertyValue('--agent-log-natural-h')).toBe('300px');
    expect(document.body.style.getPropertyValue('--agent-log-h')).toBe('300px');
    // The give ends: it reads its own height again.
    vi.mocked(window.getComputedStyle).mockRestore();
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(root.getPropertyValue('--agent-log-natural-h')).toBe('200px');
  });

  it('following its content, a give bounds it too, below the open token', () => {
    const { log } = mount();
    document.documentElement.style.setProperty('--agent-log-natural-h', '300px');
    document.documentElement.style.setProperty('--agent-log-squeeze', '200px');
    // natural 300 - give 200 = 100: under the open token (198 at 900).
    expect(css.boxHeight(log, 300)).toBe(100);
  });
});

describe('r61 B: the locked composer’s chrome dims, its line doesn’t', () => {
  it('the border and the placeholder take the disabled opacity; the field keeps its focus ring', () => {
    expect(css.ruleValue('.message-box__field-row[data-locked]::before', 'opacity')).toBe('var(--sr-disabled-opacity)');
    expect(css.ruleValue('.message-box__field-row[data-locked]', 'border-color')).toBe('transparent');
    expect(css.ruleValue('.message-box__field-row[data-locked] .message-box__field::placeholder', 'opacity')).toBe('var(--sr-disabled-opacity)');
    expect(css.ruleValue('.message-box__field-row:has(.message-box__field:focus-visible)', 'outline')).toMatch(/^var\(--sr-focus-outline/);
    // The line is never dimmed.
    expect(css.rules.filter((r) => r.selectors.some((s) => s.includes('.message-box__line'))
      && r.decls.some((d) => d.prop === 'opacity'))).toEqual([]);
  });

  it('the shared token is GM’s 0.48', () => {
    const tokens = cascade(['styles/slava-restraint.css'], VIEW_H);
    expect(tokens.ruleValue(':root', '--sr-disabled-opacity') ?? tokens.rules.flatMap((r) => r.decls)
      .find((d) => d.prop === '--sr-disabled-opacity')?.value).toBe('0.48');
  });
});
