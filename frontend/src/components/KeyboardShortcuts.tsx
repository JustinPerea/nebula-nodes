import { Suspense, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../store/uiStore';
import { isCanvasShortcutTarget, keyBlockedByModal } from '../lib/canvasShortcutScope';
import { SHORTCUTS_OPEN_EVENT } from '../lib/keyboardShortcuts';
import { DeferredKeyboardShortcutsDialog } from '../lib/deferredChunks';

/**
 * "?" on the canvas, or "Keyboard shortcuts" in the command palette.
 *
 * Review 8, L-c: it is a modal dialog, so it keeps focus like the paid
 * placeholder dialog (a click on its text, which takes no focus, brings focus
 * back to Close), and while it is open Escape or "?" close it wherever focus
 * is, the page included, unless another modal dialog is open on top of it.
 */
export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const openRef = useRef(false);
  useEffect(() => { openRef.current = open; }, [open]);

  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (openRef.current) {
        // Open, focus outside it (its own keys handle focus inside).
        if ((event.key === 'Escape' || event.key === '?') && !keyBlockedByModal(cardRef.current)) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (event.key !== '?' || !isCanvasShortcutTarget(event.target)) return;
      const ui = useUIStore.getState();
      if (ui.viewMode !== 'canvas' && !(ui.viewMode === 'commons' && !ui.commonsEnabled)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener(SHORTCUTS_OPEN_EVENT, show);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(SHORTCUTS_OPEN_EVENT, show);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <DeferredKeyboardShortcutsDialog cardRef={cardRef} onClose={() => setOpen(false)} />
    </Suspense>
  );
}
