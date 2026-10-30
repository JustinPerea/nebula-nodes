import { useEffect, useRef, useState } from 'react';
import { InNoticeRegion } from '../InNoticeRegion';
import type { LeaveProps } from '../../lib/noticeLeave';

/** How long the toast stays up while the pointer and focus are elsewhere. */
export const BOARD_TOAST_MS = 6000;

export interface BoardToast {
  id: number;
  /** What happened: "Removed #1", "Undid: Moved #3". */
  text: string;
  /** Slices an undo left as they are: "#12 changed since, left as is". */
  skipped?: string[];
  /** The button: Undo (a step of this tab's) or Redo. */
  action?: { label: 'Undo' | 'Redo'; run: () => void };
}

/**
 * The Studio's undo toast (plan section 5.4, Q15): Delete offers Undo here,
 * and an undo says what it left alone. It stays while the pointer is on it
 * or focus is in it, and Escape (from inside it) closes it. In the app's
 * notice region, on the Board and in the List view alike (GM - Design,
 * 2026-10-23: "One region, one stack, and nothing else draws toasts.").
 */
export function BoardUndoToast({ toast, onDismiss, leave }: {
  toast: BoardToast;
  onDismiss: () => void;
  /** Its leave (lib/noticeLeave NoticeLeave), when its parent draws one. */
  leave?: LeaveProps;
}) {
  const [held, setHeld] = useState(false);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => dismissRef.current(), BOARD_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [held, toast.id]);

  return (
    <InNoticeRegion slot="board">
      <div
        className="moodboard-board-toast"
        role="status"
        aria-live="polite"
        aria-label="Board undo"
        {...leave}
        onPointerEnter={() => setHeld(true)}
        onPointerLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false); }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onDismiss();
        }}
      >
        <span className="moodboard-board-toast__text">
          <span className="moodboard-board-toast__line">{toast.text}</span>
          {toast.skipped?.map((line, index) => (
            <span key={index} className="moodboard-board-toast__line moodboard-board-toast__line--skipped">{line}</span>
          ))}
        </span>
        {toast.action && (
          <button type="button" className="moodboard-board-toast__action"
            onClick={() => { toast.action?.run(); onDismiss(); }}>
            {toast.action.label}
          </button>
        )}
        <button type="button" className="moodboard-board-toast__close" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    </InNoticeRegion>
  );
}
