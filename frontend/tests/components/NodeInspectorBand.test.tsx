import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';

/**
 * GM - Design, 2026-10-23:
 * 1. "Floating panels stop above a reserved notice band, whether or not a
 *    notice is showing ... The panels never move when a notice comes or goes,
 *    and a notice never covers Run / Duplicate / Delete. Those are what
 *    someone reaches for right after a restore."
 * 5. "Floating panels stop below the workspace header and the selection
 *    toolbar, whichever is lower, plus the same 8 px gap."
 *
 * jsdom has no layout: the node's anchor, the bar, the band, the header and
 * the selection toolbar get the rects the live check measured at 1280x800.
 */

vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => <label>Prompt<textarea defaultValue="a lighthouse at dusk" /></label>,
}));

const GAP = 8;
let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;
let previousUi: ReturnType<typeof useUIStore.getState>;
let anchorRect: DOMRect;
const chrome: HTMLElement[] = [];

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

function viewport(width: number, height: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  fireEvent(window, new Event('resize'));
}

function place(attrs: Record<string, string>, at: () => DOMRect): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.getBoundingClientRect = at;
  document.body.append(element);
  chrome.push(element);
  return element;
}

/** The bar (24 px off the bottom, 47 tall) and the region's band above it: one notice (46) plus its gap. */
function barAndBand(width: number, height: number) {
  const barTop = height - 24 - 47;
  place({ 'data-bottom-bar': '' }, () => rect((width - 490) / 2, barTop, 490, 47));
  place({ 'data-notice-band': '' }, () => rect(16, barTop - GAP - 54, width - 32, 54));
  return { barTop, bandTop: barTop - GAP - 54 };
}

const header = (width: number) => place({ 'data-top-bar': '' }, () => rect((width - 456) / 2, 24, 456, 40));
const selectionToolbar = (width: number) => place({ 'data-top-bar': '' }, () => rect((width - 550) / 2, 92, 550, 49));

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

function openBeside(node: DOMRect) {
  anchorRect = node;
  const anchor = document.createElement('div');
  anchor.dataset.nodeInspectorAnchor = 'n1';
  anchor.getBoundingClientRect = () => anchorRect;
  document.body.append(anchor);
  chrome.push(anchor);
  render(<NodeInspectorPopover />);
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
  useUIStore.getState().setInspectorPinned(false);
  useUIStore.getState().selectNode('n1');
  useUIStore.getState().setInspectorVisible(true);
});

afterEach(() => {
  cleanup();
  chrome.splice(0).forEach((element) => element.remove());
  useUIStore.setState(previousUi, true);
  vi.unstubAllGlobals();
});

describe('the floating Inspector and the reserved notice band', () => {
  it("GM's setup: it ends above the band, so a notice never covers its foot row", () => {
    viewport(1280, 800);
    const { bandTop } = barAndBand(1280, 800);
    header(1280);
    selectionToolbar(1280);
    // The cover screenshot: a Text Input at 575-657 x 437-527.
    openBeside(rect(575, 437, 82, 90));
    expect(panel()).toHaveAttribute('data-placement', 'right');
    expect(bounds().bottom).toBeLessThanOrEqual(bandTop);
  });

  it('never moves when a notice comes or goes: the band is reserved either way', () => {
    viewport(1280, 800);
    const { barTop, bandTop } = barAndBand(1280, 800);
    openBeside(rect(575, 437, 82, 90));
    const before = bounds();
    // A notice shows in the band: one line, 8 px above the bar.
    const notice = place({ role: 'status' }, () => rect(500, barTop - GAP - 46, 300, 46));
    advanceLayout();
    expect(bounds()).toEqual(before);
    notice.remove();
    advanceLayout();
    expect(bounds()).toEqual(before);
    expect(before.bottom).toBeLessThanOrEqual(bandTop);
  });

  it('at 1440x900 too', () => {
    viewport(1440, 900);
    const { bandTop } = barAndBand(1440, 900);
    openBeside(rect(640, 560, 82, 90));
    expect(bounds().bottom).toBeLessThanOrEqual(bandTop);
  });

  it('the pinned Inspector stops above the band too', () => {
    useUIStore.getState().setInspectorPinned(true);
    viewport(1280, 800);
    const { bandTop } = barAndBand(1280, 800);
    openBeside(rect(575, 437, 82, 90));
    expect(bounds().bottom).toBeLessThanOrEqual(bandTop);
  });
});

describe('the measured top line', () => {
  it('a node near the top: the Inspector opens below the selection toolbar, 8 px clear', () => {
    viewport(1280, 800);
    barAndBand(1280, 800);
    header(1280);
    selectionToolbar(1280);
    openBeside(rect(575, 40, 82, 90));
    expect(bounds().top).toBeGreaterThanOrEqual(92 + 49 + GAP);
  });

  it('follows the toolbar coming and going while it is open', () => {
    viewport(1280, 800);
    barAndBand(1280, 800);
    header(1280);
    openBeside(rect(575, 40, 82, 90));
    expect(bounds().top).toBe(24 + 40 + GAP);
    const tools = selectionToolbar(1280);
    advanceLayout();
    expect(bounds().top).toBe(92 + 49 + GAP);
    tools.remove();
    advanceLayout();
    expect(bounds().top).toBe(24 + 40 + GAP);
  });

  it('a short window: the room between the lines is less than the panel, so the panel gets shorter', () => {
    viewport(1280, 440);
    const { bandTop } = barAndBand(1280, 440);
    header(1280);
    selectionToolbar(1280);
    openBeside(rect(575, 200, 82, 90));
    const box = bounds();
    expect(box.top).toBe(92 + 49 + GAP);
    expect(box.bottom).toBe(bandTop);
    expect(box.height).toBeLessThan(300);
  });

  it('follows a resize', () => {
    viewport(1440, 900);
    barAndBand(1440, 900);
    header(1440);
    selectionToolbar(1440);
    openBeside(rect(640, 300, 82, 90));
    chrome.splice(0, 4).forEach((element) => element.remove());
    viewport(1280, 480);
    const { bandTop } = barAndBand(1280, 480);
    header(1280);
    selectionToolbar(1280);
    advanceLayout();
    const box = bounds();
    expect(box.top).toBeGreaterThanOrEqual(92 + 49 + GAP);
    expect(box.bottom).toBeLessThanOrEqual(bandTop);
  });

  it('the pinned Inspector keeps below the line too', () => {
    useUIStore.getState().setInspectorPinned(true);
    viewport(1280, 560);
    barAndBand(1280, 560);
    header(1280);
    selectionToolbar(1280);
    openBeside(rect(575, 200, 82, 90));
    expect(bounds().top).toBeGreaterThanOrEqual(92 + 49 + GAP);
  });
});
