import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@xyflow/react';
import type { NodeRect } from '../../lib/nodePlacement';
import { insideView } from '../../lib/boardPlacement';
import { storedImageView } from '../../lib/storedImage';
import { BOTTOM_BAR_GAP, floatingBottomLimit } from '../../lib/bottomBar';
import { isStudioShortcutTarget } from './studioKeys';
import type { OutsideTiles } from './BoardCanvas';

import { nearestEdge, outsideChipText, type ChipEdge } from './outsideChipText';



const ARROWS: Record<ChipEdge, string> = { left: '←', right: '→', top: '↑', bottom: '↓' };
/** Room kept between the chip and the board's corners, in screen pixels. */
const CORNER = 48;
/** The chip's distance from the edge it sits on. */
const EDGE = 12;

/**
 * The reveal for tiles placed outside the view (GM - Design, #210 answer 1):
 * a chip on the view's edge nearest the first tile, its arrow pointing at it,
 * with the tile's thumbnail. A button: pressing it brings the tiles into view
 * on the board's fit spring. No timer: it goes when pressed, when the person
 * pans or zooms the tiles into view, on Esc, or at the next paste (the
 * Studio replaces it). One polite announcement with the same words.
 */
export function OutsideChip({ tiles, onShow, onDone }: {
  tiles: OutsideTiles;
  onShow: (rects: NodeRect[]) => void;
  onDone: () => void;
}) {
  const [tx, ty, zoom] = useStore((state) => state.transform);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const view: NodeRect | null = width > 0 && height > 0 && zoom > 0
    ? { x: -tx / zoom, y: -ty / zoom, width: width / zoom, height: height / zoom } : null;
  const inView = view !== null && tiles.rects.every((rect) => insideView(rect, view));

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
      setFloor(Math.round(Math.min(parent.bottom, floatingBottomLimit(EDGE), noticesTop) - parent.top));
    };
    measure();
    const stack = document.querySelector('.notice-region__stack');
    const observer = typeof ResizeObserver === 'function' && stack ? new ResizeObserver(measure) : null;
    if (stack) observer?.observe(stack);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const done = useRef(onDone);
  useLayoutEffect(() => { done.current = onDone; });
  // The person's own pan or zoom brought the tiles into view.
  useEffect(() => { if (inView) done.current(); }, [inView]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isStudioShortcutTarget(event.target, 'undo')) return;
      done.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (inView || !view) return null;
  const first = tiles.rects[0];
  const point = { x: (first.x + first.width / 2) * zoom + tx, y: (first.y + first.height / 2) * zoom + ty };
  const edge = nearestEdge(point, width, height);
  const bottomLine = Math.min(height, floor ?? height);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));
  const along = edge === 'left' || edge === 'right'
    ? { top: clamp(point.y, Math.max(CORNER, size.h / 2 + EDGE), bottomLine - Math.max(CORNER, size.h / 2 + EDGE)) }
    : { left: clamp(point.x, size.w / 2 + EDGE, width - size.w / 2 - EDGE),
      ...(edge === 'bottom' ? { top: bottomLine - EDGE } : {}) };
  const { text, label } = outsideChipText(tiles.rects.length);
  const thumb = tiles.thumb ? storedImageView(tiles.thumb).src : null;
  return (
    <>
      <button ref={chipRef} type="button" className={`moodboard-board__outside-chip moodboard-board__outside-chip--${edge}`}
        style={along} aria-label={label}
        onClick={() => { onShow(tiles.rects); onDone(); }}>
        {(edge === 'left' || edge === 'top') && <span className="moodboard-board__outside-arrow" aria-hidden="true">{ARROWS[edge]}</span>}
        {thumb && <img className="moodboard-board__outside-thumb" src={thumb} alt="" draggable={false} />}
        <span>{text}</span>
        {(edge === 'right' || edge === 'bottom') && <span className="moodboard-board__outside-arrow" aria-hidden="true">{ARROWS[edge]}</span>}
      </button>
      <span className="moodboard-board__sr-only" role="status" aria-live="polite">{said}</span>
    </>
  );
}
