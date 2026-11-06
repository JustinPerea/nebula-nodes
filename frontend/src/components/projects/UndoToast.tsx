import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { InNoticeRegion } from '../InNoticeRegion';
import { useSlotWaiting } from '../../lib/noticeWaiting';
import type { LeaveProps } from '../../lib/noticeLeave';
import { UNDO_VISIBLE_MS } from './toastTiming';
import '../../styles/project-home.css';

/** The toast after a project is moved to Recently deleted, with its Undo: the app's one way to delete
 * a project (Projects home, and PR #199 r26 the kept canvas's chooser). */
export function UndoToast({ project, busy, onUndo, onDismiss, leave }: {
  project: { id: string; name: string }; busy: boolean; onUndo: () => void; onDismiss: () => void; leave?: LeaveProps;
}) {
  // Held while pointed at or focused, as the app's other toasts.
  const [paused, setPaused] = useState(false);
  // Waiting behind a capped popover (GM r13 2): its timer holds, so it isn't lost.
  const waiting = useSlotWaiting('project-home');
  useEffect(() => {
    if (paused || waiting) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, waiting, onDismiss, project.id]);
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="project-home">
      <div className="project-home__toast" role="status" aria-live="polite" {...leave}
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="project-home__toast-text">Moved “{project.name}” to Recently deleted</span>
        <button type="button" className="project-home__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}
