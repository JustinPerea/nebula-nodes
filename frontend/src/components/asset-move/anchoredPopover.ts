import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The toolbar menu's anchoring (ToolbarMenuPopover: the Studios' Move, the
 * Commons' More), shared with the Commons' leave popover (commons-leave):
 * fixed beside its button, kept on screen, closed by a press outside or a
 * resize. `end` lines its right edge up with the button's (a button at a
 * toolbar's right end), `start` its left edge, `auto` whichever side the
 * button is on. With no room below, it opens above. Given an `outside`
 * element (the Updates list a button sits in), it opens to that element's
 * left instead, level with the button, so the list stays readable. A new
 * `revision` places it again (its content, and so its size, changed).
 */
export type PopoverAlign = 'start' | 'end' | 'auto';

const GAP = 6;
const EDGE = 8;

export function placeBeside(anchor: DOMRect, panel: { width: number; height: number }, align: PopoverAlign,
  view: { width: number; height: number }): { left: number; top: number } {
  const side = align === 'auto' ? (anchor.left + anchor.width / 2 < view.width / 2 ? 'start' : 'end') : align;
  const wanted = side === 'start' ? anchor.left : anchor.right - panel.width;
  const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, view.width - panel.width - EDGE));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - panel.height;
  const top = below + panel.height > view.height - EDGE && above >= EDGE ? above : below;
  return { left, top };
}

/** Left of `outside`, level with the anchor; null when there's no room on the left. */
export function placeOutside(anchor: DOMRect, outside: DOMRect, panel: { width: number; height: number },
  view: { width: number; height: number }): { left: number; top: number } | null {
  const left = outside.left - GAP - panel.width;
  if (left < EDGE) return null;
  const top = Math.min(Math.max(EDGE, anchor.top), Math.max(EDGE, view.height - panel.height - EDGE));
  return { left, top };
}

/**
 * Where the panel goes (null until measured: render it hidden first, as the
 * menu does), and the dismissals: `onDismiss` on a press outside the panel
 * and its button, or a resize. Keep `onDismiss` stable.
 */
export function useAnchoredPopover(anchorRef: RefObject<HTMLElement | null>, panelRef: RefObject<HTMLElement | null>,
  onDismiss: () => void, align: PopoverAlign = 'end', fallbackWidth = 220,
  outside: HTMLElement | null = null, revision = 0): { left: number; top: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const size = { width: panel?.width ?? fallbackWidth, height: panel?.height ?? 0 };
    const view = { width: window.innerWidth, height: window.innerHeight };
    const beside = outside ? placeOutside(anchor, outside.getBoundingClientRect(), size, view) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement: the panel's place depends on its own rendered size
    setPosition(beside ?? placeBeside(anchor, size, align, view));
    // `revision`: new content (a failure landing in an open leave popover)
    // changes the panel's size, so it is placed again.
  }, [anchorRef, panelRef, align, fallbackWidth, outside, revision]);

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [anchorRef, panelRef, onDismiss]);

  return position;
}
