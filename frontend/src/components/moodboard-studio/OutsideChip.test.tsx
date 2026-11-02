import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { OutsideChip } from './OutsideChip';
import { nearestEdge, outsideChipText, placeChip } from './outsideChipText';
import { CHIP_SHARE, outsideForChip, visibleShare } from '../../lib/boardPlacement';
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

  it('the nearest edge follows where the tile is, against the view (not the pane)', () => {
    const pane = { x: 0, y: 0, width: 1000, height: 700 };
    expect(nearestEdge({ x: -50, y: 350 }, pane)).toBe('left');
    expect(nearestEdge({ x: 1100, y: 350 }, pane)).toBe('right');
    expect(nearestEdge({ x: 500, y: -40 }, pane)).toBe('top');
    expect(nearestEdge({ x: 500, y: 800 }, pane)).toBe('bottom');
    // A view inset from the left: a point over its middle is no longer left of it.
    expect(nearestEdge({ x: 380, y: 700 }, { x: 300, y: 0, width: 700, height: 600 })).toBe('bottom');
    expect(nearestEdge({ x: 380, y: 700 }, pane)).toBe('bottom');
    expect(nearestEdge({ x: 250, y: 380 }, { x: 300, y: 0, width: 700, height: 600 })).toBe('left');
  });

  it('Esc another handler already took (defaultPrevented) leaves it up', () => {
    const { onDone } = mount(one);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => { document.body.dispatchEvent(event); });
    expect(onDone).not.toHaveBeenCalled();
  });
});

