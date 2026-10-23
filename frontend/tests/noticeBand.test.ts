import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bottomBar from '../src/lib/bottomBar';

/**
 * GM - Design, 2026-10-23, answers 1 and 5:
 * "Floating panels stop above a reserved notice band, whether or not a notice
 * is showing. The band is the region's height for one notice plus its gap,
 * measured like the bottom line. The panels never move when a notice comes or
 * goes, and a notice never covers Run / Duplicate / Delete."
 * "Yes, use a measured top line. Floating panels stop below the workspace
 * header and the selection toolbar, whichever is lower, plus the same 8 px gap."
 *
 * jsdom has no layout: the bar, the band, the header and the toolbar get the
 * rects the live check measured at 1280x800 (bar 395-885 x 729-776; the
 * header 412-868 x 24-64; the selection toolbar 365-915 x 92-141). The notice
 * region keeps its band as a box (`data-notice-band`) one notice plus its gap
 * tall, at the notices' bottom line, whether or not a notice shows.
 */

const added: HTMLElement[] = [];

function box(attrs: Record<string, string>, rect: DOMRect): HTMLElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.getBoundingClientRect = () => rect;
  document.body.append(element);
  added.push(element);
  return element;
}

/** The canvas's bottom bar at 1280x800. */
const bar = () => box({ 'data-bottom-bar': '' }, new DOMRect(395, 729, 490, 47));
/** The region's band: one notice (46) plus its gap (8), its foot 8 px above the bar. */
const band = (bottom = 721) => box({ 'data-notice-band': '' }, new DOMRect(16, bottom - 54, 1248, 54));
const header = () => box({ 'data-top-bar': '' }, new DOMRect(412, 24, 456, 40));
const toolbar = () => box({ 'data-top-bar': '' }, new DOMRect(365, 92, 550, 49));

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
});
afterEach(() => {
  added.splice(0).forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

describe('the reserved notice band', () => {
  it('a floating panel stops above it, one notice and its gap above the bar\'s gap', () => {
    bar();
    band();
    // 729 - 8 (the bar's gap) - 54 (one notice, 46, plus its gap, 8).
    expect(bottomBar.floatingBottomLimit(16, 800)).toBe(667);
  });

  it('is measured: a taller band moves the line by exactly that much', () => {
    bar();
    box({ 'data-notice-band': '' }, new DOMRect(16, 721 - 70, 1248, 70));
    expect(bottomBar.floatingBottomLimit(16, 800)).toBe(729 - 8 - 70);
  });

  it('with no bar (a Studio), the line is the band\'s own top', () => {
    // The region's no-bar spot: its foot 24 px off the window's bottom.
    band(776);
    expect(bottomBar.floatingBottomLimit(16, 800)).toBe(722);
  });

  it('follows the bar the panel is over: above Canvas actions only where it is under it', () => {
    bar();
    band(404);
    box({ 'data-bottom-bar': 'panel' }, new DOMRect(485, 412, 310, 317));
    // Over the panel: its top, its gap, then the band.
    expect(bottomBar.floatingBottomLimit(16, 800, { left: 500, right: 760 })).toBe(412 - 8 - 54);
    // Far left, clear of the panel: the bar's line, then the band (the region's
    // lift over the panel doesn't pull it up).
    expect(bottomBar.floatingBottomLimit(16, 800, { left: 212, right: 472 })).toBe(667);
  });

  it('without a region on screen, nothing changes', () => {
    bar();
    expect(bottomBar.floatingBottomLimit(16, 800)).toBe(721);
  });
});

describe('the measured top line', () => {
  it('a floating panel stops 8 px below the selection toolbar when it is lower than the header', () => {
    header();
    toolbar();
    expect(bottomBar.floatingTopLimit(16)).toBe(149);
  });

  it('and below the header alone when the toolbar goes', () => {
    header();
    const tools = toolbar();
    tools.remove();
    expect(bottomBar.floatingTopLimit(16)).toBe(72);
  });

  it('a hidden toolbar (no box) doesn\'t count', () => {
    header();
    box({ 'data-top-bar': '' }, new DOMRect(0, 0, 0, 0));
    expect(bottomBar.floatingTopLimit(16)).toBe(72);
  });

  it('with neither on screen, the window\'s gutter', () => {
    expect(bottomBar.floatingTopLimit(16)).toBe(16);
  });
});
