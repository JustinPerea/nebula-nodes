import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '@xyflow/react';
import type { NodeRect } from '../../lib/nodePlacement';
import { storedImageView } from '../../lib/storedImage';
import { BOTTOM_BAR_GAP, floatingBottomLimit } from '../../lib/bottomBar';
import { isStudioShortcutTarget } from './studioKeys';
import type { OutsideTiles } from './BoardCanvas';

import { CHIP_EDGE, outsideChipText, placeChip } from './outsideChipText';
import { outsideForChip } from '../../lib/boardPlacement';

/**
 * The reveal for tiles placed outside the view (GM - Design, #210 answer 1):
 * a chip centred on the view's edge nearest the first tile, never on a tile,
 * its arrow pointing at it (GM r13: outsideChipText placeChip), with the
 * tile's thumbnail. It is up only while some tile it points at has less
 * than half its area in view (lib/boardPlacement outsideForChip). A button: pressing it brings the tiles into view
 * on the board's fit spring. No timer: it goes when pressed, when the person
 * pans or zooms the tiles into view, on Esc, or at the next paste (the
 * Studio replaces it). One polite announcement with the same words.
 *
 * "In view" is placement's own view (review 2, M2): `viewOf` is the board's
 * live view rect, the pane less its inset and the toolbar, so a tile partly
 * under the toolbar keeps the chip (GM r4 answer 2).
 *
 * Focus (GM r4 answer 6): Enter or Space sends it to the first tile (the
 * board's `onShow`); Esc gives it back to where it was before the chip had
 * it, or to the board; and if the chip goes for any other reason while it
 * has focus, focus goes to the board. Never to the page body.
 */
export function OutsideChip({ tiles, viewOf, onShow, onDone, focusBoard }: {
  tiles: OutsideTiles;
  /** The view placement uses, in board coordinates, or null before the board has a size. */
  viewOf: () => NodeRect | null;
  onShow: (rects: NodeRect[], focus: boolean) => void;
  onDone: () => void;
  focusBoard: () => void;
}) {
  // Read for their changes: the chip is drawn again on every pan, zoom or resize.
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const view = width > 0 && height > 0 && zoom > 0 ? viewOf() : null;
  const inView = view !== null && tiles.rects.every((rect) => !outsideForChip(rect, view));

  // One polite announcement: the live region mounts empty and gets its words after.
  const [said, setSaid] = useState('');
  const announce = `${outsideChipText(tiles.rects.length).text}.`;
  useEffect(() => { setSaid(announce); }, [announce]);

  // The lowest the chip may sit: above the board's toolbar, the app's notice
  // band (lib/bottomBar.ts floatingBottomLimit) and whatever notices are up
  // now, in the board's own pixels, so no notice ever covers it. Measured
  // again when the notice stack or the window changes size.
  const chipRef = useRef<HTMLButtonElement>(null);
  const [floor, setFloor] = useState<number | null>(null);
  // Its own size, so it is clamped whole inside the board (it is centred on its place).
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const box = chipRef.current?.getBoundingClientRect();
    if (box && (Math.round(box.width) !== size.w || Math.round(box.height) !== size.h)) {
      setSize({ w: Math.round(box.width), h: Math.round(box.height) });
    }
  }, [size.w, size.h, tiles]);
  useLayoutEffect(() => {
    const measure = () => {
      const parent = chipRef.current?.offsetParent?.getBoundingClientRect();
      if (!parent) return;
      const stack = document.querySelector('.notice-region__stack')?.getBoundingClientRect();
      const noticesTop = stack && stack.height > 0 ? stack.top - BOTTOM_BAR_GAP : Infinity;
      setFloor(Math.round(Math.min(parent.bottom, floatingBottomLimit(CHIP_EDGE), noticesTop) - parent.top));
    };
    measure();
    const stack = document.querySelector('.notice-region__stack');
    const observer = typeof ResizeObserver === 'function' && stack ? new ResizeObserver(measure) : null;
    if (stack) observer?.observe(stack);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const done = useRef(onDone);
  const toBoard = useRef(focusBoard);
  useLayoutEffect(() => { done.current = onDone; toBoard.current = focusBoard; });
  // Where focus was before the chip took it, for Esc.
  const before = useRef<HTMLElement | null>(null);
  const hasFocus = () => chipRef.current !== null && document.activeElement === chipRef.current;
  // Whether the chip has focus, kept as state so the render can keep the
  // button drawn while it does (review 4, MEDIUM-3).
  const [focused, setFocused] = useState(false);
  // Gone: any camera move brought the tiles into view (the person's pan or
  // zoom, Fit, a refit as the column resizes), or the board has no size. With focus on the chip, the board takes focus first,
  // while the button is still on the page, so focus never drops to the body
  // (review 4, MEDIUM-3); a layout effect, so it happens before paint.
  const gone = inView || !view;
  useLayoutEffect(() => {
    if (!gone) return;
    if (hasFocus()) toBoard.current();
    done.current();
  }, [gone]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isStudioShortcutTarget(event.target, 'undo')) return;
      if (hasFocus()) {
        const back = before.current;
        if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
        else toBoard.current();
      }
      done.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Gone some other way (the tiles came into view, the next paste) while it
  // had focus: the board takes it. Runs before the button leaves the page.
  useLayoutEffect(() => () => { if (hasFocus()) toBoard.current(); }, []);

  // Gone with focus: drawn one commit more, the same button (unseen: the
  // layout effect above moves focus and the board drops the chip before
  // paint), so it is still on the page when focus leaves it.
  if (gone && !focused) return null;
  // In the board's own pixels: the view, the tiles, and where the chip goes.
  const toScreen = (rect: NodeRect): NodeRect => ({ x: rect.x * zoom + tx, y: rect.y * zoom + ty, width: rect.width * zoom, height: rect.height * zoom });
  const place = placeChip({ pane: { width, height }, view: view ? toScreen(view) : { x: 0, y: 0, width, height },
    floor: floor ?? height, size, tiles: tiles.rects.map(toScreen) });
  const { edge, centre, turn, arrowFirst } = place;
  const arrow = <span className="moodboard-board__outside-arrow" aria-hidden="true" data-turn={turn}
    style={{ '--outside-turn': `${turn}deg` } as CSSProperties}>→</span>;
  const { text, label } = outsideChipText(tiles.rects.length);
  const thumb = tiles.thumb ? storedImageView(tiles.thumb).src : null;
  return (
    <>
      <button ref={chipRef} type="button" aria-label={label} data-edge={edge}
        className={`moodboard-board__outside-chip moodboard-board__outside-chip--${edge}${arrowFirst ? ' moodboard-board__outside-chip--arrow-first' : ''}`}
        style={{ left: centre.x, top: centre.y }}
        onFocus={(event) => { setFocused(true); if (event.relatedTarget instanceof HTMLElement) before.current = event.relatedTarget; }}
        onBlur={() => setFocused(false)}
        onClick={() => { onShow(tiles.rects, hasFocus()); onDone(); }}>
        {arrowFirst && arrow}
        {thumb && <img className="moodboard-board__outside-thumb" src={thumb} alt="" draggable={false} />}
        <span>{text}</span>
        {!arrowFirst && arrow}
      </button>
      <span className="moodboard-board__sr-only" role="status" aria-live="polite">{said}</span>
    </>
  );
}
