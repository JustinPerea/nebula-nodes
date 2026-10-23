import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { NOTICE_HOLD_MS, noticeHoldMs } from '../../lib/canvasNoticeHold';
import { isForeignEdit } from '../../lib/canvasUndo';

/** How long a notice with Undo or Redo stays up. Long enough to reach the button. */
export const UNDO_NOTICE_MS = NOTICE_HOLD_MS;

/**
 * A short line when someone else's edit changes this canvas: "Claude changed
 * the canvas" with Undo when an agent's edit lands, "Undid Claude's edit"
 * with Redo after Cmd-Z. The person's own delete says "Deleted the node."
 * with Undo, and its undo "Restored the node." with Redo (GM, 2026-10-23). The button acts only while that edit is next in
 * line on the undo (or redo) stack, so it never undoes something else.
 * Rendered in the proposal bar's panel so the two stack instead of overlap.
 *
 * Round 3f (GM): "Every error alert becomes a canvas notice (non-blocking,
 * dismissable)". A notice with tone 'error' (graphStore.notify) is
 * announced as role="alert"; Dismiss is a button, so the keyboard reaches
 * it. `messagesOnly`: the studio screens (StudioNotice) show the written
 * lines, never an agent edit's Undo, which belongs to the canvas.
 *
 * The hold waits while the pointer is on the notice or focus is inside it,
 * and starts a full hold again once both leave (WCAG 2.2.1): with the delete
 * confirm gone, its Undo is the on-screen way back (review, 2026-10-23).
 */
export function CanvasUndoNotice({ messagesOnly = false }: { messagesOnly?: boolean } = {}) {
  const stored = useGraphStore((state) => state.undoNotice);
  // Off the canvas, an agent edit's Undo stays on the canvas; the person's
  // own "Deleted the node." (Create Studio's result delete) keeps its Undo.
  const notice = messagesOnly && stored?.offer && (!stored.entry || isForeignEdit(stored.entry)) ? null : stored;
  const dismiss = useGraphStore((state) => state.dismissUndoNotice);
  const actionable = useGraphStore((state) => {
    const offer = state.undoNotice?.offer;
    const entry = state.undoNotice?.entry;
    if (!offer || !entry) return false;
    const stack = offer === 'undo' ? state.undoStack : state.redoStack;
    return stack[stack.length - 1] === entry;
  });

  // The notice the pointer or focus is holding up, by id: a new notice starts its own hold.
  const [heldId, setHeldId] = useState<number | null>(null);
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  const held = heldId !== null && heldId === notice?.id;

  useEffect(() => {
    if (!notice || held) return;
    const timer = window.setTimeout(() => {
      if (useGraphStore.getState().undoNotice?.id === notice.id) dismiss();
    }, noticeHoldMs(notice.text, notice.offer));
    return () => window.clearTimeout(timer);
  }, [notice, dismiss, held]);

  if (!notice) return null;
  const hold = () => setHeldId(pointerIn.current || focusIn.current ? notice.id : null);
  const act = () => {
    const state = useGraphStore.getState();
    if (notice.offer === 'undo') state.undo();
    else if (notice.offer === 'redo') state.redo();
  };

  return (
    <div
      key={notice.id}
      className={notice.offer ? 'canvas-undo-notice' : 'canvas-undo-notice canvas-undo-notice--message'}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
      style={notice.agentColor ? { ['--agent-color' as string]: notice.agentColor } : undefined}
      onMouseEnter={() => { pointerIn.current = true; hold(); }}
      onMouseLeave={() => { pointerIn.current = false; hold(); }}
      onFocus={() => { focusIn.current = true; hold(); }}
      onBlur={(event) => {
        focusIn.current = event.currentTarget.contains(event.relatedTarget as globalThis.Node | null);
        hold();
      }}
    >
      {notice.agentColor && <span className="canvas-undo-notice__dot" aria-hidden="true" />}
      <span className="canvas-undo-notice__text">{notice.text}</span>
      {actionable && (
        <button type="button" className="canvas-undo-notice__action" onClick={act}
          aria-keyshortcuts={notice.offer === 'undo' ? 'Meta+Z Control+Z' : 'Meta+Shift+Z Control+Shift+Z'}>
          {notice.offer === 'undo' ? 'Undo' : 'Redo'}
        </button>
      )}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
