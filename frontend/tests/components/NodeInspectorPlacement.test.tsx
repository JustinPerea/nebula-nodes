import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';

/**
 * GM - Design, 2026-10-23 (the separate bug in the cover screenshot): "the
 * Inspector opened low runs past the bottom edge, so its Run / Duplicate /
 * Delete row is cut off and it overlaps the bottom bar. Clamp it so it stays
 * above the bottom bar inside the viewport. When there's no room below the
 * node, flip it up or shift it, so its foot row is always whole."
 *
 * jsdom has no layout: the node's anchor and the bottom bar get the rects the
 * live check measured at 1280x800 (the bar 395-885 x 729-776).
 */

vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => <label>Prompt<textarea defaultValue="a lighthouse at dusk" /></label>,
}));

const GUTTER = 16;
let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;
let previousUi: ReturnType<typeof useUIStore.getState>;
let bar: HTMLElement | null = null;
let anchorRect: DOMRect;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function viewport(width: number, height: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  fireEvent(window, new Event('resize'));
}

/** The canvas's bottom bar (Run / Canvas actions / zoom), 24 px off the bottom, 47 px tall. */
function bottomBar(width: number, height: number) {
  bar?.remove();
  bar = document.createElement('div');
  bar.className = 'toolbar toolbar--grouped';
  bar.setAttribute('data-bottom-bar', '');
  const barWidth = 490;
  bar.getBoundingClientRect = () => rect((width - barWidth) / 2, height - 24 - 47, barWidth, 47);
  document.body.append(bar);
  return bar.getBoundingClientRect();
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
  const left = parseFloat(style.left);
  const top = parseFloat(style.top);
  const width = parseFloat(style.width);
  const height = parseFloat(style.height);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function openBeside(node: DOMRect, width = 1280, height = 800, withBar = true) {
  viewport(width, height);
  if (withBar) bottomBar(width, height);
  anchorRect = node;
  const anchor = document.createElement('div');
  anchor.dataset.nodeInspectorAnchor = 'n1';
  anchor.getBoundingClientRect = () => anchorRect;
  document.body.append(anchor);
  render(<NodeInspectorPopover />);
  advanceLayout();
}

/** Whole, inside the viewport, and above the bar (when there is one). */
function expectWholeAndClear() {
  const box = bounds();
  const barTop = bar?.getBoundingClientRect().top ?? null;
  expect(box.top).toBeGreaterThanOrEqual(GUTTER);
  expect(box.left).toBeGreaterThanOrEqual(GUTTER);
  expect(box.right).toBeLessThanOrEqual(window.innerWidth - GUTTER);
  expect(box.bottom).toBeLessThanOrEqual(window.innerHeight - GUTTER);
  if (barTop !== null) expect(box.bottom).toBeLessThan(barTop);
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
  useUIStore.getState().setInspectorPinned(false);
  useUIStore.getState().selectNode('n1');
  useUIStore.getState().setInspectorVisible(true);
});

afterEach(() => {
  cleanup();
  bar?.remove();
  bar = null;
  document.querySelectorAll('[data-node-inspector-anchor]').forEach((element) => element.remove());
  useUIStore.setState(previousUi, true);
  vi.unstubAllGlobals();
});

describe('the floating Inspector beside a node low on the screen', () => {
  it('GM\'s setup: shifts up so it ends above the bottom bar, still beside the node', () => {
    // The cover screenshot: a Text Input at 575-657 x 437-527 at 1280x800.
    openBeside(rect(575, 437, 82, 90));
    expect(panel()).toHaveAttribute('data-placement', 'right');
    expect(bounds().left).toBeGreaterThan(657);
    expectWholeAndClear();
  });

  it('a node right on the bar: shifts up to the bar, never under it', () => {
    openBeside(rect(575, 700, 82, 90));
    expectWholeAndClear();
  });

  it('with no room beside the node, flips above it when there is no room below', () => {
    // A narrow window: neither side fits the Inspector, so it goes under the
    // node, and here under would cross the bar.
    openBeside(rect(200, 420, 200, 160), 600, 800);
    expect(panel()).toHaveAttribute('data-placement', 'top');
    expect(bounds().bottom).toBeLessThanOrEqual(420);
    expectWholeAndClear();
  });

  it('at 1440x900 too', () => {
    openBeside(rect(640, 560, 82, 90), 1440, 900);
    expectWholeAndClear();
  });
});

