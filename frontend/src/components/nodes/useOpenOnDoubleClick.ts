import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// Double-clicks here keep their own meaning (a port, the card's buttons:
// settings, Restore, Open): they don't open the asset a second time.
const OWN_DOUBLE_CLICK = '.react-flow__handle, button, input, textarea, select, a';

/**
 * Double-clicking a stored-asset node (Moodboard, Character) opens its Studio,
 * at any zoom. `open` is null when there's nothing to open (no asset chosen,
 * deleted), and the double-click does what it does elsewhere on the canvas.
 *
 * The listener is native, on the card itself: React Flow zooms the canvas on
 * a double-click through a listener on its pane, which a React handler (run
 * from the root, after the pane) can't stop. Stopping the event here, before
 * it reaches the pane, opens the Studio without zooming the canvas first.
 */
export function useOpenOnDoubleClick<T extends HTMLElement>(open: (() => void) | null): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);
  const enabled = open !== null;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const onDoubleClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(OWN_DOUBLE_CLICK)) return;
      event.stopPropagation();
      event.preventDefault();
      openRef.current?.();
    };
    element.addEventListener('dblclick', onDoubleClick);
    return () => element.removeEventListener('dblclick', onDoubleClick);
  }, [enabled]);
  return ref;
}