// Review 2, M2 and L4: one "in view" for placement and the chip (GM r4 answer 2),
// now by GM r13's half-area rule.
describe('the chip judges "in view" as placement does', () => {
  // Pane 1000 x 700, a 16 px inset, the toolbar's top at 652: placement's
  // view is 16..984 x 16..636.
  it('a tile mostly in the toolbar band, inside the pane, keeps the chip up and announces', () => {
    // 580..730: 56 of its 150 px rows are in view (37%).
    const band: OutsideTiles = { id: 3, rects: [{ x: 20, y: 580, width: 200, height: 150 }], thumb: null };
    const { onDone } = mount(band, 16, 652);
    const chip = screen.getByRole('button', { name: 'Added outside the view, show it' });
    // On the view's bottom edge (636, the toolbar's line less the inset), not the pane's (700); centred on the view.
    expect(chip.dataset.edge).toBe('bottom');
    expect(chip.style.top).toBe('624px');
    expect(chip.style.left).toBe('500px');
    expect(screen.getByRole('status').textContent).toBe('Added outside the view.');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('it goes once half the tile is out of the band (GM r13), before it clears it', () => {
    const band: OutsideTiles = { id: 3, rects: [{ x: 20, y: 580, width: 200, height: 150 }], thumb: null };
    const { onDone } = mount(band, 16, 652);
    // Up 18: 74 of 150 rows (49%), still up.
    pan(0, -18, 1);
    expect(onDone).not.toHaveBeenCalled();
    // Up 19: 75 of 150 (50%): seen, it goes, with 75 rows still under the band.
    pan(0, -19, 1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a tile with half or more of it in view gets no chip at all: it goes at once', () => {
    const half: OutsideTiles = { id: 6, rects: [{ x: 900, y: 100, width: 200, height: 100 }], thumb: null };
    const { onDone } = mount(half);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// GM r13: the chip must not contradict what the person sees.
describe('GM r13: the half-area rule', () => {
  const view = { x: 0, y: 0, width: 1000, height: 700 };
  // A 200 x 100 tile with `share` of its area in view, past each edge.
  const past = (edge: 'left' | 'right' | 'top' | 'bottom', share: number) => {
    switch (edge) {
      case 'left': return { x: -200 * (1 - share), y: 300, width: 200, height: 100 };
      case 'right': return { x: 1000 - 200 * share, y: 300, width: 200, height: 100 };
      case 'top': return { x: 400, y: -100 * (1 - share), width: 200, height: 100 };
      default: return { x: 400, y: 700 - 100 * share, width: 200, height: 100 };
    }
  };
  it.each(['left', 'right', 'top', 'bottom'] as const)('past the %s edge: 49%% in view gets the chip, 50%% does not', (edge) => {
    expect(visibleShare(past(edge, 0.49), view)).toBeCloseTo(0.49);
    expect(outsideForChip(past(edge, 0.49), view)).toBe(true);
    expect(outsideForChip(past(edge, 0.5), view)).toBe(false);
    expect(outsideForChip(past(edge, 0), view)).toBe(true);
    expect(outsideForChip(past(edge, 1), view)).toBe(false);
  });

  it('the share is of the tile\'s area, both ways cut (a corner)', () => {
    // 100 x 100 in view of a 200 x 200 tile: 25%.
    expect(visibleShare({ x: 900, y: 600, width: 200, height: 200 }, view)).toBeCloseTo(0.25);
    expect(outsideForChip({ x: 900, y: 600, width: 200, height: 200 }, view)).toBe(true);
    // 150 x 150 of 200 x 200: 56%.
    expect(outsideForChip({ x: 850, y: 550, width: 200, height: 200 }, view)).toBe(false);
    expect(CHIP_SHARE).toBe(0.5);
  });

  it('mounted: a tile 49% in view shows the chip; one 50% in does not', () => {
    const { onDone } = mount({ id: 7, rects: [past('right', 0.49)], thumb: null });
    expect(screen.getByRole('button', { name: /Added outside/ })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    cleanup();
    const second = mount({ id: 8, rects: [past('right', 0.5)], thumb: null });
    expect(second.onDone).toHaveBeenCalledTimes(1);
  });
});

describe('GM r13: where the chip sits and where its arrow points', () => {
  const pane = { width: 1000, height: 700 };
  const view = { x: 0, y: 0, width: 1000, height: 700 };
  const size = { w: 200, h: 36 };
  const at = (tile: { x: number; y: number; width: number; height: number }) => placeChip({ pane, view, floor: 700, size, tiles: [tile] });
  const box = (centre: { x: number; y: number }) => ({ x: centre.x - size.w / 2, y: centre.y - size.h / 2, width: size.w, height: size.h });
  const clearOf = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;

  it('bottom: centred on the bottom edge, 12 px up, the arrow down at the tile', () => {
    const place = at({ x: 400, y: 900, width: 200, height: 100 });
    expect(place.edge).toBe('bottom');
    expect(place.centre).toEqual({ x: 500, y: 700 - 18 - 12 });
    expect(place.turn).toBe(90);
  });

  it('top: centred on the top edge, the arrow up', () => {
    const place = at({ x: 400, y: -300, width: 200, height: 100 });
    expect(place).toMatchObject({ edge: 'top', centre: { x: 500, y: 30 }, turn: -90 });
  });

  it('left and right: centred on the side, the arrow sideways; the arrow comes first on the left', () => {
    const left = at({ x: -400, y: 300, width: 200, height: 100 });
    expect(left).toMatchObject({ edge: 'left', centre: { x: 112, y: 350 }, arrowFirst: true });
    expect(Math.abs(left.turn)).toBe(180);
    const right = at({ x: 1200, y: 300, width: 200, height: 100 });
    expect(right).toMatchObject({ edge: 'right', centre: { x: 888, y: 350 }, turn: 0, arrowFirst: false });
  });

  it('centred on the edge however far along it the tile is; the arrow points at the tile, not straight out', () => {
    const place = at({ x: 850, y: 760, width: 200, height: 100 });
    expect(place.edge).toBe('bottom');
    expect(place.centre.x).toBe(500);
    // From (500, 670) to the tile's centre (950, 810).
    expect(place.turn).toBe(Math.round((Math.atan2(810 - 670, 950 - 500) * 180) / Math.PI));
    expect(place.arrowFirst).toBe(false);
    const leftward = at({ x: -50, y: 760, width: 200, height: 100 });
    expect(leftward.edge).toBe('bottom');
    expect(leftward.arrowFirst).toBe(true);
    expect(Math.abs(leftward.turn)).toBeGreaterThan(90);
  });

  it('never on the tile: one poking in at the edge\'s middle moves the chip along the edge, clear of it', () => {
    const tile = { x: 440, y: 640, width: 160, height: 240 };
    const place = at(tile);
    expect(place.edge).toBe('bottom');
    expect(place.centre.y).toBe(670);
    expect(clearOf(box(place.centre), tile)).toBe(true);
    // The nearest clear place: just past the tile's left end (161 px from the middle; its right end's is 201).
    expect(place.centre.x).toBe(440 - 100 - 1);
  });

  it('never on the tile: with no room along the edge, it steps in past the tile', () => {
    const wide = { x: -100, y: 650, width: 1200, height: 900 };
    const place = placeChip({ pane, view, floor: 700, size, tiles: [wide] });
    expect(place.edge).toBe('bottom');
    expect(clearOf(box(place.centre), wide)).toBe(true);
    expect(place.centre.y).toBeLessThan(650);
  });

  it('the view, not the pane: a view inset from the left centres the chip on the view\'s own bottom edge', () => {
    const place = placeChip({ pane, view: { x: 300, y: 0, width: 700, height: 600 }, floor: 700, size, tiles: [{ x: 600, y: 700, width: 100, height: 100 }] });
    expect(place.centre).toEqual({ x: 650, y: 600 - 30 });
  });

  it('mounted: the chip is centred on its edge, never over the tile, with the arrow\'s turn on it', () => {
    mount({ id: 9, rects: [{ x: 850, y: 760, width: 200, height: 100 }], thumb: null });
    const chip = screen.getByRole('button', { name: /Added outside/ });
    expect(chip.dataset.edge).toBe('bottom');
    expect(chip.style.left).toBe('500px');
    const arrow = chip.querySelector('.moodboard-board__outside-arrow') as HTMLElement;
    expect(arrow.textContent).toBe('→');
    expect(arrow.style.getPropertyValue('--outside-turn')).toBe(`${arrow.dataset.turn}deg`);
    expect(Number(arrow.dataset.turn)).toBeGreaterThan(0);
    expect(Number(arrow.dataset.turn)).toBeLessThan(90);
    // The arrow comes after the words: the tile is right of the chip.
    expect(chip.lastElementChild).toBe(arrow);
  });

  it('zoomed: the tile is read in screen pixels, so the arrow still points at it', () => {
    mount({ id: 10, rects: [{ x: 2100, y: 300, width: 300, height: 200 }], thumb: null });
    pan(0, 0, 0.5);
    const chip = screen.getByRole('button', { name: /Added outside/ });
    expect(chip.dataset.edge).toBe('right');
    // The tile's centre on screen (2250, 400) x 0.5; the chip's centre 12 px in from the right, half way down.
    const turn = Math.round((Math.atan2(400 * 0.5 - 350, 2250 * 0.5 - 988) * 180) / Math.PI);
    expect(Number((chip.querySelector('.moodboard-board__outside-arrow') as HTMLElement).dataset.turn)).toBe(turn);
  });

  it('the stylesheet turns the arrow by --outside-turn and centres every edge\'s chip on its place', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/moodboard-board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.moodboard-board__outside-arrow\s*\{[^}]*transform:\s*rotate\(var\(--outside-turn, 0deg\)\)/);
    expect(css).toMatch(/\.moodboard-board__outside-chip--bottom\s*\{\s*transform:\s*translate\(-50%, -50%\);/);
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

  it('seen: wholly in view, or (bigger than the view) covering its centre', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    expect(outsideForChip({ x: 10, y: 10, width: 100, height: 100 }, view)).toBe(false);
    expect(outsideForChip({ x: 400, y: 300, width: 3000, height: 3000 }, view)).toBe(false);
    expect(outsideForChip({ x: 600, y: 300, width: 3000, height: 3000 }, view)).toBe(true);
  });

  it('the centre rule is only for a tile bigger than the view (GM r7 answer 1); a smaller one goes by its area (GM r13)', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    // Smaller than the view, cut by its top edge: 500 of 600 rows in view, seen.
    expect(outsideForChip({ x: 400, y: -100, width: 300, height: 600 }, view)).toBe(false);
    // Smaller, over the centre, but only 250 of 600 rows in: outside.
    expect(outsideForChip({ x: 400, y: -350, width: 300, height: 600 }, view)).toBe(true);
    // Taller than the view, over its centre: seen.
    expect(outsideForChip({ x: 400, y: -100, width: 300, height: 900 }, view)).toBe(false);
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
    // Zoomed out and moved, the tile still wholly past the right edge.
    pan(100, -40, 0.75);
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

// Review 4, MEDIUM-3: the person's own pan or zoom (or the board losing its
// size) dismisses the chip while it has focus. Focus goes to the board while
// the button is still on the page: it never drops to the body.
describe('the chip going while it has focus', () => {
  function Board({ tiles, keep = false }: { tiles: OutsideTiles; keep?: boolean }) {
    const [up, setUp] = useState(true);
    const board = useRef<HTMLDivElement>(null);
    return (
      <div ref={board} className="moodboard-board" tabIndex={-1}>
        {up && <ChipOnBoard tiles={tiles} inset={0} barTop={null} onShow={() => {}} onDone={() => { if (!keep) setUp(false); }}
          focusBoard={() => board.current?.focus({ preventScroll: true })} />}
      </div>
    );
  }
  const mountBoard = (keep = false) => render(
    <ReactFlowProvider initialWidth={1000} initialHeight={700}>
      <Pan />
      <Board tiles={one} keep={keep} />
    </ReactFlowProvider>,
  );
  // Every time focus left something for nowhere (the body).
  let dropped: string[] = [];
  const onOut = (event: FocusEvent) => { if (event.relatedTarget === null) dropped.push((event.target as HTMLElement).className); };
  beforeEach(() => { dropped = []; document.addEventListener('focusout', onOut); });
  afterEach(() => { document.removeEventListener('focusout', onOut); });

  it('panned into view: focus goes to the board, never the body', () => {
    const view = mountBoard();
    screen.getByRole('button').focus();
    pan(-700, -100, 1);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector('.moodboard-board'));
    expect(dropped).toEqual([]);
  });

  it('the board losing its size (no view): focus goes to the board, never the body', () => {
    const view = mountBoard();
    screen.getByRole('button').focus();
    act(() => { storeOf.current!.setState({ width: 0 }); });
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(view.container.querySelector('.moodboard-board'));
    expect(dropped).toEqual([]);
  });

  it('with a parent slow to drop it, the chip still hands focus to the board itself and goes', () => {
    const view = mountBoard(true);
    screen.getByRole('button').focus();
    pan(-700, -100, 1);
    expect(document.activeElement).toBe(view.container.querySelector('.moodboard-board'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(dropped).toEqual([]);
  });

  it('without focus on it, nothing takes focus', () => {
    const view = mountBoard();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    pan(-700, -100, 1);
    expect(screen.queryByRole('button', { name: /outside the view/ })).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    view.unmount();
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
