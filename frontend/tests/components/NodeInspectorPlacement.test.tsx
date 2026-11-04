import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NodeInspectorPopover, PORT_CLEARANCE } from '../../src/components/panels/NodeInspectorPopover';
import { houseDots } from '../helpers/houseDots';
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

/**
 * GM r111: a port is a drag source and can't sit under the panel. The panel
 * sits 8 px clear of the outer edge of the facing port's dot: right of the
 * node, its output ports; left of it, its input ports. With no port on the
 * facing side the gap stays 10 px from the card. The dot is measured as it is
 * on screen, so the rule holds at every zoom.
 *
 * The house skin's port (slava-restraint.css): a 20 px handle (its layout
 * width), centred 14 px out from the card's edge, its 9 px dot drawn 4 px
 * toward the card; so at zoom z the dot's outer edge is 14.5 z px out.
 */
describe('the gap to the facing port (GM r111)', () => {
  let flowNode: HTMLElement | null = null;

  afterEach(() => {
    flowNode?.remove();
    flowNode = null;
    vi.restoreAllMocks();
  });

  /** A node at a zoom, its card at `card` on screen, with ports on the sides named (one or more per side). */
  function openNode(card: DOMRect, ports: { left?: number[]; right?: number[] }, zoom = 1, width = 1440, height = 900) {
    viewport(width, height);
    bottomBar(width, height);
    houseDots();
    anchorRect = card;
    flowNode = document.createElement('div');
    flowNode.className = 'react-flow__node';
    flowNode.getBoundingClientRect = () => anchorRect;
    const anchor = document.createElement('div');
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => anchorRect;
    flowNode.append(anchor);
    for (const side of ['left', 'right'] as const) {
      // Each port's centre, out from the card's edge, in layout px (14 by default; more for a port set further out).
      for (const out of ports[side] ?? []) {
        const handle = document.createElement('div');
        handle.className = `react-flow__handle react-flow__handle-${side}`;
        Object.defineProperty(handle, 'offsetWidth', { value: 20 });
        handle.getBoundingClientRect = () => {
          const centre = side === 'right' ? anchorRect.right + out * zoom : anchorRect.left - out * zoom;
          return rect(centre - 10 * zoom, anchorRect.top + 20 * zoom, 20 * zoom, 20 * zoom);
        };
        flowNode.append(handle);
      }
    }
    document.body.append(flowNode);
    render(<NodeInspectorPopover />);
    advanceLayout();
  }

  for (const zoom of [0.5, 1, 2]) {
    it(`right, with an output port, at zoom ${zoom}: 8 px clear of its dot`, () => {
      openNode(rect(400, 300, 180 * zoom, 120 * zoom), { left: [14], right: [14] }, zoom);
      expect(panel()).toHaveAttribute('data-placement', 'right');
      const dot = 400 + 180 * zoom + 14.5 * zoom;
      expect(bounds().left).toBeCloseTo(dot + PORT_CLEARANCE, 5);
    });

    it(`left, with an input port, at zoom ${zoom}: 8 px clear of its dot`, () => {
      // Near the right edge, so it opens on the left.
      const cardLeft = 1440 - 16 - 180 * zoom - 60;
      openNode(rect(cardLeft, 300, 180 * zoom, 120 * zoom), { left: [14], right: [14] }, zoom);
      expect(panel()).toHaveAttribute('data-placement', 'left');
      const dot = cardLeft - 14.5 * zoom;
      expect(bounds().right).toBeCloseTo(dot - PORT_CLEARANCE, 5);
    });
  }

  it('right, with no output port: 10 px from the card (an input port on the far side changes nothing)', () => {
    openNode(rect(400, 300, 180, 120), { left: [14] });
    expect(panel()).toHaveAttribute('data-placement', 'right');
    expect(bounds().left).toBe(400 + 180 + 10);
  });

  it('left, with no input port: 10 px from the card (an output port on the far side changes nothing)', () => {
    openNode(rect(1200, 300, 180, 120), { right: [14] });
    expect(panel()).toHaveAttribute('data-placement', 'left');
    expect(bounds().right).toBe(1200 - 10);
  });

  it('several ports on the facing side: clear of the outermost one', () => {
    openNode(rect(400, 300, 180, 120), { right: [14, 30, 20] });
    expect(bounds().left).toBeCloseTo(400 + 180 + 30.5 + PORT_CLEARANCE, 5);
  });

  it('a port hidden (no box) does not count', () => {
    openNode(rect(400, 300, 180, 120), { right: [14] });
    const hidden = document.createElement('div');
    hidden.className = 'react-flow__handle react-flow__handle-right';
    // Collapsed (no box), but further out than the shown port: it must not count.
    hidden.getBoundingClientRect = () => rect(900, 320, 0, 0);
    flowNode!.append(hidden);
    advanceLayout();
    expect(bounds().left).toBeCloseTo(400 + 180 + 14.5 + PORT_CLEARANCE, 5);
  });

  it('a port with no drawn dot (another skin) counts as its whole box', () => {
    openNode(rect(400, 300, 180, 120), { right: [14] });
    vi.restoreAllMocks();
    advanceLayout();
    // The handle's box: 584-604.
    expect(bounds().left).toBeCloseTo(400 + 180 + 24 + PORT_CLEARANCE, 5);
  });

  it('never nearer the card than 10 px: a dot inside that gap (far zoomed out) leaves it at 10', () => {
    openNode(rect(400, 300, 18, 12), { right: [14] }, 0.1);
    expect(bounds().left).toBeCloseTo(400 + 18 + 10, 5);
  });

  it('decides the side with the port counted: room at 10 px from the card but not past the port opens it on the left', () => {
    // Right of the card: 1440 - 16 - (card right + 10) = 230 would fit 228;
    // past the port (card right + 22.5) it is 217.5, so it opens on the left.
    const cardRight = 1440 - 16 - 10 - 230;
    openNode(rect(cardRight - 180, 300, 180, 120), { left: [14], right: [14] });
    expect(panel()).toHaveAttribute('data-placement', 'left');
    expect(bounds().right).toBeCloseTo(cardRight - 180 - 14.5 - PORT_CLEARANCE, 5);
  });

  it('a window resize re-places it by the same rule', () => {
    openNode(rect(400, 300, 180, 120), { left: [14], right: [14] });
    expect(bounds().left).toBeCloseTo(400 + 180 + 14.5 + PORT_CLEARANCE, 5);
    // Too narrow for the right now: it re-places on the left, clear of the input's dot.
    viewport(800, 900);
    bottomBar(800, 900);
    advanceLayout();
    expect(panel()).toHaveAttribute('data-placement', 'left');
    expect(bounds().right).toBeCloseTo(400 - 14.5 - PORT_CLEARANCE, 5);
  });

  it('a zoom re-places it at once, by the dot at the new zoom', () => {
    openNode(rect(400, 300, 180, 120), { right: [14] });
    let zoom = 1;
    const handle = flowNode!.querySelector<HTMLElement>('.react-flow__handle-right')!;
    handle.getBoundingClientRect = () => rect(anchorRect.right + 14 * zoom - 10 * zoom, 320, 20 * zoom, 20 * zoom);
    zoom = 2;
    anchorRect = rect(400, 300, 360, 240);
    advanceLayout();
    expect(bounds().left).toBeCloseTo(760 + 29 + PORT_CLEARANCE, 5);
  });

  it('the pinned Inspector stays docked by the rail, whatever ports the node has', () => {
    useUIStore.getState().setInspectorPinned(true);
    openNode(rect(400, 300, 180, 120), { left: [14], right: [14] });
    expect(panel()).toHaveAttribute('data-placement', 'pinned-left');
    expect(bounds().left).toBe(16);
  });
});
