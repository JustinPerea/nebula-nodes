import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { holdNoticesUnderModal, holdNoticeTabbing } from '../lib/modalFocus';
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
 * - GM r25 (4) on PR #199: an aria-modal dialog puts the notices already on
 *   the page under its scrim (inert and dimmed: lib/modalFocus
 *   holdNoticesUnderModal) as it opens, and gives them back as it closes;
 *   one that arrives while it is open stays above, live.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  const [layer] = useState(() => {
    opened += 1;
    return opened;
  });
  useEffect(() => holdNoticeTabbing(), []);
  const host = useRef<HTMLDivElement>(null);
  // Before paint, so a notice never shows live for a frame under an open
  // dialog. A dialog that renders later (a lazy chunk) holds when it shows.
  useLayoutEffect(() => {
    const own = host.current;
    if (!own) return undefined;
    let release: (() => void) | null = null;
    const observer = new MutationObserver(() => hold());
    function hold() {
      const dialog = own?.querySelector('[aria-modal="true"]');
      if (release || !own || !dialog) return;
      observer.disconnect();
      release = holdNoticesUnderModal(own, dialog);
    }
    observer.observe(own, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    hold();
    return () => { observer.disconnect(); release?.(); };
  }, []);
  return createPortal(
    <div ref={host} className="modal-portal nokey" data-modal-layer={layer}
      onClick={contain} onDoubleClick={contain} onContextMenu={contain}>
      {children}
    </div>,
    document.body,
  );
}
