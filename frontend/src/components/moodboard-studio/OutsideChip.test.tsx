import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { OutsideChip } from './OutsideChip';
import { nearestEdge, outsideChipText, seenIn } from './outsideChipText';
import type { OutsideTiles } from './BoardCanvas';

// The reveal for tiles placed outside the view (GM - Design, #210 answer 1):
// an edge chip with an arrow, a thumbnail and GM's words; a button that brings
// the tiles into view; no timer; it goes when pressed, when the tiles come
// into view, on Esc, or at the next paste (the Studio replaces it).

vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));

const camera: { set: (x: number, y: number, zoom: number) => void } = { set: () => {} };
const pan = (x: number, y: number, zoom: number) => camera.set(x, y, zoom);
const storeOf: { current: ReturnType<typeof useStoreApi> | null } = { current: null };
function Pan() {
  const store = useStoreApi();
  useEffect(() => { storeOf.current = store; }, [store]);
  useEffect(() => { camera.set = (x, y, zoom) => act(() => { store.setState({ transform: [x, y, zoom] }); }); }, [store]);
  return null;
}
/** The view placement uses (BoardCanvas viewRect): the pane less `inset`,
 *  and less everything below `barTop` (the toolbar's top, in pane pixels). */
type ChipProps = Omit<Parameters<typeof OutsideChip>[0], 'viewOf'> & { inset: number; barTop: number | null };
function ChipOnBoard({ inset, barTop, ...rest }: ChipProps) {
  const store = useStoreApi();
  const viewOf = () => {
    const { transform: [tx, ty, zoom], width, height } = store.getState();
    const bottom = barTop === null ? height : Math.min(height, barTop);
    return { x: (inset - tx) / zoom, y: (inset - ty) / zoom, width: (width - 2 * inset) / zoom, height: (bottom - 2 * inset) / zoom };
  };
  return <OutsideChip {...rest} viewOf={viewOf} />;
}

const one: OutsideTiles = { id: 1, rects: [{ x: 1200, y: 300, width: 300, height: 200 }], thumb: '/api/outputs/a.png' };
const two: OutsideTiles = { id: 2, rects: [{ x: 300, y: 900, width: 300, height: 200 }, { x: 650, y: 900, width: 300, height: 200 }], thumb: null };

