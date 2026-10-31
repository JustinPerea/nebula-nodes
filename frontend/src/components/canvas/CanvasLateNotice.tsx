import { useGraphStore } from '../../store/graphStore';
import { useNoticeHold } from '../../hooks/useNoticeHold';
import { useLeave } from '../../lib/noticeLeave';
import { LineText } from '../LineText';

const isShownLate = (id: number) => useGraphStore.getState().lateNotice?.id === id;

/**
 * A restore's late count (GM - Design, 2026-10-23, round 3): "Yes, show it as
 * a plain notice with no button, using the standard timeout ... Losing that
 * count silently is the one thing to avoid." Round 4: "drop the node word"
 * ("After the restore, 1 proposal couldn't be reopened.", lib/deleteNotice.ts
 * lateRestoreText), "Keep the × Dismiss", and "With two notices showing, put
 * the late line above the newer one, so the notice with a button stays
 * nearest the bar."
 *
 * When the person moves on before a restore's answer arrives, the "Restored
 * …" line no longer applies, but what it couldn't put back still shows, here:
 * a written line in the region's 'late' slot, right above the canvas notice
 * (lib/noticeSlots.ts). It never replaces the newer notice and offers no Undo
 * or Redo. Like every written line it keeps the region's Dismiss (×), its
 * reading-time hold (noticeHoldMs) and the pause while the pointer or focus
 * is on it.
 */
export function CanvasLateNotice() {
  const notice = useGraphStore((state) => state.lateNotice);
  const dismiss = useGraphStore((state) => state.dismissLateNotice);
  const holdHandlers = useNoticeHold(notice, isShownLate, dismiss, 'late');
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(notice);
  if (!leave.shown) return null;
  const shown = leave.shown;
  return (
    <div
      key={shown.id}
      className="canvas-undo-notice canvas-undo-notice--message canvas-undo-notice--late"
      role="status"
      aria-live="polite"
      {...holdHandlers} {...leave.props}
    >
      <LineText className="canvas-undo-notice__text" text={shown.text} />
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
