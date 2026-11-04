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

  it('under the node, the card growing holds no top: a resize after it moves the panel at once (GM r92 is beside only)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 1400);
    contentHeight = 185;
    openBeside(rect(200, 500, 1100, 56));
    settle();
    anchorRect = rect(200, 500, 1100, 156);
    frames(1);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    expect(panel().dataset.placement).toBe('bottom');
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    // Too short for it under the node now: it flips above, at once.
    windowAt(1440, 1000);
    frames(1);
    expect(panel().dataset.placement).toBe('top');
    expect(bounds().top).toBe(500 - 10 - 300);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
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

/**
 * Review 2 LOW-1: the moves review 2's mutants showed untested. A zoom
 * changes the card's size and its place together; a resize can land in the
 * same frame as a move. Both are moves: rigid, never the spring (review 7 M2).
 */
describe('a move that comes with a size change (review 2 LOW-1)', () => {
  it('a zoom (the card moves and grows in one frame) moves the panel at once, with no spring', () => {
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds().top).toBe(192);
    // Zoomed in about the pointer: the card is larger and somewhere else.
    anchorRect = rect(540, 180, 123, 84);
    frames(1);
    expect(bounds().top).toBe(172);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('a resize in the same frame as a move drops the held top without a glide', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 150;
    openBeside(rect(560, 400, 82, 56));
    settle();
    contentHeight = 450;
    frames(1);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    expect(bounds()).toEqual({ top: 392, height: 754 - 392, bottom: 754 });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    // The window gets shorter and the canvas pans the node in one frame.
    const at700 = windowAt(1440, 700);
    anchorRect = rect(560, 380, 82, 56);
    frames(1);
    expect(bounds()).toEqual({ top: at700.topLine, height: at700.bottomLine - at700.topLine, bottom: at700.bottomLine });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });
});

/**
 * Review 3 MEDIUM-1, GM r92: "hold the top, as r68 says. A move is read from
 * the node's own box. A card offset change inside a node that hasn't moved
 * counts as growth: the top holds, the height springs, and the file row
 * stays under the pointer."
 *
 * The card (`.model-node__card`, the anchor) sits in its React Flow node
 * (`.react-flow__node`) on the canvas (`.react-flow__viewport`, its pan and
 * zoom in its transform). Review 3 measured an Image Input upload live at
 * 1440x1000: the node stays at 156.5, while its card goes from 200 + 56 to
 * 236.6 + 180 (the preview raises the node's top padding), and the panel's
 * need from 300 to 486 px.
 */
describe('a preview landing in a node that has not moved (review 3 MEDIUM-1, GM r92)', () => {
  const rowTop = () => bounds().top + 72;
  let nodeRect: DOMRect;
  let canvas: HTMLElement;

  /** The canvas, the node on it and its card, which the panel opens beside. */
  function openInNode(node: DOMRect, card: DOMRect) {
    nodeRect = node;
    anchorRect = card;
    canvas = place({ class: 'react-flow__viewport' }, () => rect(0, 0, innerWidth, innerHeight));
    canvas.style.transform = 'translate(0px, 0px) scale(1)';
    const flowNode = document.createElement('div');
    flowNode.className = 'react-flow__node';
    flowNode.getBoundingClientRect = () => nodeRect;
    const anchor = document.createElement('div');
    anchor.className = 'model-node__card';
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => anchorRect;
    flowNode.append(anchor);
    canvas.append(flowNode);
    render(<NodeInspectorPopover />);
    frames(1);
  }

  for (const together of [false, true]) {
    it(`holds its top and springs its height${together ? ', the card and the body changing in one frame' : ''}`, () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      chromeAt(1440, 1000);
      contentHeight = 300 - CHROME;
      openInNode(rect(560, 156.5, 82, 121.7), rect(560, 200, 82, 56));
      settle();
      expect(bounds()).toEqual({ top: 192, height: 300, bottom: 492 });
      const row = rowTop();
      if (!together) {
        // The preview's first frame: the card's top shifts inside the node, the body not yet taller.
        nodeRect = rect(560, 156.5, 82, 103.9);
        anchorRect = rect(560, 236.6, 82, 23.8);
        frames(1);
        expect(bounds()).toEqual({ top: 192, height: 300, bottom: 492 });
        expect(rowTop()).toBe(row);
      }
      nodeRect = rect(560, 156.5, 82, 309.8);
      anchorRect = rect(560, 236.6, 82, 180);
      contentHeight = 486 - CHROME;
      frames(1);
      // The top holds, the new height is on the spring, the file row is where it was.
      expect(bounds()).toEqual({ top: 192, height: 486, bottom: 678 });
      expect(panel().hasAttribute('data-content-resizing')).toBe(true);
      expect(rowTop()).toBe(row);
      act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
      frames(2);
      expect(bounds()).toEqual({ top: 192, height: 486, bottom: 678 });
      expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    });
  }

  it('a card whose top shifts at the same size is growth too, not a move', () => {
    chromeAt(1440, 1000);
    contentHeight = 300 - CHROME;
    openInNode(rect(560, 156.5, 82, 121.7), rect(560, 200, 82, 56));
    settle();
    anchorRect = rect(560, 236.6, 82, 56);
    frames(2);
    expect(bounds().top).toBe(192);
  });

  it('a real move still places it afresh by the card, at once (a drag, an agent move, an undo)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 1000);
    contentHeight = 300 - CHROME;
    openInNode(rect(560, 156.5, 82, 121.7), rect(560, 200, 82, 56));
    settle();
    // The preview lands: the top is held at 192.
    nodeRect = rect(560, 156.5, 82, 309.8);
    anchorRect = rect(560, 236.6, 82, 180);
    contentHeight = 486 - CHROME;
    frames(1);
    expect(bounds().top).toBe(192);
    // The node moves 40 px down: the held top goes, it is placed by the card, rigid.
    nodeRect = rect(560, 196.5, 82, 309.8);
    anchorRect = rect(560, 276.6, 82, 180);
    frames(1);
    expect(bounds()).toEqual({ top: 268.6, height: 486, bottom: 754.6 });
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('a zoom about the node\'s corner is a move (the canvas transform), not growth', () => {
    chromeAt(1440, 1000);
    contentHeight = 300 - CHROME;
    openInNode(rect(560, 156.5, 82, 121.7), rect(560, 200, 82, 56));
    settle();
    // The node's corner stays put; the canvas scales, so the card's offset and size grow.
    canvas.style.transform = 'translate(-112px, -31.3px) scale(1.2)';
    nodeRect = rect(560, 156.5, 98.4, 146);
    anchorRect = rect(560, 208.7, 98.4, 67.2);
    frames(1);
    expect(bounds().top).toBe(200.7);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  });

  it('a window resize still re-places it', () => {
    chromeAt(1440, 1000);
    contentHeight = 300 - CHROME;
    openInNode(rect(560, 156.5, 82, 121.7), rect(560, 200, 82, 56));
    settle();
    nodeRect = rect(560, 156.5, 82, 309.8);
    anchorRect = rect(560, 236.6, 82, 180);
    contentHeight = 486 - CHROME;
    frames(1);
    expect(bounds().top).toBe(192);
    windowAt(1440, 900);
    frames(1);
    // Placed afresh by the card: its top at 236.6 - 8.
    expect(bounds().top).toBeCloseTo(228.6, 5);
  });
});

/**
 * Review 2 LOW-2: closing clears the frame, so a reopen never paints the last
 * open's frame (for one frame, or for good when the node has no card on
 * screen to place it by).
 */
describe('closing clears the frame (review 2 LOW-2)', () => {
  it('a reopen paints nothing of the last open before it measures', () => {
    chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds().top).toBe(192);
    setVisible(false);
    // The node moved while the panel was closed.
    anchorRect = rect(560, 400, 82, 56);
    act(() => useUIStore.getState().setInspectorVisible(true));
    // Committed, not yet measured: no panel at the old place.
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
    frames(1);
    // Placed by the node where it is now (shifted up to the band's line).
    expect(bounds()).toEqual({ top: 754 - (416 + CHROME), height: 416 + CHROME, bottom: 754 });
  });

  it('a reopen with no card on screen shows nothing, not the last frame', () => {
    chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds()).toEqual({ top: 154, height: 600, bottom: 754 });
    setVisible(false);
    // A shorter window, and the node's card is off screen (no anchor).
    windowAt(1024, 640);
    placed.filter((element) => element.hasAttribute('data-node-inspector-anchor')).forEach((element) => element.remove());
    setVisible(true);
    frames(3);
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
  });
});