function mount(tiles: OutsideTiles, inset = 0, barTop: number | null = null) {
  const onShow = vi.fn();
  const onDone = vi.fn();
  const focusBoard = vi.fn();
  const view = render(
    <ReactFlowProvider initialWidth={1000} initialHeight={700}>
      <Pan />
      <div className="moodboard-studio-view">
        <ChipOnBoard tiles={tiles} inset={inset} barTop={barTop} onShow={onShow} onDone={onDone} focusBoard={focusBoard} />
      </div>
    </ReactFlowProvider>,
  );
  return { view, onShow, onDone, focusBoard };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the outside-the-view chip', () => {
  it('says GM\'s words for one tile, with the thumbnail, on the edge nearest it, arrow pointing at it', () => {
    const { view } = mount(one);
    const chip = screen.getByRole('button', { name: 'Added outside the view, show it' });
    expect(chip.textContent).toContain('Added outside the view');
    expect(chip.className).toContain('moodboard-board__outside-chip--right');
    expect(chip.textContent).toContain('→');
    expect(view.container.querySelector('.moodboard-board__outside-thumb')?.getAttribute('src')).toBe('/api/outputs/a.png');
  });

  it('several: "N images added outside the view", at the edge nearest the first', () => {
    mount(two);
    const chip = screen.getByRole('button', { name: '2 images added outside the view, show them' });
    expect(chip.className).toContain('moodboard-board__outside-chip--bottom');
    expect(outsideChipText(2).text).toBe('2 images added outside the view');
  });

  it('one polite announcement with the same words and a full stop', () => {
    mount(one);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Added outside the view.');
  });

  it('pressing it brings the tiles into view (the board\'s fit spring) and it goes', () => {
    const { onShow, onDone } = mount(two);
    fireEvent.click(screen.getByRole('button'));
    expect(onShow).toHaveBeenCalledWith(two.rects, false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('goes when the person pans or zooms the tiles into view, not before', () => {
    const { onDone } = mount(one);
    pan(-100, 0, 1);
    expect(onDone).not.toHaveBeenCalled();
    pan(-700, -100, 1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('with several tiles, stays until every one is in view (review 3)', () => {
    const split: OutsideTiles = { id: 5, rects: [{ x: 100, y: 100, width: 300, height: 200 }, { x: 1200, y: 100, width: 300, height: 200 }], thumb: null };
    const { onDone } = mount(split);
    // The first is in view from the start; the second is not.
    pan(-100, 0, 1);
    expect(onDone).not.toHaveBeenCalled();
    pan(0, 0, 0.6);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('goes on Esc, but not on Esc typed in a text field', () => {
    const { onDone } = mount(one);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onDone).not.toHaveBeenCalled();
    field.remove();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('has no timer: it is still there a minute later', () => {
    vi.useFakeTimers();
    const { onDone } = mount(one);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('the nearest edge follows where the tile is', () => {
    expect(nearestEdge({ x: -50, y: 350 }, 1000, 700)).toBe('left');
    expect(nearestEdge({ x: 1100, y: 350 }, 1000, 700)).toBe('right');
    expect(nearestEdge({ x: 500, y: -40 }, 1000, 700)).toBe('top');
    expect(nearestEdge({ x: 500, y: 800 }, 1000, 700)).toBe('bottom');
  });

  it('Esc another handler already took (defaultPrevented) leaves it up', () => {
    const { onDone } = mount(one);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => { document.body.dispatchEvent(event); });
    expect(onDone).not.toHaveBeenCalled();
  });
});

// Review 2, M2 and L4: one "in view" for placement and the chip (GM r4 answer 2).
describe('the chip judges "in view" as placement does', () => {
  it('a tile in the toolbar band, inside the pane, keeps the chip up and announces', () => {
    // Pane 1000 x 700, a 16 px inset, the toolbar's top at 652: placement's
    // view is 16..984 x 16..636. The tile sits at 504..654, under the toolbar's line.
    const band: OutsideTiles = { id: 3, rects: [{ x: 20, y: 504, width: 200, height: 150 }], thumb: null };
    const { onDone } = mount(band, 16, 652);
    expect(screen.getByRole('button', { name: 'Added outside the view, show it' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Added outside the view.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('it goes once the tile clears the toolbar band', () => {
    const band: OutsideTiles = { id: 3, rects: [{ x: 20, y: 504, width: 200, height: 150 }], thumb: null };
    const { onDone } = mount(band, 16, 652);
    pan(0, -40, 1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// GM r4 answer 9: a tile bigger than the view.
describe('a tile bigger than the view', () => {
  const big: OutsideTiles = { id: 4, rects: [{ x: 700, y: -200, width: 2000, height: 1400 }], thumb: null };
  it('keeps the chip while it doesn\'t cover the view\'s centre, and goes once it does', () => {
    const { onDone } = mount(big);
    expect(screen.getByRole('button')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    // Centre at (500 + 400, 350): inside the tile now.
    pan(-400, 0, 1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('seenIn: wholly in view, or covering the centre', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    expect(seenIn({ x: 10, y: 10, width: 100, height: 100 }, view)).toBe(true);
    expect(seenIn({ x: 400, y: 300, width: 3000, height: 3000 }, view)).toBe(true);
    expect(seenIn({ x: 600, y: 300, width: 3000, height: 3000 }, view)).toBe(false);
  });
});

// GM r4 answer 6: focus never falls to the page body.
describe('focus and the chip', () => {
  it('Enter or Space (a click with focus on it) asks the board to focus the first tile', () => {
    const { onShow } = mount(two);
    const chip = screen.getByRole('button');
    chip.focus();
    fireEvent.click(chip);
    expect(onShow).toHaveBeenCalledWith(two.rects, true);
  });

  it('Esc on the chip gives focus back to where it was', () => {
    const fit = document.createElement('button');
    fit.textContent = 'Fit';
    document.body.appendChild(fit);
    try {
      const { onDone, focusBoard } = mount(one);
      fit.focus();
      const chip = screen.getByRole('button', { name: /Added outside/ });
      chip.focus();
      fireEvent.keyDown(chip, { key: 'Escape' });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(fit);
      expect(focusBoard).not.toHaveBeenCalled();
    } finally { fit.remove(); }
  });

  it('Esc on the chip with nothing before it (or it is gone) gives focus to the board', () => {
    const { focusBoard } = mount(one);
    const chip = screen.getByRole('button');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(focusBoard).toHaveBeenCalledTimes(1);
  });

  it('Esc on the chip keeps the viewport exactly (GM r5): the board\'s transform is unchanged and nothing is shown', () => {
    const { onShow, onDone } = mount(one);
    pan(-120, -40, 0.75);
    const chip = screen.getByRole('button');
    const before = [...storeOf.current!.getState().transform];
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(storeOf.current!.getState().transform).toEqual(before);
    expect(onShow).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Esc elsewhere dismisses it and leaves focus alone', () => {
    const { onDone, focusBoard } = mount(one);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(focusBoard).not.toHaveBeenCalled();
  });

  it('gone some other way while it has focus: the board takes focus', () => {
    const { view, focusBoard } = mount(one);
    screen.getByRole('button').focus();
    view.unmount();
    expect(focusBoard).toHaveBeenCalledTimes(1);
  });
});

// Review 2 (chip-toasts L3): the chip never sits under the toolbar or the notices.
describe('the chip\'s floor', () => {
  const rectOf = (top: number, height: number, left = 0, width = 1000) => ({ top, bottom: top + height, left, right: left + width,
    width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const place = (attr: [string, string], rect: () => DOMRect) => {
    const element = document.createElement('div');
    element.setAttribute(attr[0], attr[1]);
    element.getBoundingClientRect = rect;
    document.body.appendChild(element);
    return element;
  };
  let stackTop = 560;
  let observed: (() => void) | null = null;
  const setUp = (withStack: boolean) => {
    vi.stubGlobal('innerHeight', 700);
    const board = place(['data-test-board', ''], () => rectOf(0, 700));
    place(['data-bottom-bar', ''], () => rectOf(652, 40, 0, 300));
    place(['data-notice-band', ''], () => rectOf(602, 50, 300, 400));
    if (withStack) place(['class', 'notice-region__stack'], () => rectOf(stackTop, 60, 300, 400));
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => board });
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} });
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetParent', original);
      document.querySelectorAll('[data-test-board], [data-bottom-bar], [data-notice-band], .notice-region__stack').forEach((el) => el.remove());
      vi.unstubAllGlobals();
      observed = null;
      stackTop = 560;
    };
  };
  const chipTop = () => parseFloat((screen.getByRole('button') as HTMLElement).style.top);

  it('a bottom chip stands above the notices up now', () => {
    const tearDown = setUp(true);
    try {
      mount(two);
      // The stack's top 560, less the 8 px gap, less the chip's 12 px from its line.
      expect(chipTop()).toBe(540);
    } finally { tearDown(); }
  });

  it('with no notice up, above the toolbar and the notice band (floatingBottomLimit)', () => {
    const tearDown = setUp(false);
    try {
      mount(two);
      // The bar's top 652, less its 8 px gap and the 50 px band: 594; less 12.
      expect(chipTop()).toBe(582);
    } finally { tearDown(); }
  });

  it('moves up when the notice stack grows', () => {
    const tearDown = setUp(true);
    try {
      mount(two);
      expect(chipTop()).toBe(540);
      stackTop = 500;
      act(() => { observed?.(); });
      expect(chipTop()).toBe(480);
    } finally { tearDown(); }
  });

  it('simply appears with reduced motion (no slide)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/moodboard-board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    expect(blocks.some((block) => /\.moodboard-board__outside-chip\s*\{\s*animation:\s*none;\s*\}/.test(block))).toBe(true);
  });
});
