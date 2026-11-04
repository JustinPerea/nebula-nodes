import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  CONTENT_RESIZE_MS, NodeInspectorPopover, OPEN_SETTLE_CAP_MS, OPEN_STABLE_FRAMES,
} from '../../src/components/panels/NodeInspectorPopover';
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
 * GM r72: "Cap to the BAND line (~612 at 1440x900), not the bar: the reserved
 * notice band wins; a notice covering Run/Duplicate/Delete is the overlap r57
 * rules out. Unpinned only; pinned keeps its rule." So the bottom line is 12
 * px above the notice region's reserved band, not the bar.
 *
 * jsdom has no layout: the panel's header and foot (CHROME) and the body's
 * content get the heights each test says; the toolbar, the bar and the band
 * the rects the live check measured at 1440x900 (toolbar 272-1168 x 92-142,
 * bar 475-965 x 828-876, band 766-820, so 154-754: 600 px of room; GM's
 * "~612" was an estimate).
 */

// The Inspector's body: a file row, and a preview image when a test says so.
const mock = vi.hoisted(() => ({ image: false }));
vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => (
    <div className="test-inspector-content">
      <button type="button" className="test-file-row">Choose File</button>
      {mock.image ? <img className="inspector__file-preview" alt="Preview" src="/api/outputs/chat-uploads/x.png" /> : null}
    </div>
  ),
}));

const CLEAR = 12;
/** The notice band's height (one notice plus its gap), measured live. */
const BAND = 54;
/** The header, the foot row and the borders: what the panel holds besides its body's viewport. */
const CHROME = 115;
const TOOLBAR_BOTTOM = 142;
let contentHeight = 0;
/** Whether the preview image has decoded (`img.complete`). */
let imageLoaded = true;
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

/** The lines at a window height: the bar's top, the band's, and the panel's two lines. */
function lines(height: number) {
  const barTop = height - 24 - 48;
  const bandTop = barTop - 8 - BAND;
  return { barTop, bandTop, topLine: TOOLBAR_BOTTOM + CLEAR, bottomLine: bandTop - CLEAR };
}

/** The window's size (the chrome follows it, as the app's does). */
function windowAt(width: number, height: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  fireEvent(window, new Event('resize'));
  return lines(height);
}

/** The window, the header, the selection toolbar, the bar and the notice band above it. */
function chromeAt(width: number, height: number) {
  const at = windowAt(width, height);
  place({ 'data-top-bar': '' }, () => rect((innerWidth - 468) / 2, 24, 468, 40));
  place({ 'data-top-bar': '' }, () => rect((innerWidth - 896) / 2, 92, 896, 50));
  place({ 'data-bottom-bar': '' }, () => rect((innerWidth - 490) / 2, lines(innerHeight).barTop, 490, 48));
  place({ 'data-notice-band': '' }, () => rect(16, lines(innerHeight).bandTop, innerWidth - 32, BAND));
  return at;
}

function openBeside(node: DOMRect) {
  anchorRect = node;
  const anchor = place({ 'data-node-inspector-anchor': 'n1' }, () => anchorRect);
  anchor.dataset.nodeInspectorAnchor = 'n1';
  render(<NodeInspectorPopover />);
  frames(1);
}

/** Lets the open end (GM r82): its height holds for OPEN_STABLE_FRAMES frames. */
function settle() {
  frames(OPEN_STABLE_FRAMES);
}

function setVisible(visible: boolean) {
  act(() => useUIStore.getState().setInspectorVisible(visible));
  frames(1);
}