describe('the floating Inspector near the other edges', () => {
  it('a node above the top edge: stays inside the top', () => {
    openBeside(rect(575, -60, 82, 90));
    expectWholeAndClear();
  });

  it('a node mostly off the left edge: stays inside the left', () => {
    openBeside(rect(-200, 300, 150, 90));
    expectWholeAndClear();
  });

  it('a node at the right edge: opens on its left, inside the right', () => {
    openBeside(rect(1180, 300, 150, 90));
    expect(panel()).toHaveAttribute('data-placement', 'left');
    expectWholeAndClear();
  });

  it('with no bottom bar on screen, keeps the viewport gutter', () => {
    openBeside(rect(575, 700, 82, 90), 1280, 800, false);
    expect(bounds().bottom).toBe(800 - GUTTER);
  });
});

describe('the floating Inspector after a resize', () => {
  it('follows the bar when the window gets shorter', () => {
    openBeside(rect(640, 600, 82, 90), 1440, 900);
    expectWholeAndClear();
    viewport(1280, 640);
    bottomBar(1280, 640);
    anchorRect = rect(575, 480, 82, 90);
    advanceLayout();
    expectWholeAndClear();
  });

  it('follows the bar when it grows (the Canvas actions panel open above it)', () => {
    openBeside(rect(575, 437, 82, 90));
    const menu = document.createElement('section');
    menu.setAttribute('data-bottom-bar', 'panel');
    menu.getBoundingClientRect = () => rect(485, 480, 310, 237);
    document.body.append(menu);
    advanceLayout();
    try {
      expect(bounds().bottom).toBeLessThan(480);
      expect(bounds().top).toBeGreaterThanOrEqual(GUTTER);
    } finally {
      menu.remove();
    }
  });
});

describe('the Canvas actions panel open elsewhere along the bar', () => {
  // Review, 2026-10-23: the panel is 310 px wide and centred (485-795 at
  // 1280), so it only pushes up what it is under; the bar stays a full band.
  function openActionsPanel() {
    const menu = document.createElement('section');
    menu.setAttribute('data-bottom-bar', 'panel');
    menu.getBoundingClientRect = () => rect(485, 412, 310, 237);
    document.body.append(menu);
    return menu;
  }

  it('leaves the floating Inspector level with a node on the far left', () => {
    openBeside(rect(40, 500, 160, 90));
    const before = bounds();
    expect(before.right).toBeLessThan(485);
    const menu = openActionsPanel();
    try {
      advanceLayout();
      expect(bounds().top).toBe(before.top);
      expect(bounds().height).toBe(before.height);
      expectWholeAndClear();
    } finally {
      menu.remove();
    }
  });

  it('leaves the pinned Inspector on the left rail its full height', () => {
    useUIStore.getState().setInspectorPinned(true);
    openBeside(rect(40, 500, 160, 90));
    expect(bounds().height).toBe(440);
    const before = bounds();
    const menu = openActionsPanel();
    try {
      advanceLayout();
      expect(bounds().height).toBe(440);
      expect(bounds().top).toBe(before.top);
    } finally {
      menu.remove();
    }
  });
});

describe('the pinned Inspector', () => {
  it('rests above the bottom bar', () => {
    useUIStore.getState().setInspectorPinned(true);
    openBeside(rect(575, 437, 82, 90), 1280, 800);
    expectWholeAndClear();
    viewport(1280, 640);
    bottomBar(1280, 640);
    advanceLayout();
    expectWholeAndClear();
  });
});
