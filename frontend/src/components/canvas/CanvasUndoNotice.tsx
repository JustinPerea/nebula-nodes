import { useGraphStore } from '../../store/graphStore';
import { NOTICE_HOLD_MS } from '../../lib/canvasNoticeHold';
import { isForeignEdit } from '../../lib/canvasUndo';
import { useNoticeHold } from '../../hooks/useNoticeHold';
import { OpenCopyButton } from './OpenCopyButton';
import { useCanvasLock } from '../../lib/canvasLock';
import { useLeave } from '../../lib/noticeLeave';
import { LineText } from '../LineText';

/** How long a notice with Undo or Redo stays up. Long enough to reach the button. */
export const UNDO_NOTICE_MS = NOTICE_HOLD_MS;

const isShownNotice = (id: number) => useGraphStore.getState().undoNotice?.id === id;

/**
 * A short line when someone else's edit changes this canvas: "Claude changed
 * the canvas." with Undo when an agent's edit lands, "Undid Claude’s edit."
 * with Redo after Cmd-Z. The person's own delete says "Deleted the node."
 * with Undo, and its undo "Restored the node." with Redo (GM, 2026-10-23). The button acts only while that edit is next in
 * line on the undo (or redo) stack, so it never undoes something else.
 * Rendered in the app's notice region (NoticeRegion), above every panel.
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

  const holdHandlers = useNoticeHold(notice, isShownNotice, dismiss, 'notice');
  // Round 23 (review 22, L-3): Undo and Redo edit the canvas (the store
  // refuses both while following), so they take the canvas lock. Dismiss and
  // Open copy only look.
  const lock = useCanvasLock();

  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(notice);
  if (!leave.shown) return null;
  const shown = leave.shown;
  const act = () => {
    const state = useGraphStore.getState();
    if (shown.offer === 'undo') state.undo();
    else if (shown.offer === 'redo') state.redo();
  };

  return (
    <div
      key={shown.id}
      className={shown.offer ? 'canvas-undo-notice' : 'canvas-undo-notice canvas-undo-notice--message'}
      role={shown.tone === 'error' ? 'alert' : 'status'}
      aria-live={shown.tone === 'error' ? 'assertive' : 'polite'}
      style={shown.agentColor ? { ['--agent-color' as string]: shown.agentColor } : undefined}
      {...holdHandlers} {...leave.props}
    >
      {shown.agentColor && <span className="canvas-undo-notice__dot" aria-hidden="true" />}
      <LineText className="canvas-undo-notice__text" text={shown.text}>{noticeText(shown.text, shown.mono)}</LineText>
      {actionable && (
        <button type="button" className="canvas-undo-notice__action" onClick={act} {...lock.act()}
          aria-keyshortcuts={shown.offer === 'undo' ? 'Meta+Z Control+Z' : 'Meta+Shift+Z Control+Shift+Z'}>
          {shown.offer === 'undo' ? 'Undo' : 'Redo'}
        </button>
      )}
      {shown.copy && <OpenCopyButton projectId={shown.copy.projectId} onOpen={dismiss} />}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}

/** The line, with `mono` (a model id) set in mono where it appears. */
function noticeText(text: string, mono: string | undefined) {
  const at = mono ? text.lastIndexOf(mono) : -1;
  if (!mono || at < 0) return text;
  return <>{text.slice(0, at)}<code className="canvas-undo-notice__mono">{mono}</code>{text.slice(at + mono.length)}</>;
}
