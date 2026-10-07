import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function isAvailable(element: HTMLElement): boolean {
  return !element.matches(':disabled, input[type="hidden"]')
    && !element.closest('[hidden], [inert], [aria-hidden="true"]');
}

/** Docks restore their opener; modal pickers also keep Tab inside the dialog. */
export function usePanelFocus(
  visible: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  { initialFocus = FOCUSABLE, trap = false }: { initialFocus?: string; trap?: boolean } = {},
) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!visible || !panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A preferred control may be disabled while its service connects. Try
    // available controls in order and verify that focus actually moved.
    const candidates = new Set([
      ...panel.querySelectorAll<HTMLElement>(initialFocus),
      ...panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      panel,
    ]);
    for (const target of candidates) {
      if (!isAvailable(target)) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) break;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (trap && event.key === 'Tab') {
        const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
          .filter(isAvailable);
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
      if (opener?.isConnected && (document.activeElement === document.body || panel.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [visible, panelRef, initialFocus, trap]);
}