/**
 * The rule that shows the foot's hairline, read from the stylesheet (its CSS
 * is pinned in inspectorBodyFade.test.tsx): the one foot::before rule at
 * opacity 1, less the theme's body class and the pseudo-element, so the
 * foot `matches` it exactly when the line shows.
 */
const HAIRLINE_SELECTOR = (() => {
  const restraint = readFileSync(resolve(__dirname, '../../src/styles/slava-restraint.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
  const shown = [...restraint.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector, block]) => /node-inspector-popover__foot[^\s]*::before/.test(selector) && /opacity:\s*1;/.test(block));
  expect(shown).toHaveLength(1);
  return shown[0][1].trim().replace(/^body\.app-slava-restraint\s+/, '').replace(/::before$/, '');
})();
const hairline = () => panel().querySelector<HTMLElement>('.node-inspector-popover__foot')!.matches(HAIRLINE_SELECTOR);

/**
 * GM r87 (review 2 MEDIUM-1): "A 1 px hairline in the Restraint border token
 * on the top edge of the Run/Duplicate/Delete foot row whenever the body can
 * scroll further down; gone at the end. ... Test: a capped body not scrolled
 * to the end always shows the hairline, incl. cuts between fields (the 900
 * and 820 cases); at the end it's gone."
 *
 * The hairline is the foot's ::before, shown by
 * `.node-inspector-popover__foot[data-more-below]` (styles/slava-restraint.css;
 * its CSS is pinned in inspectorBodyFade.test.tsx), which the popover sets
 * from the body's overflow (GM r98: held through a height spring).
 * jsdom draws no pseudo-elements, so these tests check that the rule's
 * selector matches the foot. It reads the scroll position only, never where
 * the cut falls: review 2 measured the low Style Reference's cut between
 * fields at 1440x900 (the Strength slider wholly under it, 291 px changed by
 * the fade) and at 1440x820 (only the gap between fields: 0 px changed).
 * Content: 602 px, as measured live (117 px of scroll at 1440x900).
 */
