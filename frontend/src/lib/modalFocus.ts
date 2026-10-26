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
