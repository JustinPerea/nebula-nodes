import { useProjectStore } from '../../store/projectStore';
import { useNoticeHold } from '../../hooks/useNoticeHold';
import { SEE_WHATS_LARGE } from '../../lib/savePausedCopy';
import { useLeave } from '../../lib/noticeLeave';

const isShown = (id: number) => useProjectStore.getState().sizeNotice?.id === id;
const dismiss = () => useProjectStore.getState().dismissSizeNotice();

/**
 * The one region notice for a project over the save limit (Q118, GM - Design):
 * "Saving paused. This project is {size} MB, over the 16 MB limit." (or, after
 * Load graph, "Opened {filename}. It's {size} MB, over the save limit.")
 * with "See what's large", which opens the panel; later "Saving again. This
 * project is {size} MB." with no button. It goes like every written line (the
 * reading-time hold, Dismiss, the pause while the pointer or focus is on it):
 * "Nothing stays up in the band"; the header carries the state.
 */
export function SavePausedNotice() {
  const notice = useProjectStore((state) => state.sizeNotice);
  const holdHandlers = useNoticeHold(notice, isShown, dismiss);
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(notice);
  if (!leave.shown) return null;
  const shown = leave.shown;
  return (
    <div key={shown.id} className="canvas-undo-notice canvas-undo-notice--message save-paused-notice"
      role="status" aria-live="polite" {...holdHandlers} {...leave.props}>
      <span className="canvas-undo-notice__text">{shown.text}</span>
      {shown.action && (
        <button type="button" className="canvas-undo-notice__action"
          onClick={() => useProjectStore.getState().openSizePanel()}>{SEE_WHATS_LARGE}</button>
      )}
      <button type="button" className="canvas-undo-notice__close" aria-label="Dismiss" onClick={dismiss}>×</button>
    </div>
  );
}