describe("the foot row's hairline while there is more below (GM r87)", () => {
  const LOW = () => rect(560, 784, 82, 56);
  const left = () => body().scrollHeight - body().clientHeight - body().scrollTop;
  /** The body's size changed: ScrollFade re-measures (a ResizeObserver in the
   *  app; jsdom has none, so its window listener stands in). */
  const relayout = () => {
    act(() => { window.dispatchEvent(new Event('resize')); });
    frames(1);
  };
  const scrollTo = (top: number) => {
    body().scrollTop = top;
    fireEvent.scroll(body());
    frames(1);
  };

  for (const height of [900, 820]) {
    it(`at 1440x${height}, a low Style Reference shows it until the end of the scroll, then not`, () => {
      const { bottomLine } = chromeAt(1440, height);
      contentHeight = 602;
      openBeside(LOW());
      settle();
      relayout();
      expect(bounds().bottom).toBe(bottomLine);
      expect(left()).toBeGreaterThan(1);
      expect(hairline()).toBe(true);
      // Part of the way down: still more below.
      scrollTo(Math.floor((body().scrollHeight - body().clientHeight) / 2));
      expect(hairline()).toBe(true);
      // At the end it's gone, and back once there is more below again.
      scrollTo(body().scrollHeight - body().clientHeight);
      expect(left()).toBe(0);
      expect(hairline()).toBe(false);
      scrollTo(body().scrollHeight - body().clientHeight - 2);
      expect(hairline()).toBe(true);
    });
  }

  it('from 900 to 640 px tall, wherever the cut falls, it shows exactly while the body can scroll down', () => {
    chromeAt(1440, 900);
    contentHeight = 602;
    openBeside(LOW());
    settle();
    let shown = 0;
    for (let height = 900; height >= 640; height -= 4) {
      windowAt(1440, height);
      frames(1);
      relayout();
      expect(left(), `at ${height}`).toBeGreaterThan(1);
      expect(hairline(), `at ${height}`).toBe(true);
      shown += 1;
    }
    expect(shown).toBe(66);
  });

  it('a body that fits has none', () => {
    chromeAt(1440, 900);
    contentHeight = 416;
    openBeside(LOW());
    settle();
    relayout();
    expect(left()).toBe(0);
    expect(hairline()).toBe(false);
  });
});

