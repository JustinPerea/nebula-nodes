import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { CONTENT_RESIZE_MS, NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';

/**
 * GM r68 (2026-11-03), the unpinned Inspector beside a node:
 * - "It grows to fit its content, up to the space between the floating top
 *   chrome (the selection toolbar) and the bottom bar, with 12 px clear of
 *   each. At 1440x900 that's about 660 px. It scrolls only past that."
 * - "300 px stays as the floor, so short popovers don't change."
 * - "Drop the one-spare-line rule (POPOVER_SPARE_LINE) and the palette
 *   exception. With content-fit growth, neither is needed."
 * - "If the node sits low, the popover shifts up to fit before it shrinks. It
 *   never covers the top toolbar or the bottom bar."
 * - "Height changes, from an upload landing or "No preview" collapsing, use
 *   the layout spring, anchored at the top, so the file row doesn't move
 *   under the pointer."
 * - "A pinned panel keeps its 440 px start and the person's own size."
 *
 * jsdom has no layout: the panel's header and foot (CHROME) and the body's
 * content get the heights each test says; the toolbar and the bar the rects
 * the live check measured at 1440x900 (toolbar 272-1168 x 92-142, bar
 * 475-965 x 828-876, so 154-816: 662 px of room).
 */

vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => <div className="test-inspector-content"><button type="button" className="test-file-row">Choose File</button></div>,
}));

const CLEAR = 12;
/** The header, the foot row and the borders: what the panel holds besides its body's viewport. */
const CHROME = 115;
const TOOLBAR_BOTTOM = 142;
let contentHeight = 0;
/** The panel's height on screen while the layout spring runs it, or null at rest. */
let animated: number | null = null;
let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;
let previousUi: ReturnType<typeof useUIStore.getState>;
let anchorRect: DOMRect;
const placed: HTMLElement[] = [];

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function place(attrs: Record<string, string>, at: () => DOMRect): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.getBoundingClientRect = at;
  document.body.append(element);
  placed.push(element);
  return element;
}

function frames(n = 1) {
  for (let i = 0; i < n; i++) {
    act(() => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(performance.now()));
    });
  }
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

function body() {
  return panel().querySelector<HTMLElement>('.node-inspector-popover__body')!;
}

/** The window, the header, the selection toolbar, the bar and the notice band above it. */
function chromeAt(width: number, height: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  fireEvent(window, new Event('resize'));
  const barTop = height - 24 - 48;
  place({ 'data-top-bar': '' }, () => rect((width - 468) / 2, 24, 468, 40));
  place({ 'data-top-bar': '' }, () => rect((width - 896) / 2, 92, 896, 50));
  place({ 'data-bottom-bar': '' }, () => rect((width - 490) / 2, barTop, 490, 48));
  place({ 'data-notice-band': '' }, () => rect(16, barTop - 8 - 54, width - 32, 54));
  return { barTop, topLine: TOOLBAR_BOTTOM + CLEAR, bottomLine: barTop - CLEAR };
}

function openBeside(node: DOMRect) {
  anchorRect = node;
  const anchor = place({ 'data-node-inspector-anchor': 'n1' }, () => anchorRect);
  anchor.dataset.nodeInspectorAnchor = 'n1';
  render(<NodeInspectorPopover />);
  frames(1);
}

