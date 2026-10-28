import type { FocusEvent } from 'react';

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
  const layer = (element: Element | null) => Number(element?.getAttribute('data-modal-layer') ?? Number.NaN);
  const ownLayer = layer(own.closest('[data-modal-layer]'));
  const siblingLayer = layer(sibling);
  return !(Number.isFinite(siblingLayer) && Number.isFinite(ownLayer) && siblingLayer > ownLayer);
}
