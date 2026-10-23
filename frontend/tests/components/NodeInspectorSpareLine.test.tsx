import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';

/**
 * GM - Design, 2026-10-23 (round 3): "A small one from the cover shot: at that
 * height the scroll fade covers the State value, its only line, so "idle"
 * can't be seen at all. Start the fade only once the body actually overflows
 * by more than one line, or give the body room for one more line before it
 * scrolls."
 *
 * Built as the second: the floating Inspector is 300 px tall, and when its
 * body's content is at most one line longer than that leaves room for, the
 * panel takes that line (inside the top line and the band), so the body
 * doesn't scroll and nothing is under a fade. Longer content scrolls under
 * the 12 px fade as before.
 *
 * jsdom has no layout: the body's content and its viewport get the heights a
 * Text Input's Inspector has in GM's cover setup (1280x800).
 */

vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => <div className="test-inspector-content">State<span>idle</span></div>,
}));

const GAP = 8;
/** The header and the foot row: what the panel holds besides its body. */
const CHROME = 115;
let contentHeight = 0;
let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;
let previousUi: ReturnType<typeof useUIStore.getState>;
const chrome: HTMLElement[] = [];

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function place(attrs: Record<string, string>, at: () => DOMRect): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.getBoundingClientRect = at;
  document.body.append(element);
  chrome.push(element);
  return element;
}

function advanceLayout() {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function panel() {
  return document.querySelector<HTMLDivElement>('.node-inspector-popover')!;
}

function bounds() {
  const { style } = panel();
  const top = parseFloat(style.top);
  const height = parseFloat(style.height);
  return { top, height, bottom: top + height };
}

/** GM's cover setup at 1280x800: the bar, the band, the header and the toolbar. */
function coverSetup() {
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
  fireEvent(window, new Event('resize'));
  const barTop = 800 - 24 - 47;
  place({ 'data-bottom-bar': '' }, () => rect(395, barTop, 490, 47));
  place({ 'data-notice-band': '' }, () => rect(16, barTop - GAP - 54, 1248, 54));
  place({ 'data-top-bar': '' }, () => rect(412, 24, 456, 40));
  place({ 'data-top-bar': '' }, () => rect(365, 92, 550, 50));
  return { bandTop: barTop - GAP - 54 };
}

function openBeside(node: DOMRect) {
  const anchor = document.createElement('div');
  anchor.dataset.nodeInspectorAnchor = 'n1';
  anchor.getBoundingClientRect = () => node;
  document.body.append(anchor);
  chrome.push(anchor);
  render(<NodeInspectorPopover />);
  advanceLayout();
  // The body is in the page now: measure it, and once more for what that changed.
  advanceLayout();
  advanceLayout();
}

beforeEach(() => {
  previousUi = useUIStore.getState();
  callbacks = new Map();
  nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  // The body's viewport is the panel less its header and foot; its content
  // (padding included) is as tall as the test says.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('node-inspector-popover__body')) return 0;
    const height = parseFloat(this.closest<HTMLElement>('.node-inspector-popover')?.style.height ?? '');
    return Number.isFinite(height) ? Math.max(0, height - CHROME) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('node-inspector-popover__body')) return 0;
    return Math.max(contentHeight, this.clientHeight);
  });
  useUIStore.getState().setInspectorPinned(false);
  useUIStore.getState().selectNode('n1');
  useUIStore.getState().setInspectorVisible(true);
});

afterEach(() => {
  cleanup();
  chrome.splice(0).forEach((element) => element.remove());
  useUIStore.setState(previousUi, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Inspector's body has room for one more line before it scrolls", () => {
  it("GM's cover setup: the State value's line fits, so the body doesn't scroll and \"idle\" isn't under a fade", () => {
    const { bandTop } = coverSetup();
    // 34 px more than a 300 px panel leaves the body (measured live): the
    // State value's line, the last section's margin and the body's padding.
    contentHeight = 300 - CHROME + 34;
    openBeside(rect(575, 437, 82, 90));
    const box = bounds();
    expect(box.height).toBe(300 + 34);
    expect(box.bottom).toBeLessThanOrEqual(bandTop);
    expect(box.top).toBeGreaterThanOrEqual(92 + 50 + GAP);
    const body = panel().querySelector<HTMLElement>('.node-inspector-popover__body')!;
    expect(body.scrollHeight - body.clientHeight).toBe(0);
  });

  it('content that fits keeps the panel at its own 300 px', () => {
    coverSetup();
    // A 300 px panel leaves the body 185 px.
    contentHeight = 150;
    openBeside(rect(575, 437, 82, 90));
    expect(bounds().height).toBe(300);
  });

  it('more than one line over: the panel stays 300 px and the body scrolls (under its fade)', () => {
    coverSetup();
    contentHeight = 300 - CHROME + 60;
    openBeside(rect(575, 437, 82, 90));
    expect(bounds().height).toBe(300);
  });

  it('holds still from frame to frame (no back and forth once it has the line)', () => {
    coverSetup();
    contentHeight = 300 - CHROME + 18;
    openBeside(rect(575, 437, 82, 90));
    const before = bounds();
    advanceLayout();
    advanceLayout();
    expect(bounds()).toEqual(before);
  });

  it('keeps the line while open when the content gets shorter (a panel never moves on its own), and a new open starts at 300 px', () => {
    coverSetup();
    contentHeight = 300 - CHROME + 18;
    openBeside(rect(575, 437, 82, 90));
    expect(bounds().height).toBe(318);
    contentHeight = 150;
    advanceLayout();
    advanceLayout();
    expect(bounds().height).toBe(318);
    act(() => { useUIStore.getState().setInspectorVisible(false); });
    advanceLayout();
    act(() => { useUIStore.getState().setInspectorVisible(true); });
    advanceLayout();
    advanceLayout();
    expect(bounds().height).toBe(300);
  });

  it('never past the top line and the band: in a short window the body scrolls as before', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 440);
    const barTop = 440 - 24 - 47;
    const bandTop = barTop - GAP - 54;
    place({ 'data-bottom-bar': '' }, () => rect(395, barTop, 490, 47));
    place({ 'data-notice-band': '' }, () => rect(16, bandTop, 1248, 54));
    place({ 'data-top-bar': '' }, () => rect(365, 92, 550, 50));
    contentHeight = 300 - CHROME + 18;
    openBeside(rect(575, 200, 82, 90));
    const box = bounds();
    expect(box.top).toBe(92 + 50 + GAP);
    expect(box.bottom).toBe(bandTop);
  });
});