beforeEach(() => {
  previousUi = useUIStore.getState();
  callbacks = new Map();
  nextRaf = 0;
  contentHeight = 0;
  animated = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  const onScreen = (popover: HTMLElement | null) => {
    const given = parseFloat(popover?.style.height ?? '');
    return animated ?? (Number.isFinite(given) ? given : 0);
  };
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('node-inspector-popover')) return onScreen(this);
    if (this.classList.contains('node-inspector-popover__content')) return contentHeight;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('node-inspector-popover__body')) return 0;
    return Math.max(0, onScreen(this.closest<HTMLElement>('.node-inspector-popover')) - CHROME);
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
  placed.splice(0).forEach((element) => element.remove());
  useUIStore.setState(previousUi, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the unpinned Inspector grows to fit its content (GM r68)', () => {
  it('takes its whole body, in its first frame, so the body does not scroll', () => {
    chromeAt(1440, 900);
    // Style Reference, measured live: 416 px of body under a 115 px header and foot.
    contentHeight = 416;
    openBeside(rect(560, 200, 82, 56));
    expect(bounds().height).toBe(416 + CHROME);
    expect(body().scrollHeight - body().clientHeight).toBe(0);
    // And it holds still from frame to frame.
    const before = bounds();
    frames(3);
    expect(bounds()).toEqual(before);
  });

  it('a body only one line over 300 px takes its line, and a body far over takes all of it (no spare-line or palette rule)', () => {
    chromeAt(1440, 900);
    contentHeight = 300 - CHROME + 34;
    openBeside(rect(560, 200, 82, 56));
    expect(bounds().height).toBe(334);
    cleanup();
    contentHeight = 300 - CHROME + 260;
    render(<NodeInspectorPopover />);
    frames(1);
    expect(bounds().height).toBe(560);
  });

  it('keeps 300 px as its floor for a short body', () => {
    chromeAt(1440, 900);
    contentHeight = 120;
    openBeside(rect(560, 200, 82, 56));
    expect(bounds().height).toBe(300);
  });

  it('stops 12 px clear of the toolbar and of the bar (not the notice band), and only then scrolls', () => {
    const { topLine, bottomLine } = chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    const box = bounds();
    expect(box.top).toBe(topLine);
    expect(box.bottom).toBe(bottomLine);
    // 154-816 at 1440x900: GM's "about 660 px".
    expect(box.height).toBe(662);
    expect(body().scrollHeight).toBeGreaterThan(body().clientHeight);
  });

  it('in a shorter window (1440x700) the cap follows the measured chrome', () => {
    const { topLine, bottomLine } = chromeAt(1440, 700);
    contentHeight = 416;
    openBeside(rect(560, 200, 82, 56));
    const box = bounds();
    expect(box.top).toBe(topLine);
    expect(box.bottom).toBe(bottomLine);
    expect(box.height).toBe(bottomLine - topLine);
    expect(body().scrollHeight).toBeGreaterThan(body().clientHeight);
  });
});

describe('a node low on the screen (GM r68)', () => {
  it('shifts the panel up to fit before it gets shorter', () => {
    const { bottomLine } = chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(rect(560, 760, 82, 56));
    const box = bounds();
    expect(box.height).toBe(416 + CHROME);
    expect(box.bottom).toBe(bottomLine);
    expect(box.top).toBe(bottomLine - (416 + CHROME));
  });

  it('never covers the toolbar or the bar, wherever the node is', () => {
    const { topLine, bottomLine } = chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 860, 82, 56));
    expect(bounds().top).toBeGreaterThanOrEqual(topLine);
    expect(bounds().bottom).toBeLessThanOrEqual(bottomLine);
    anchorRect = rect(560, -80, 82, 56);
    frames(1);
    expect(bounds().top).toBeGreaterThanOrEqual(topLine);
    expect(bounds().bottom).toBeLessThanOrEqual(bottomLine);
  });
});

