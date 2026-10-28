import { useGraphStore } from '../../store/graphStore';
import { useNoticeHold } from '../../hooks/useNoticeHold';
import { OpenCopyButton } from './OpenCopyButton';

const isShownMessage = (id: number) => useGraphStore.getState().messageNotice?.id === id;

/**
 * Review 7, L3: a written line (graphStore.notify) that arrived while the
 * canvas notice offers an agent's Undo ("Codex changed the canvas · Undo")
 * or a Redo. It never replaces that offer: it shows here, in its own slot
 * above the canvas notice (lib/noticeSlots.ts 'message'), so the notice with
 * the button stays nearest the bar (GM - Design, round 4, for the late
 * count). The canvas notice's own look, tone, Dismiss and reading-time hold
 * (the pause while the pointer or focus is on it), on every screen.
 */
export function CanvasMessageNotice() {
  const notice = useGraphStore((state) => state.messageNotice);
  const dismiss = useGraphStore((state) => state.dismissMessageNotice);
  const holdHandlers = useNoticeHold(notice, isShownMessage, dismiss);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      className="canvas-undo-notice canvas-undo-notice--message"
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
      {...holdHandlers}
    >
      <span className="canvas-undo-notice__text">{notice.text}</span>
      {notice.copy && <OpenCopyButton projectId={notice.copy.projectId} onOpen={dismiss} />}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
