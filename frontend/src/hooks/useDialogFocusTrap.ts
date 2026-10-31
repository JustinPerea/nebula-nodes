import { useEffect, type RefObject } from 'react';
import { keyBlockedByModal } from '../lib/canvasShortcutScope';

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A modal dialog's keyboard contract (the World viewers: WorldPreview and
 * WorldSplatPreview). While `open`: focus starts on `initialFocusRef`,
 * Escape calls `onClose`, and Tab and Shift+Tab cycle inside the dialog,
 * including when focus has fallen out of it (a button that disables itself
 * while focused drops focus to the page body: Tab brings it back in rather
 * than reaching the canvas behind the modal). On close, focus returns to
 * what had it before. A modal opened over this one owns the keys
 * (keyBlockedByModal).
 */
export function useDialogFocusTrap(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyBlockedByModal(dialogRef.current)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // The dialog itself holds focus while a button it disabled or removed
      // can't (a download, Try again): Tab goes to the first control and
      // Shift+Tab to the last, as from outside (PR #203 r2 review, MEDIUM 1).
      const outside = !dialog.contains(active) || active === dialog;
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [dialogRef, initialFocusRef, onClose, open]);
}