/**
 * GM r92 Q3 (review 3 LOW-1): "the line waits until the open has settled.
 * It's hidden during the open (images complete + 2 frames, 300 ms cap), then
 * shows if there's more to scroll, on the pop spring. Add a test that an
 * empty Style Reference open never shows the line." Q2: "keep the hairline
 * on the pinned Inspector. Wherever a body scrolls, it's the same cue."
 *
 * Review 3 measured the empty Style Reference open live: the panel holds 531
 * px while its content settles, overflowing by 10 px down to 1 over about 10
 * frames, and the line read 1 from the first painted frame.
 */
describe('the hairline waits for the open to settle (GM r92 Q2, Q3)', () => {
  const LOW = () => rect(560, 784, 82, 56);
  const relayout = () => {
    act(() => { window.dispatchEvent(new Event('resize')); });
    frames(1);
  };
  const more = () => body().getAttribute('data-scroll-more') === 'true';

  it('an empty Style Reference open never shows it, though its body overflows while it settles', () => {
    chromeAt(1440, 900);
    contentHeight = 426;
    // The panel holds 531 px on screen while its content settles from 426 px to 416.
    animated = 531;
    openBeside(rect(560, 200, 82, 56));
    let overflowed = 0;
    for (let content = 426; content >= 416; content -= 1) {
      contentHeight = content;
      relayout();
      if (more()) overflowed += 1;
      expect(panel().hasAttribute('data-opening'), `at ${content}`).toBe(true);
      expect(hairline(), `at ${content}`).toBe(false);
    }
    // The body did overflow while it settled: 10 px down to 2 (ScrollFade
    // counts more than 1 px as more below).
    expect(overflowed).toBe(9);
    // Settled at 531, nothing below: still none.
    animated = null;
    settle();
    relayout();
    expect(panel().hasAttribute('data-opening')).toBe(false);
    expect(more()).toBe(false);
    expect(hairline()).toBe(false);
  });

  it('waits for the open\'s own spring too: the body overflows while the panel springs to its content (measured live)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    // Live, on an empty Style Reference: the content's late 10 px lands in
    // the open, so the panel springs from 521 to 531 px; the body overflows
    // by the spring's lag (10 px down to 0 over about 10 frames) while the
    // height it needs already holds, so the open itself ends in 2 frames.
    contentHeight = 406;
    openBeside(rect(560, 200, 82, 56));
    contentHeight = 416;
    let overflowed = 0;
    let afterOpen = 0;
    for (let shown = 521; shown <= 531; shown += 1) {
      animated = shown;
      relayout();
      if (more()) overflowed += 1;
      if (more() && !panel().hasAttribute('data-opening')) afterOpen += 1;
      expect(panel().hasAttribute('data-content-resizing'), `at ${shown}`).toBe(true);
      expect(hairline(), `at ${shown}`).toBe(false);
    }
    expect(overflowed).toBe(9);
    // The open ended while the spring still ran and the body overflowed.
    expect(afterOpen).toBeGreaterThan(0);
    animated = null;
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    relayout();
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    expect(hairline()).toBe(false);
  });

  it('after a growth spring that ends with more below, it shows once the spring stops', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds()).toEqual({ top: 192, height: 415, bottom: 607 });
    // An upload: the top holds, the panel springs to the band's line (562 px) and the rest scrolls.
    contentHeight = 602;
    animated = 415;
    frames(1);
    relayout();
    expect(bounds()).toEqual({ top: 192, height: 562, bottom: 754 });
    expect(more()).toBe(true);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(hairline()).toBe(false);
    animated = null;
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    relayout();
    expect(more()).toBe(true);
    expect(hairline()).toBe(true);
  });

  it('a long body shows it once the open has settled', () => {
    chromeAt(1440, 900);
    contentHeight = 602;
    openBeside(LOW());
    relayout();
    expect(more()).toBe(true);
    expect(panel().hasAttribute('data-opening')).toBe(true);
    expect(hairline()).toBe(false);
    settle();
    expect(panel().hasAttribute('data-opening')).toBe(false);
    expect(hairline()).toBe(true);
  });

  it(`with an image still loading, it shows at the ${OPEN_SETTLE_CAP_MS} ms cap`, () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    mock.image = true;
    imageLoaded = false;
    contentHeight = 602;
    openBeside(LOW());
    frames(6);
    relayout();
    expect(more()).toBe(true);
    act(() => { vi.advanceTimersByTime(OPEN_SETTLE_CAP_MS - 1); });
    expect(hairline()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(hairline()).toBe(true);
  });

  it('another node, and a reopen, wait again', () => {
    chromeAt(1440, 900);
    contentHeight = 602;
    openBeside(LOW());
    settle();
    relayout();
    expect(hairline()).toBe(true);
    place({ 'data-node-inspector-anchor': 'n2' }, () => LOW());
    act(() => {
      useUIStore.getState().selectNode('n2');
      useUIStore.getState().setInspectorVisible(true);
    });
    // Committed for n2, before any frame: not n1's line.
    expect(panel()).not.toBeNull();
    expect(hairline()).toBe(false);
    frames(1);
    relayout();
    expect(more()).toBe(true);
    expect(hairline()).toBe(false);
    settle();
    expect(hairline()).toBe(true);
    setVisible(false);
    act(() => useUIStore.getState().setInspectorVisible(true));
    frames(1);
    relayout();
    expect(more()).toBe(true);
    expect(hairline()).toBe(false);
    settle();
    expect(hairline()).toBe(true);
  });

  it('the pinned Inspector shows it too, after the same settle', () => {
    useUIStore.getState().setInspectorPinned(true);
    chromeAt(1440, 900);
    contentHeight = 2000;
    openBeside(rect(560, 200, 82, 56));
    relayout();
    expect(panel()).toHaveClass('node-inspector-popover--pinned');
    expect(more()).toBe(true);
    expect(hairline()).toBe(false);
    frames(1 + OPEN_STABLE_FRAMES);
    expect(panel().hasAttribute('data-opening')).toBe(false);
    expect(hairline()).toBe(true);
    // At the end of the scroll it goes, as on the floating one.
    body().scrollTop = body().scrollHeight - body().clientHeight;
    fireEvent.scroll(body());
    frames(1);
    expect(hairline()).toBe(false);
  });
});

