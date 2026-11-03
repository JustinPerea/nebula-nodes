import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLog } from '../src/components/panels/AgentLog';
import {
  HEIGHT_STORAGE_KEY,
  RESIZE_HANDLE_LABEL,
  RESIZE_HANDLE_TITLE,
  RESIZE_KEY_STEP,
} from '../src/components/panels/agentLogLayout';
import { CHROME_CLEARANCE, TOOLBAR_SLOT_WIDTH_VAR, chromeTopLimit, toolbarSlotSpan } from '../src/lib/bottomBar';
import { useUIStore } from '../src/store/uiStore';
import { usePersonThreadStore } from '../src/store/personThreadStore';
import { useAgentLogStore } from '../src/store/agentLogStore';
import { cascade } from './helpers/logCascade';

/**
 * GM - Design r70 on #225 (round 2b): the Agent log's resize ceiling is the
 * selection toolbar slot's bottom + 12 px whenever the log's span overlaps
 * the slot, shown or not, else the top bar + 12 px (at 1440x900 about 153
 * px, not 72); the handle is a focusable separator (24 px a key, Enter does
 * what a double-click does); the fold is one bordered chip working and
 * settled; the describedby lines wrap pretty; the header's meta keeps the
 * cursor label's case. Geometry is the live app's at 1440x900 (round 2b's
 * probe): the workspace header 463-977 x 24-64, the toolbar's slot centred
 * at 720, 92-142 (0 px wide empty, 896 px with a model node selected), the
 * docked log 1050-1424, its bottom at 820.
 */
const VIEW_W = 1440;
const VIEW_H = 900;
const css = cascade(['styles/layouts.css', 'styles/messageBox.css'], VIEW_H);

const rect = (left: number, right: number, top: number, bottom: number) =>
  ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let logOffset = 200;
let logBox = rect(1050, 1424, 620, 820);
let slotBox = rect(720, 720, 92, 142);
const HEADER_BOX = rect(463, 977, 24, 64);
let header: HTMLElement;
let slot: HTMLElement;

function addChrome() {
  header = document.createElement('div');
  header.setAttribute('data-top-bar', '');
  slot = document.createElement('div');
  slot.setAttribute('data-top-bar', '');
  slot.setAttribute('data-toolbar-slot', '');
  slot.style.setProperty(TOOLBAR_SLOT_WIDTH_VAR, '960px');
  document.body.append(header, slot);
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW_W });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW_H });
  logOffset = 200;
  logBox = rect(1050, 1424, 620, 820);
  slotBox = rect(720, 720, 92, 142);
  addChrome();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function box(this: HTMLElement) {
    if (this === header) return HEADER_BOX;
    if (this === slot) return slotBox;
    if (this.classList.contains('agent-log')) return logBox;
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offset(this: HTMLElement) {
    if (this.classList.contains('agent-log')) return logOffset;
    const token = this.style.height;
    return token.startsWith('var(') ? css.px(this, token) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function client(this: HTMLElement) {
    return this.classList.contains('agent-log') ? logOffset - 2 : 0;
  });
  usePersonThreadStore.getState().reset();
  useAgentLogStore.getState().clear();
  useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  header.remove();
  slot.remove();
  document.body.style.removeProperty('--agent-log-h');
  document.documentElement.style.removeProperty('--agent-log-natural-h');
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none' } as never);
});

function mount() {
  const { container } = render(<AgentLog />);
  const log = container.querySelector<HTMLElement>('.agent-log')!;
  const handle = () => container.querySelector<HTMLElement>('.agent-log__resize')!;
  return { log, handle };
}

function dragUp(handle: HTMLElement, by: number) {
  fireEvent.pointerDown(handle, { button: 0, clientY: 600, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 600 - by, pointerId: 1 });
  fireEvent.pointerUp(handle, { clientY: 600 - by, pointerId: 1 });
}

