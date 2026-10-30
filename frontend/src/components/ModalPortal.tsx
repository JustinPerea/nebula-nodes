import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { canTakeFocus, hideBehind, holdNoticeTabbing, returnFocusTo } from '../lib/modalFocus';
import { createPortal } from 'react-dom';

let opened = 0;

/** Each open portal's openers, nearest first: the control that opened it,
 * then, when that control sits in another dialog, that dialog's own, and so
 * up the chain (GM, PR #203 r15 item 5). */
const openersOf = new WeakMap<Element, HTMLElement[]>();

function openerChain(opener: HTMLElement | null): HTMLElement[] {
  if (!opener || opener === document.body || opener === document.documentElement) return [];
  const below = opener.closest('.modal-portal');
  return [opener, ...((below && openersOf.get(below)) ?? [])];
}

/**
 * The press being handled now, if any: a pointerdown or mousedown on its
 * way through the page's listeners (window capture to window bubble). A
 * dialog that closes on a press closes inside it, so its close knows the
 * press is still going: the press's own default would then move focus (to
 * <body>, or to whatever lies under the pointer once the backdrop is gone)
 * after focus went back to the opener (GM, PR #203 r15 item 4).
 */
let press: Event | null = null;
let pressWatchers = 0;
const notePress = (event: Event) => {
  press = event;
  window.setTimeout(() => { if (press === event) press = null; }, 0);
};
const endPress = (event: Event) => { if (press === event) press = null; };

function watchPresses(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (pressWatchers === 0) {
    for (const type of ['pointerdown', 'mousedown']) {
      window.addEventListener(type, notePress, true);
      window.addEventListener(type, endPress);
    }
  }
  pressWatchers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pressWatchers -= 1;
    if (pressWatchers > 0) return;
    for (const type of ['pointerdown', 'mousedown']) {
      window.removeEventListener(type, notePress, true);
      window.removeEventListener(type, endPress);
    }
  };
}

/** A dialog closing inside a press keeps that press from moving focus: a
 * mousedown's default is stopped now; a pointerdown's mousedown, still to
 * come, is stopped when it comes (until the press ends). */
function keepPressFromMovingFocus(): void {
  const current = press;
  if (!current) return;
  if (current.type === 'mousedown') {
    current.preventDefault();
    return;
  }
  const stop = (event: Event) => event.preventDefault();
  const disarm = () => {
    window.removeEventListener('mousedown', stop, true);
    window.removeEventListener('pointerup', disarm, true);
    window.removeEventListener('pointercancel', disarm, true);
  };
  window.addEventListener('mousedown', stop, true);
  window.addEventListener('pointerup', disarm, true);
  window.addEventListener('pointercancel', disarm, true);
  window.setTimeout(disarm, 1000);
}

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
  // The control focused when it opened, read before any child moves focus,
  // and, when that control is in another dialog, that dialog's openers.
  const [openers] = useState(() => openerChain(typeof document !== 'undefined'
    && document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const portal = useRef<HTMLDivElement>(null);
  useEffect(() => holdNoticeTabbing(), []);
  useEffect(() => watchPresses(), []);
  // A focus return queued by a close (below), until it runs.
  const pendingReturn = useRef<{ cancelled: boolean } | null>(null);
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
    openersOf.set(root, openers);
    // The same portal set up again before its queued return ran (StrictMode's
    // second mount in dev: review 7 of PR #203, NIT-1): it isn't closing.
    if (pendingReturn.current) pendingReturn.current.cancelled = true;
    pendingReturn.current = null;
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
      // A press that closed it doesn't then move focus (GM, PR #203 r15 item 4).
      keepPressFromMovingFocus();
      // A microtask on, once the commit is over: React hears no events
      // during a commit, so the opener's own onFocus would miss a return made
      // here (review 7 of PR #203, NIT-5); a dialog's own return, in its later
      // effects, wins where it has one; and a portal set up again first (its
      // StrictMode remount) cancels it.
      const ticket = { cancelled: false };
      pendingReturn.current = ticket;
      queueMicrotask(() => {
        if (ticket.cancelled) return;
        if (pendingReturn.current === ticket) pendingReturn.current = null;
        const active = document.activeElement;
        const lost = !active || active === document.body || active === document.documentElement || root.contains(active);
        if (!lost) return;
        // The nearest opener still on the page, up the chain of dialogs
        // that opened this one (GM, PR #203 r15 item 5), else the dialog's
        // fallback. A dialog's own focus trap still listening ignores this
        // move (modalFocus isReturningFocus); the opener's onFocus hears it.
        for (const target of [...openers, fallback.current?.() ?? null]) {
          if (!target || target === document.body || target === document.documentElement || !canTakeFocus(target)) continue;
          returnFocusTo(target);
          if (document.activeElement === target) return;
        }
      });
    };
  }, [openers]);
  return createPortal(
    <div ref={portal} className="modal-portal nokey" data-modal-layer={layer}
      onClick={contain} onDoubleClick={contain} onContextMenu={contain}>
      {children}
    </div>,
    document.body,
  );
}
