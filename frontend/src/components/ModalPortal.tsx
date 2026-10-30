import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { canTakeFocus, hideBehind, holdNoticeTabbing } from '../lib/modalFocus';
import { createPortal } from 'react-dom';

let opened = 0;

/** Ends a pointer event's trip through the React tree at the modal's edge. */
const contain = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Every modal dialog in the app renders through this (review 9, M-1 and M-2).
 *
 * - On document.body, so it covers the window whatever opened it: a modal
 *   rendered inside a panel takes that panel's box as its own when the panel
 *   has a backdrop-filter or transform (the mask painter under Slava
 *   restraint was the Inspector popover's 260x300 box).
 * - `nokey`: React bubbles a portal's events to its React parents, so a modal
 *   opened from inside a node card (the Mesh and World previews) sent its keys
 *   to React Flow's node, which moved it on arrows, selected it on Enter and
 *   Space and deselected it on Escape. React Flow ignores keys from inside
 *   `.nokey`. Keys still reach the window and the document, where the
 *   modal's own listeners and the canvas's guard (lib/canvasShortcutScope.ts)
 *   read them.
 * - A click, double click or context menu inside goes no further up the React
 *   tree (the node behind would select itself or open its menu). No window or
 *   document listener in the app reads those three from inside a modal.
 * - `data-modal-layer`: the order modals opened, so the one on top is the last
 *   opened wherever it sits on the page (keyBlockedByModal).
 * - GM r25 (PR #200 fix round 16): the app's notices stay above the backdrop
 *   and in the dialog's focus trap, as a second region (lib/modalFocus.ts
 *   holdNoticeTabbing), for every modal alike.
 * - GM, PR #203 r13 item 1: while it holds an `aria-modal="true"` dialog,
 *   the page behind it is inert and aria-hidden (lib/modalFocus hideBehind):
 *   the canvas, every panel and the proposal bar's slot, so a control behind
 *   the scrim can't be focused or pressed (round 6 review, stacking LOW-1:
 *   a focused Accept accepted on Enter under the palette). The notices stay
 *   usable, a modal opened over this one too. On close it puts every
 *   attribute back and, when focus was left on nothing (in the dialog that
 *   is going, or on <body>), returns it to the control that opened it. A
 *   dialog's own focus return runs after this, so it wins where it has one.
 */
export function ModalPortal({ children, fallbackFocus }: {
  children: ReactNode;
  /** Where focus goes on close when the opener can't take it (gone, or
   * nothing opened it): a dialog's own stable control. */
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [layer] = useState(() => {
    opened += 1;
    return opened;
  });
  // The control focused when it opened, read before any child moves focus.
  const [opener] = useState(() => (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement : null));
  const portal = useRef<HTMLDivElement>(null);
  useEffect(() => holdNoticeTabbing(), []);
  const fallback = useRef(fallbackFocus);
  useLayoutEffect(() => { fallback.current = fallbackFocus; }, [fallbackFocus]);
  // The dialog component renders this portal, so its own effects are the
  // parent's: on close they run before this cleanup, while the page behind is
  // still inert, and a focus() there goes nowhere. Focus return is therefore
  // done here, once the page is usable again: the opener, else the dialog's
  // fallback. A dialog that already put focus somewhere usable keeps it.
  useLayoutEffect(() => {
    const root = portal.current;
    if (!root) return;
    let restore: (() => void) | null = null;
    const sync = () => {
      const modal = root.querySelector('[aria-modal="true"]') !== null;
      if (modal && !restore) restore = hideBehind(root);
      else if (!modal && restore) {
        restore();
        restore = null;
      }
    };
    sync();
    // A dialog that arrives later (a deferred chunk, a step) or stops being modal.
    const watch = new MutationObserver(sync);
    watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    return () => {
      watch.disconnect();
      restore?.();
      const active = document.activeElement;
      const lost = !active || active === document.body || active === document.documentElement || root.contains(active);
      if (!lost) return;
      // The dialog's own focus trap may still be listening (a dialog's
      // effects can clean up after this one): this one focus move is the
      // close, not focus leaving the dialog, so no trap hears it.
      const quiet = (event: FocusEvent) => event.stopImmediatePropagation();
      window.addEventListener('focusin', quiet, true);
      try {
        for (const target of [opener, fallback.current?.() ?? null]) {
          if (!target || target === document.body || target === document.documentElement || !canTakeFocus(target)) continue;
          target.focus({ preventScroll: true });
          if (document.activeElement === target) return;
        }
      } finally {
        window.removeEventListener('focusin', quiet, true);
      }
    };
  }, [opener]);
  return createPortal(
    <div ref={portal} className="modal-portal nokey" data-modal-layer={layer}
      onClick={contain} onDoubleClick={contain} onContextMenu={contain}>
      {children}
    </div>,
    document.body,
  );
}