describe('r70 2: the resize ceiling', () => {
  it('the slot reserves its width centred on itself, shown or not', () => {
    expect(toolbarSlotSpan(slot, slotBox)).toEqual({ left: 240, right: 1200 });
    // Shown, a model node selected: still the reserved span.
    expect(toolbarSlotSpan(slot, rect(272, 1168, 92, 142))).toEqual({ left: 240, right: 1200 });
    // A toolbar wider than the reservation widens it.
    expect(toolbarSlotSpan(slot, rect(200, 1240, 92, 142))).toEqual({ left: 200, right: 1240 });
  });

  it('the canvas marks the toolbar’s Panel as the slot and reserves its width', () => {
    const canvas = readFileSync(resolve(__dirname, '../src/components/Canvas.tsx'), 'utf8');
    expect(canvas).toMatch(/<Panel position="top-center" className="selection-toolbar-panel" data-top-bar="" data-toolbar-slot="">/);
    const sheet = cascade(['styles/canvas.css'], VIEW_H);
    expect(sheet.ruleValue('.selection-toolbar-panel.react-flow__panel', TOOLBAR_SLOT_WIDTH_VAR)).toBe('960px');
  });

  it('chromeTopLimit: the slot counts only over its span; the top bar always', () => {
    expect(CHROME_CLEARANCE).toBe(12);
    // The log's span overlaps the slot: its bottom + 12.
    expect(chromeTopLimit({ left: 1050, right: 1424 })).toBe(142 + 12);
    // Clear of it: the top bar + 12.
    expect(chromeTopLimit({ left: 1210, right: 1424 })).toBe(64 + 12);
    // No span (the r68 popover's rule): the slot counts across the width.
    expect(chromeTopLimit()).toBe(142 + 12);
    expect(chromeTopLimit({ left: 1210, right: 1424 }, 8)).toBe(64 + 8);
  });

  it('at 1440x900 over the slot the log goes up to 12 px under the toolbar’s line (top 154)', () => {
    const { log, handle } = mount();
    act(() => dragUp(handle(), 2000));
    expect(log.style.height).toBe(`${820 - 154}px`);
    expect(window.localStorage.getItem(HEIGHT_STORAGE_KEY)).toBe(String(820 - 154));
  });

  it('selecting a node doesn’t move the ceiling: shown, the slot is the same', () => {
    slotBox = rect(272, 1168, 92, 142);
    const { log, handle } = mount();
    act(() => dragUp(handle(), 2000));
    expect(log.style.height).toBe(`${820 - 154}px`);
  });

  it('clear of the slot (a wider window): the top bar + 12', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    slotBox = rect(960, 960, 92, 142);
    logBox = rect(1530, 1904, 900, 1060);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    const { log, handle } = mount();
    act(() => dragUp(handle(), 2000));
    expect(log.style.height).toBe(`${1060 - 76}px`);
  });

  it('a height kept from before the ceiling comes down to it when the log opens', () => {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, '748');
    const { log } = mount();
    expect(log.style.height).toBe(`${820 - 154}px`);
    expect(window.localStorage.getItem(HEIGHT_STORAGE_KEY)).toBe(String(820 - 154));
  });
});

describe('r70: the handle is a focusable separator', () => {
  it('named "Resize the Agent log", with its value and bounds, focusable; the tooltip lists the keys', () => {
    logOffset = 300;
    const { handle } = mount();
    const h = handle();
    expect(h.getAttribute('role')).toBe('separator');
    expect(h.getAttribute('aria-orientation')).toBe('horizontal');
    expect(h.getAttribute('aria-label')).toBe('Resize the Agent log');
    expect(RESIZE_HANDLE_LABEL).toBe('Resize the Agent log');
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute('aria-valuenow')).toBe('300');
    expect(Number(h.getAttribute('aria-valuemin'))).toBeGreaterThan(0);
    expect(h.getAttribute('aria-valuemax')).toBe(String(820 - 154));
    expect(h.getAttribute('title')).toBe(RESIZE_HANDLE_TITLE);
    // GM r73, verbatim.
    expect(RESIZE_HANDLE_TITLE).toBe('Drag or use the arrow keys to resize. Double-click or press Enter to fit the content.');
  });

  it('the arrows move it 24 px; Enter fits the content, as a double-click does', () => {
    expect(RESIZE_KEY_STEP).toBe(24);
    const { log, handle } = mount();
    act(() => { fireEvent.keyDown(handle(), { key: 'ArrowUp' }); });
    expect(log.style.height).toBe('224px');
    logOffset = 224;
    act(() => { fireEvent.keyDown(handle(), { key: 'ArrowDown' }); });
    expect(log.style.height).toBe('200px');
    act(() => { fireEvent.keyDown(handle(), { key: 'Enter' }); });
    expect(log.style.height).toBe('');
    expect(log.hasAttribute('data-sized')).toBe(false);
    expect(window.localStorage.getItem(HEIGHT_STORAGE_KEY)).toBeNull();
  });
});

describe('r70 LOW: the header’s meta keeps the cursor label’s case', () => {
  it('"Claude · 2" in its own case; the state words stay lowercase', () => {
    useAgentLogStore.getState().add({ ts: Date.now(), source: 'agent', agent: { id: 'a1', name: 'Claude · 2', color: '#E8825A' }, message: 'Cooler sky' });
    const { log } = mount();
    const status = log.querySelector('.agent-log__status')!;
    expect(status.textContent).toBe('Claude · 2');
    expect(status.classList.contains('agent-log__status--name')).toBe(true);
    expect(css.ruleValue('.agent-log__telemetry .agent-log__status--name', 'text-transform')).toBe('none');
    cleanup();
    useAgentLogStore.getState().clear();
    const idle = mount();
    expect(idle.log.querySelector('.agent-log__status')!.classList.contains('agent-log__status--name')).toBe(false);
  });
});

describe('r70 CSS', () => {
  it('the fold is one bordered chip: no rule tells the working fold from the settled one', () => {
    expect(css.rules.filter((r) => r.selectors.some((s) => /message-box__fold--/.test(s)))).toEqual([]);
    expect(css.ruleValue('.message-box__fold', 'border')).toMatch(/^1px solid/);
  });

  it('the describedby lines wrap pretty', () => {
    expect(css.ruleValue('.message-box__line', 'text-wrap')).toBe('pretty');
    expect(css.ruleValue('.message-box__counter', 'text-wrap')).toBe('pretty');
  });

  it('"You answered “…”." on one line, the words cut inside the quotes', () => {
    expect(css.ruleValue('.message-box__answered--typed', 'white-space')).toBe('nowrap');
    expect(css.ruleValue('.message-box__answered-words', 'text-overflow')).toBe('ellipsis');
    expect(css.ruleValue('.message-box__answered-words', 'overflow')).toBe('hidden');
  });
});
