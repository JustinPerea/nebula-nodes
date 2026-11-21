import { useGraphStore } from '../../store/graphStore';
import { useNoticeHold } from '../../hooks/useNoticeHold';
import { OpenCopyButton } from './OpenCopyButton';
import { useLeave } from '../../lib/noticeLeave';
import { LineText } from '../LineText';

const isShownMessage = (id: number) => useGraphStore.getState().messageNotice?.id === id;

/**
 * A written line (graphStore.notify) that arrived while the canvas notice
 * offers an agent's Undo ("Codex changed the canvas · Undo") or a Redo. It
 * never replaces that offer: it shows here, in its own slot above the canvas
 * notice (lib/noticeSlots.ts 'message'), so the notice with the button stays
 * nearest the bar (design, for the late count). The canvas notice's own
 * look, tone, Dismiss and reading-time hold (the pause while the pointer or
 * focus is on it), on every screen.
 */
export function CanvasMessageNotice() {
  const notice = useGraphStore((state) => state.messageNotice);
  const dismiss = useGraphStore((state) => state.dismissMessageNotice);
  const holdHandlers = useNoticeHold(notice, isShownMessage, dismiss, 'message');
  // It leaves as it entered (design, PR #200).
  const leave = useLeave(notice);
  if (!leave.shown) return null;
  const shown = leave.shown;
  return (
    <div
      key={shown.id}
      className="canvas-undo-notice canvas-undo-notice--message"
      role={shown.tone === 'error' ? 'alert' : 'status'}
      aria-live={shown.tone === 'error' ? 'assertive' : 'polite'}
      {...holdHandlers} {...leave.props}
    >
      <LineText className="canvas-undo-notice__text" text={shown.text} code />
      {shown.copy && <OpenCopyButton projectId={shown.copy.projectId} onOpen={dismiss} />}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