/**
 * GM r98: "HOLD the line's state while a height spring runs, rather than
 * hiding it. If the line is already showing (body scrolled partway, more
 * below) when a growth spring starts, it stays on, no blink. If it's off, it
 * stays off. When the spring rests, check again and spring to the new state.
 * ... Test: line on, then an image lands -> the line stays at 1 through the
 * spring and ends at whatever the rest state says."
 *
 * An upload in a Style Reference whose body scrolls: its "No preview" row
 * goes (416 px of content, the panel springs shorter, so mid-spring nothing
 * is below) and the image lands (the panel springs back taller, the body
 * scrolling again, or not, at rest). Each frame of the spring gives the
 * panel's height on screen (`animated`), so the body's overflow mid-spring is
 * the spring's lag; a line that read it live would blink.
 */
describe('the hairline holds its state through a height spring (GM r98)', () => {
  const more = () => body().getAttribute('data-scroll-more') === 'true';
  const relayout = () => {
    act(() => { window.dispatchEvent(new Event('resize')); });
    frames(1);
  };
  /** Steps the spring's on-screen height through `from` -> `to`, checking the line at each frame. */
  function springThrough(from: number, to: number, line: boolean, seen: { more: number; less: number }) {
    const step = from < to ? 7 : -7;
    for (let shown = from; step > 0 ? shown < to : shown > to; shown += step) {
      animated = shown;
      relayout();
      if (more()) seen.more += 1; else seen.less += 1;
      expect(panel().hasAttribute('data-content-resizing'), `at ${shown}`).toBe(true);
      expect(hairline(), `at ${shown}`).toBe(line);
    }
  }
  /** A Style Reference whose body scrolls (602 px in 600 - CHROME), scrolled partway: the line is on. */
  function scrolledPartway() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 602;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds()).toEqual({ top: 154, height: 600, bottom: 754 });
    body().scrollTop = 50;
    fireEvent.scroll(body());
    relayout();
    expect(more()).toBe(true);
    expect(hairline()).toBe(true);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
  }

  for (const landed of [602, 470]) {
    const after = landed === 602 ? 'still more below: it stays on' : 'nothing below now: it goes once the spring rests';
    it(`line on, an image lands: on through the spring; at rest, ${after}`, () => {
      scrolledPartway();
      const seen = { more: 0, less: 0 };
      // The "No preview" row goes: the panel springs from 600 to 531 px, its top held.
      contentHeight = 416;
      animated = 600;
      frames(1);
      expect(bounds()).toEqual({ top: 154, height: 531, bottom: 685 });
      springThrough(600, 531, true, seen);
      // The image lands mid-spring: the panel springs taller again.
      contentHeight = landed;
      const target = Math.min(600, landed + CHROME);
      frames(1);
      expect(bounds().height).toBe(target);
      springThrough(531, target, true, seen);
      // The body's overflow came and went under it (a live read would have blinked).
      expect(seen.less).toBeGreaterThan(0);
      animated = null;
      relayout();
      act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS - 1); });
      relayout();
      expect(panel().hasAttribute('data-content-resizing')).toBe(true);
      expect(hairline()).toBe(true);
      // Rested: read again.
      act(() => { vi.advanceTimersByTime(1); });
      expect(panel().hasAttribute('data-content-resizing')).toBe(false);
      expect(more()).toBe(landed === 602);
      expect(hairline()).toBe(landed === 602);
      relayout();
      expect(hairline()).toBe(landed === 602);
    });
  }

  it('line off, a growth spring: off through it, whatever the body shows mid-spring, then on at rest', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chromeAt(1440, 900);
    contentHeight = 300;
    openBeside(rect(560, 200, 82, 56));
    settle();
    expect(bounds()).toEqual({ top: 192, height: 415, bottom: 607 });
    expect(hairline()).toBe(false);
    const seen = { more: 0, less: 0 };
    // An upload: the top holds, the panel springs to the band's line (562 px) and the rest scrolls.
    contentHeight = 602;
    animated = 415;
    frames(1);
    expect(bounds()).toEqual({ top: 192, height: 562, bottom: 754 });
    springThrough(415, 562, false, seen);
    expect(seen.more).toBeGreaterThan(0);
    animated = null;
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS - 1); });
    relayout();
    expect(more()).toBe(true);
    expect(hairline()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(hairline()).toBe(true);
  });

  it('a move mid-spring ends the hold with the spring: the line reads the body at once', () => {
    scrolledPartway();
    contentHeight = 416;
    animated = 600;
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(true);
    expect(hairline()).toBe(true);
    // The node is dragged: rigid, the spring is over, and nothing is below the 531 px panel.
    animated = null;
    anchorRect = rect(560, 240, 82, 56);
    frames(1);
    expect(panel().hasAttribute('data-content-resizing')).toBe(false);
    relayout();
    expect(more()).toBe(false);
    expect(hairline()).toBe(false);
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