describe('a height change from the content (GM r68)', () => {
  /** Where the file row sits on screen: a fixed offset under the panel's top. */
  const rowTop = () => bounds().top + 72;

  it('grows on the layout spring, anchored at the top: the row under the pointer stays put', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(rect(560, 170, 82, 56));
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    const row = rowTop();
    const before = bounds();
    // An upload lands: the preview adds 100 px.
    contentHeight = 416 + 100;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(bounds().height).toBe(416 + 100 + CHROME);
    expect(bounds().top).toBe(before.top);
    expect(rowTop()).toBe(row);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS - 1); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('shrinks on the spring too ("No preview" collapsing), its top still put', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(rect(560, 200, 82, 56));
    const before = bounds();
    contentHeight = 416 - 90;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(bounds().height).toBe(416 - 90 + CHROME);
    expect(bounds().top).toBe(before.top);
  });

  it('near the bottom, the top still holds: the panel grows to the bar and the rest scrolls', () => {
    const { bottomLine } = chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    const before = bounds();
    expect(before).toEqual({ top: 392, height: 300, bottom: 692 });
    contentHeight = 450;
    frames(2);
    expect(bounds().top).toBe(before.top);
    expect(bounds().bottom).toBe(bottomLine);
    expect(body().scrollHeight).toBeGreaterThan(body().clientHeight);
    // Once the node moves, it is placed afresh: shifted up to fit.
    anchorRect = rect(560, 410, 82, 56);
    frames(1);
    expect(bounds().height).toBe(450 + CHROME);
    expect(bounds().bottom).toBe(bottomLine);
  });

  it('reads its content against the height on screen mid-spring, so it never runs past it', () => {
    chromeAt(1440, 1400);
    contentHeight = 420;
    openBeside(rect(560, 200, 82, 56));
    contentHeight = 600;
    animated = 420 + CHROME;
    frames(2);
    expect(bounds().height).toBe(600 + CHROME);
    for (const at of [560, 640, 600 + CHROME + 9, 600 + CHROME]) {
      animated = at;
      frames(2);
      expect(bounds().height).toBe(600 + CHROME);
    }
  });

  it('never springs on a move, and a move mid-spring ends it at once (rigid wins, GM r22 Q5)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    anchorRect = rect(560, 260, 82, 56);
    frames(2);
    expect(bounds().top).toBe(252);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    contentHeight = 400;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    const given = bounds();
    act(() => { vi.advanceTimersByTime(100); });
    anchorRect = rect(560, 300, 82, 56);
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    expect(bounds().height).toBe(given.height);
    expect(bounds().top).toBe(given.top + 40);
  });

  it('the node card growing (its preview landing) is not a move: the panel still springs', () => {
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    anchorRect = rect(560, 200, 82, 180);
    contentHeight = 431;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(bounds().top).toBe(192);
  });
});

describe('the pinned Inspector (GM r68: unchanged)', () => {
  it('keeps its 440 px start whatever its content, and never springs', () => {
    useUIStore.getState().setInspectorPinned(true);
    chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    frames(2);
    expect(bounds().height).toBe(440);
    contentHeight = 100;
    frames(2);
    expect(bounds().height).toBe(440);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });
});

describe("the layout spring's CSS", () => {
  const css = readFileSync(resolve(__dirname, '../../src/styles/panels.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const reduced = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)].map((m) => m[1]).join('\n');
  const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
  const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, block]) => ({ selector: selector.trim(), block }));

  it('springs the floating popover only while data-content-resizing is on, never the pinned one', () => {
    const moving = rules(outside).filter((r) => r.selector.includes('.node-inspector-popover') && /transition\s*:[^;]*(height|top)/.test(r.block));
    expect(moving).toHaveLength(1);
    expect(moving[0].selector).toBe('.node-inspector-popover[data-content-resizing]:not(.node-inspector-popover--pinned)');
    expect(moving[0].block).toMatch(/transition:\s*height var\(--inspector-layout-spring\), top var\(--inspector-layout-spring\)/);
    // The sampled spring, never a stock easing.
    expect(moving[0].block).toMatch(/--inspector-layout-spring:\s*360ms linear\(/);
    expect(moving[0].block).not.toMatch(/ease|cubic-bezier/);
  });

  it('cancels a running spring once the attribute goes (rigid wins)', () => {
    const rigid = rules(outside).filter((r) => r.selector === '.node-inspector-popover:not([data-content-resizing])');
    expect(rigid).toHaveLength(1);
    expect(rigid[0].block).toMatch(/transition:\s*none/);
  });

  it('jumps for reduced motion', () => {
    const off = rules(reduced).filter((r) => r.selector === '.node-inspector-popover[data-content-resizing]:not(.node-inspector-popover--pinned)');
    expect(off).toHaveLength(1);
    expect(off[0].block).toMatch(/transition:\s*none/);
  });

  it('measures a content box that keeps its sections\' margins inside it', () => {
    const content = rules(outside).filter((r) => r.selector === '.node-inspector-popover__content');
    expect(content).toHaveLength(1);
    expect(content[0].block).toMatch(/display:\s*flow-root/);
  });
});

describe('the source', () => {
  const source = readFileSync(resolve(__dirname, '../../src/components/panels/NodeInspectorPopover.tsx'), 'utf8');
  it('has no spare-line rule and no palette exception left', () => {
    expect(source).not.toMatch(/POPOVER_SPARE_LINE|holdsPalette|inspector__palette|swatchCount/);
  });
});
