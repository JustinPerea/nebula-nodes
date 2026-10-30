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

/** The proposal bar's slot: under every modal's scrim (GM r7, PR #203), so
 * an open dialog's Tab never reaches it. */
const PROPOSAL_SLOT = '[data-notice-slot="proposal"]';

/** The notices' controls Tab reaches with a dialog open: every notice's, not
 * the proposal bar's, which sits behind the dialog. */
export function noticeTabbables(): HTMLElement[] {
  return tabbablesIn(document.querySelector(NOTICE_REGION)).filter((element) => !element.closest(PROPOSAL_SLOT));
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

/** A notice's own close control: every notice's × is a "Dismiss" button. */
const NOTICE_DISMISS = 'button[aria-label="Dismiss"]';

/** The notice that holds `node`: the region's item it belongs to (a slot's
 * child, or the region's own), never the whole stack. */
function noticeOf(node: Element): Element | null {
  for (let at: Element | null = node; at; at = at.parentElement) {
    const parent = at.parentElement;
    if (!parent) return null;
    if (parent.matches('[data-notice-slot]') || parent.matches(NOTICE_REGION)) return at;
  }
  return null;
}

/**
 * The one rule for a key pressed on a notice, whatever dialog is open (the
 * note dialog, the palette, the mask painter, the shortcuts, onboarding, the
 * comparison) or none. NoticeRegion installs it (window, capture: before any
 * dialog's or the app's document handler).
 * - GM r27 item 1 (PR #200 fix round 18): Escape closes that notice only, as
 *   its × does (focus then follows the × rule: the next notice's ×, else the
 *   open dialog's field), and never reaches the dialog. The nearest "Dismiss"
 *   inside that notice (a kept-note row's own) is the one pressed; a notice
 *   without one keeps the key and does nothing.
 * - GM r28 (fix round 19): with a dialog open, only Escape and × act on a
 *   notice. Every other key pressed there (`?`, Cmd+K, a letter, Enter) stops
 *   here, so neither the dialog nor an app shortcut sees it: the shortcuts'
 *   `?` and the palette's Cmd+K close nothing. Its default stays, so Enter and
 *   Space still press the focused button and a field in a notice still types.
 *   With no dialog open, the screen's own keys still work from a notice (the
 *   Studio's Cmd+Z from its undo toast).
 * - Tab is noticeTab's (the walk through the open dialog and the notices).
 * Escape from inside a dialog is the dialog's own.
 */
export function noticeKeys(event: KeyboardEvent): void {
  if (event.key === 'Tab' || event.isComposing) return;
  const target = event.target;
  if (!(target instanceof Element) || !inNoticeRegion(target)) return;
  if (event.key !== 'Escape') {
    if (openModalDialog()) event.stopImmediatePropagation();
    return;
  }
  if (event.defaultPrevented) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  const notice = noticeOf(target);
  if (!notice) return;
  for (let at: Element | null = target; at; at = at === notice ? null : at.parentElement) {
    const dismiss = at.matches(NOTICE_DISMISS) ? at : at.querySelector(NOTICE_DISMISS);
    if (dismiss instanceof HTMLElement && !dismiss.closest('[data-leaving]')) {
      dismiss.click();
      return;
    }
  }
}

/**
 * Review 15 LOW-B (PR #200 fix round 18): a notice can be replaced rather
 * than leave (Undo turns "Deleted the node." into "Restored the node." under a
 * new key), so the button that had focus is simply gone and focus falls to
 * <body>. With a dialog open, it goes where the last × sends it: the dialog's
 * field (GM r27 item 3). Watches `region` for the focused notice control
 * going away; returns a stop function.
 */
export function keepNoticeFocus(region: HTMLElement): () => void {
  let held: Element | null = null;
  const onFocusIn = (event: globalThis.FocusEvent) => { held = event.target instanceof Element ? event.target : null; };
  const onFocusOut = (event: globalThis.FocusEvent) => {
    // Focus moved somewhere real: nothing to keep.
    if (event.relatedTarget instanceof Element) held = null;
  };
  const observer = new MutationObserver(() => {
    if (!held || held.isConnected) return;
    held = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    dialogStart(openModalDialog())?.focus();
  });
  region.addEventListener('focusin', onFocusIn);
  region.addEventListener('focusout', onFocusOut);
  observer.observe(region, { childList: true, subtree: true });
  return () => {
    region.removeEventListener('focusin', onFocusIn);
    region.removeEventListener('focusout', onFocusOut);
    observer.disconnect();
  };
}