beforeEach(() => {
  previousUi = useUIStore.getState();
  callbacks = new Map();
  nextRaf = 0;
  contentHeight = 0;
  animated = null;
  mock.image = false;
  imageLoaded = true;
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(() => imageLoaded);
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

  it('stops 12 px clear of the toolbar and of the notice band (not the bar, GM r72), and only then scrolls', () => {
    const { barTop, bandTop, topLine, bottomLine } = chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    const box = bounds();
    expect(box.top).toBe(topLine);
    expect(box.bottom).toBe(bottomLine);
    // 154-754 at 1440x900, as measured live (GM r72 estimated "~612").
    expect(box.height).toBe(600);
    expect(box.bottom).toBe(bandTop - CLEAR);
    expect(box.bottom).toBeLessThan(barTop - CLEAR);
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

  it('never covers the toolbar or the notice band, wherever the node is', () => {
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
    settle();
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    const row = rowTop();
    const before = bounds();
    // An upload lands: the preview adds 50 px (162 + 581 stays above the band's line, 754).
    contentHeight = 416 + 50;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(bounds().height).toBe(416 + 50 + CHROME);
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
    settle();
    const before = bounds();
    contentHeight = 416 - 90;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(bounds().height).toBe(416 - 90 + CHROME);
    expect(bounds().top).toBe(before.top);
  });

  it('near the bottom, the top still holds: the panel grows to the band\'s line and the rest scrolls', () => {
    const { bottomLine } = chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    settle();
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
    // 292 + 455 (after the move below) stays above the band's line (754), so
    // the fresh placement keeps the height.
    contentHeight = 340;
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

/**
 * GM r82 (review 1 MEDIUM-1): "The open lasts until content is stable: every
 * img complete, then 2 stable frames. Any settle before then counts as
 * placement; a change after holds the top (r72). Cap the open at 300 ms from
 * mount; after the cap the panel is placed and later changes hold. ... Any
 * move inside the open is the same top-anchored spring, never a jump. First
 * and second open give the same result: Style Reference at y 784 -> 154-754
 * both times."
 *
 * Style Reference measured live: 416 px of body empty (531 with the chrome),
 * 485 with its preview (600).
 */
describe('the open lasts until its content is stable (GM r82)', () => {
  const LOW = () => rect(560, 784, 82, 56);

  for (const after of [1, 2]) {
    it(`a content change ${after} frame${after > 1 ? 's' : ''} after opening a low node still shifts it up, on the spring`, () => {
      const { topLine, bottomLine } = chromeAt(1440, 900);
      contentHeight = 416;
      openBeside(LOW());
      expect(bounds()).toEqual({ top: bottomLine - 531, height: 531, bottom: bottomLine });
      frames(after - 1);
      expect(panel().hasAttribute('data-content-resizing')).toBe(false);
      // The preview decodes: 69 px more.
      contentHeight = 485;
      frames(1);
      expect(bounds()).toEqual({ top: topLine, height: 600, bottom: bottomLine });
      // The same top-anchored spring as any content change, never a jump.
      expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    });
  }

  it('waits for every image to be complete before it ends, then holds its top', () => {
    const { bottomLine } = chromeAt(1440, 900);
    mock.image = true;
    imageLoaded = false;
    contentHeight = 416;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openBeside(LOW());
    // Many stable frames, but the image hasn't decoded: still opening.
    frames(6);
    contentHeight = 450;
    frames(1);
    expect(bounds()).toEqual({ top: bottomLine - 565, height: 565, bottom: bottomLine });
    // It decodes; two frames at one height end the open.
    imageLoaded = true;
    frames(1 + OPEN_STABLE_FRAMES);
    const placedTop = bounds().top;
    contentHeight = 485;
    frames(1);
    expect(bounds().top).toBe(placedTop);
    expect(bounds().bottom).toBe(bottomLine);
    expect(body().scrollHeight).toBeGreaterThan(body().clientHeight);
  });

  it(`an image that never loads stops placing at ${OPEN_SETTLE_CAP_MS} ms from the mount`, () => {
    const { bottomLine } = chromeAt(1440, 900);
    mock.image = true;
    imageLoaded = false;
    contentHeight = 416;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    openBeside(LOW());
    frames(4);
    // 1 ms before the cap a settle is still placement.
    act(() => { vi.advanceTimersByTime(OPEN_SETTLE_CAP_MS - 1); });
    contentHeight = 450;
    frames(1);
    expect(bounds()).toEqual({ top: bottomLine - 565, height: 565, bottom: bottomLine });
    // At the cap the open ends, the image still loading: a change holds the top.
    act(() => { vi.advanceTimersByTime(1); });
    contentHeight = 485;
    frames(1);
    expect(bounds()).toEqual({ top: bottomLine - 565, height: 565, bottom: bottomLine });
    expect(body().scrollHeight).toBeGreaterThan(body().clientHeight);
  });

  it('opened twice, Style Reference at y 784 takes 154-754 both times', () => {
    const { topLine, bottomLine } = chromeAt(1440, 900);
    mock.image = true;
    // First open: the preview isn't decoded yet (0 px), then it is.
    imageLoaded = false;
    contentHeight = 416;
    openBeside(LOW());
    imageLoaded = true;
    contentHeight = 485;
    frames(1 + OPEN_STABLE_FRAMES);
    const first = bounds();
    expect(first).toEqual({ top: topLine, height: 600, bottom: bottomLine });
    expect(topLine).toBe(154);
    expect(bottomLine).toBe(754);
    setVisible(false);
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
    // Second open: the image is in the cache, so it is right on frame one.
    setVisible(true);
    expect(bounds()).toEqual(first);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    settle();
    expect(bounds()).toEqual(first);
  });

  it('another node is a new open: its settle shifts it up too', () => {
    const { topLine, bottomLine } = chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    // Select a low node: placed beside it, then its preview decodes.
    contentHeight = 416;
    place({ 'data-node-inspector-anchor': 'n2' }, () => LOW());
    // Selected and shown in one update (selecting alone closes the unpinned panel).
    act(() => {
      useUIStore.getState().selectNode('n2');
      useUIStore.getState().setInspectorVisible(true);
    });
    frames(1);
    expect(bounds()).toEqual({ top: bottomLine - 531, height: 531, bottom: bottomLine });
    contentHeight = 485;
    frames(1);
    expect(bounds()).toEqual({ top: topLine, height: 600, bottom: bottomLine });
  });

  it('a reopen starts afresh: no spring on open, no held top kept (review 1 LOW-2)', () => {
    const { bottomLine } = chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    settle();
    // After the open, a change holds the top at 392.
    contentHeight = 450;
    frames(1);
    expect(bounds().top).toBe(392);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    setVisible(false);
    // Changed while closed, then opened again: placed afresh and shifted up,
    // in its first frame, with no spring.
    contentHeight = 470;
    setVisible(true);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    expect(bounds()).toEqual({ top: bottomLine - (470 + CHROME), height: 470 + CHROME, bottom: bottomLine });
  });
});

/**
 * GM r82 (review 1 LOW-1): "a window resize re-places and drops the held top;
 * glides to the fresh placement on the same spring, following the resize
 * live."
 */
describe('a window resize re-places the panel (GM r82)', () => {
  it('drops the held top and glides to the fresh placement, following the resize live', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    settle();
    contentHeight = 450;
    frames(1);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    // Held at 392, to the band's line, the rest scrolling.
    expect(bounds()).toEqual({ top: 392, height: 754 - 392, bottom: 754 });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);

    const at700 = windowAt(1440, 700);
    frames(1);
    // Fresh: shifted up to the top line, as tall as the room (400 px, not 162).
    expect(bounds()).toEqual({ top: at700.topLine, height: at700.bottomLine - at700.topLine, bottom: at700.bottomLine });
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);

    // The resize goes on: the glide follows it live, its spring kept on for
    // as long as the resize lasts (past the first spring's own end).
    act(() => { vi.advanceTimersByTime(300); });
    const at650 = windowAt(1440, 650);
    frames(1);
    expect(bounds()).toEqual({ top: at650.topLine, height: at650.bottomLine - at650.topLine, bottom: at650.bottomLine });
    act(() => { vi.advanceTimersByTime(300); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    const at900 = windowAt(1440, 900);
    frames(1);
    expect(bounds()).toEqual({ top: at900.bottomLine - (450 + CHROME), height: 450 + CHROME, bottom: at900.bottomLine });
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS - 1); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    // Placed afresh, so a content change from here holds this new top.
    const placedTop = bounds().top;
    contentHeight = 470;
    frames(1);
    expect(bounds().top).toBe(placedTop);
  });

  it('with no held top, a resize still moves it at once (no spring)', () => {
    chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(rect(560, 400, 82, 56));
    settle();
    const at700 = windowAt(1440, 700);
    frames(1);
    expect(bounds().bottom).toBe(at700.bottomLine);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });
});

/** Review 1 LOW-3: the guards the first round's mutants showed untested. */
describe('the guards (review 1 LOW-3)', () => {
  it('counts the body\'s padding in the height it needs', () => {
    chromeAt(1440, 900);
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);
      if (!element.classList.contains('node-inspector-popover__body')) return style;
      return { ...style, paddingTop: '8px', paddingBottom: '12px' } as CSSStyleDeclaration;
    });
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    expect(bounds().height).toBe(300 + CHROME + 20);
  });

  it('a frame where the node moves and its content changes places it afresh by the node, with no spring', () => {
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds().top).toBe(192);
    // An agent's edit moves the node and changes its params in one update.
    anchorRect = rect(560, 260, 82, 56);
    contentHeight = 340;
    frames(1);
    expect(bounds()).toEqual({ top: 252, height: 340 + CHROME, bottom: 252 + 340 + CHROME });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('does not spring when the content changes but the height on screen does not (at the cap)', () => {
    chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    settle();
    const before = bounds();
    contentHeight = 2400;
    frames(2);
    expect(bounds()).toEqual(before);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('a held top stays under the top line when the chrome above grows', () => {
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 170, 82, 56));
    settle();
    contentHeight = 350;
    frames(1);
    expect(bounds().top).toBe(162);
    // A taller top chrome arrives: the line is now 312.
    place({ 'data-top-bar': '' }, () => rect(0, 24, 1440, 276));
    frames(1);
    // Its top on the new line; as tall as the room left under it (442 px).
    expect(bounds()).toEqual({ top: 312, height: 754 - 312, bottom: 754 });
  });

  it('a held top that would leave it under 300 px gives way to a fresh placement', () => {
    chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    settle();
    contentHeight = 200;
    frames(1);
    expect(bounds()).toEqual({ top: 392, height: 315, bottom: 707 });
    // The Canvas actions panel opens under it: the bottom line goes up to 426.
    place({ 'data-bottom-bar': 'panel' }, () => rect(565, 500, 400, 328));
    frames(1);
    expect(bounds()).toEqual({ top: 154, height: 426 - 154, bottom: 426 });
  });

  it('under its node (no room beside it) it follows the node and never holds a top', () => {
    chromeAt(1440, 900);
    contentHeight = 185;
    openBeside(rect(200, 200, 1100, 56));
    settle();
    expect(panel().dataset.placement).toBe('bottom');
    expect(bounds().top).toBe(266);
    contentHeight = 416;
    frames(1);
    // Placed afresh: as tall as its body, shifted up to the band's line.
    expect(bounds()).toEqual({ top: 754 - 531, height: 531, bottom: 754 });
  });

  it(`CONTENT_RESIZE_MS covers the spring's own duration and a frame or two`, () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/panels.css'), 'utf8');
    const spring = Number(/--inspector-layout-spring:\s*(\d+)ms/.exec(css)?.[1]);
    expect(spring).toBe(360);
    expect(CONTENT_RESIZE_MS).toBeGreaterThanOrEqual(spring + 2 * 16);
    expect(CONTENT_RESIZE_MS).toBeLessThanOrEqual(spring + 100);
  });

  it('the open is GM r82\'s: 2 stable frames, capped at 300 ms', () => {
    expect(OPEN_STABLE_FRAMES).toBe(2);
    expect(OPEN_SETTLE_CAP_MS).toBe(300);
  });
});

/**
 * Review 1 NIT-2, GM r82: "A flip in bottom placement springs like every
 * other move." Under its node, the panel follows the node's bottom edge, so
 * the card growing (a preview landing) moves it: on the spring, never a jump.
 */
describe('the card growing under the panel (GM r82)', () => {
  it('moves a panel under the node on the spring, and flips it above on the spring too', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 1400);
    contentHeight = 185;
    openBeside(rect(200, 500, 1100, 56));
    settle();
    expect(panel().dataset.placement).toBe('bottom');
    expect(bounds().top).toBe(566);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    // The card grows downward (its top stays): the panel moves down with it.
    anchorRect = rect(200, 500, 1100, 156);
    frames(1);
    expect(bounds().top).toBe(666);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    // It grows past the room under it: the panel flips above, on the spring.
    anchorRect = rect(200, 500, 1100, 500);
    frames(1);
    expect(panel().dataset.placement).toBe('top');
    expect(bounds().top).toBe(500 - 10 - 300);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    // A move stays rigid: it ends the spring and follows the node at once.
    anchorRect = rect(200, 480, 1100, 500);
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    expect(bounds().top).toBe(480 - 10 - 300);
  });

  it('beside the node, the card growing moves nothing and starts no spring', () => {
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    const before = bounds();
    anchorRect = rect(560, 200, 82, 180);
    frames(1);
    expect(bounds()).toEqual(before);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
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

describe('one source for the toolbar+12 top line (GM r72)', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../../src', path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it('the popover takes its top line from floatingChromeTopLine and its bottom line from the band', () => {
    const source = read('components/panels/NodeInspectorPopover.tsx');
    expect(source).toMatch(/const topLimit = floatingChromeTopLine\(VIEWPORT_GUTTER\)/);
    expect(source).toMatch(/floatingBottomLimit\([^)]*FLOATING_CHROME_CLEARANCE\)/);
    // No second spelling of the line: no clearance passed to floatingTopLimit here.
    expect(source).not.toMatch(/floatingTopLimit\([^)]*,/);
    expect(source).not.toMatch(/floatingBarLimit/);
  });
  it('bottomBar.ts is the only place the 12 px clearance is written', () => {
    const lib = read('lib/bottomBar.ts');
    expect(lib).toMatch(/export const FLOATING_CHROME_CLEARANCE = 12;/);
    expect(lib).toMatch(/return floatingTopLimit\(gutter, FLOATING_CHROME_CLEARANCE\)/);
  });
});
