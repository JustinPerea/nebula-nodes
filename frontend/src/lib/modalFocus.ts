import type { FocusEvent } from 'react';
import { topModalDialog } from './canvasShortcutScope';

/**
 * A modal dialog keeps focus (review 7, M-1; review 8, L-c): when focus
 * leaves it for the page (a click on its text or its backdrop, an element
 * that went away), it comes back to `fallback`, once the browser has settled
 * where focus is. Focus that moved to another element (a dialog on top, a
 * menu) stays there. For the dialog's onBlur.
 */
export function returnFocusOnSlip(event: FocusEvent<HTMLElement>, fallback: () => HTMLElement | null): void {
  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
  window.setTimeout(() => {
    const active = document.activeElement;
    const target = fallback();
    if (target?.isConnected && (active === document.body || active === null)) target.focus();
  }, 0);
}

/**
 * Whether a child of document.body sits behind the modal `own`, for a modal
 * that hides the rest of the page (inert, aria-hidden) while it is open:
 * everything but the portal holding it (components/ModalPortal.tsx) and a
 * modal opened over it later (a higher `data-modal-layer`), which must stay
 * usable (review 9, M-1).
 */
export function sitsBehind(sibling: Element, own: Element): boolean {
  if (sibling.contains(own)) return false;
  // GM r25: the notice region stays above every dialog and usable.
  if (sibling.matches(NOTICE_REGION)) return false;
  const layer = (element: Element | null) => Number(element?.getAttribute('data-modal-layer') ?? Number.NaN);
  const ownLayer = layer(own.closest('[data-modal-layer]'));
  const siblingLayer = layer(sibling);
  return !(Number.isFinite(siblingLayer) && Number.isFinite(ownLayer) && siblingLayer > ownLayer);
}

/**
 * GM r25 (PR #200 fix round 16): the app's notices stay above every dialog's
 * backdrop and usable while it is open. The notice region (NoticeRegion, its
 * own child of <body>, on --sr-layer-notice above every modal) is a second
 * region of the open dialog's focus trap: Tab runs from the dialog's last
 * control to the first notice control and on round to the dialog's first,
 * Shift+Tab the other way. Every modal gets this from ModalPortal.
 */
export const NOTICE_REGION = '[data-notice-region]';

const TABBABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), '
  + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Whether `node` is in the notice region. */
export function inNoticeRegion(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest(NOTICE_REGION) !== null;
}

/** What Tab reaches inside `root`, in page order: no control of an inert,
 * hidden or leaving part. */
export function tabbablesIn(root: Element | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter((element) => !element.closest('[inert], [hidden], [data-leaving], [aria-hidden="true"]'))
    // Page order, whatever order a selector list comes back in.
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** The notices' controls Tab reaches. */
export function noticeTabbables(): HTMLElement[] {
  return tabbablesIn(document.querySelector(NOTICE_REGION));
}

/** Where focus goes in a dialog that gets it back: its field (a prompt's
 * text, a palette's search), else its first control, else itself. */
export function dialogStart(dialog: Element | null): HTMLElement | null {
  if (!(dialog instanceof HTMLElement)) return null;
  const controls = tabbablesIn(dialog);
  return controls.find((element) => element.matches('input, textarea, select')) ?? controls[0] ?? dialog;
}

/** The modal dialog on top, when one is open (any [aria-modal="true"]). */
export function openModalDialog(): HTMLElement | null {
  const top = topModalDialog();
  return top instanceof HTMLElement ? top : null;
}

function noticeTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const dialog = openModalDialog();
  if (!dialog) return;
  const notices = noticeTabbables();
  if (!notices.length) return;  // the dialog's own trap, as before
  const active = document.activeElement;
  const fromDialog = active instanceof Node && dialog.contains(active);
  if (!fromDialog && !inNoticeRegion(active)) return;
  const order = [...tabbablesIn(dialog), ...notices];
  const at = active instanceof HTMLElement ? order.indexOf(active) : -1;
  const next = at < 0
    ? (event.shiftKey ? order[order.length - 1] : order[0])
    : order[(at + (event.shiftKey ? -1 : 1) + order.length) % order.length];
  if (!next) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
  next.focus();
}

let noticeTabbing = 0;
/** Installed while any ModalPortal is mounted (counted); before every other
 * key listener (window, capture), so a dialog's own Tab trap only runs when
 * no notice shows. */
export function holdNoticeTabbing(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (noticeTabbing === 0) window.addEventListener('keydown', noticeTab, true);
  noticeTabbing += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    noticeTabbing -= 1;
    if (noticeTabbing === 0) window.removeEventListener('keydown', noticeTab, true);
  };
}
