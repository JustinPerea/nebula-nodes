import { useEffect } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { NOTICE_HOLD_MS, noticeHoldMs } from '../../lib/canvasNoticeHold';

/** How long a notice with Undo or Redo stays up. Long enough to reach the button. */
export const UNDO_NOTICE_MS = NOTICE_HOLD_MS;

/**
 * A short line when someone else's edit changes this canvas: "Claude changed
 * the canvas" with Undo when an agent's edit lands, "Undid Claude's edit"
 * with Redo after Cmd-Z. The button acts only while that edit is next in
 * line on the undo (or redo) stack, so it never undoes something else.
 * Rendered in the app's notice region (NoticeRegion), above every panel.
 *
 * Round 3f (GM): "Every error alert becomes a canvas notice (non-blocking,
 * dismissable)". A notice with tone 'error' (graphStore.notify) is
 * announced as role="alert"; Dismiss is a button, so the keyboard reaches
 * it. `messagesOnly`: the studio screens (StudioNotice) show the written
 * lines, never an agent edit's Undo, which belongs to the canvas.
 */
export function CanvasUndoNotice({ messagesOnly = false }: { messagesOnly?: boolean } = {}) {
  const stored = useGraphStore((state) => state.undoNotice);
  const notice = messagesOnly && stored?.offer ? null : stored;
  const dismiss = useGraphStore((state) => state.dismissUndoNotice);
  const actionable = useGraphStore((state) => {
    const offer = state.undoNotice?.offer;
    const entry = state.undoNotice?.entry;
    if (!offer || !entry) return false;
    const stack = offer === 'undo' ? state.undoStack : state.redoStack;
    return stack[stack.length - 1] === entry;
  });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      if (useGraphStore.getState().undoNotice?.id === notice.id) dismiss();
    }, noticeHoldMs(notice.text, notice.offer));
    return () => window.clearTimeout(timer);
  }, [notice, dismiss]);

  if (!notice) return null;
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
    >
      {notice.agentColor && <span className="canvas-undo-notice__dot" aria-hidden="true" />}
      <span className="canvas-undo-notice__text">{notice.text}</span>
      {actionable && (
        <button type="button" className="canvas-undo-notice__action" onClick={act}>
          {notice.offer === 'undo' ? 'Undo' : 'Redo'}
        </button>
      )}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
