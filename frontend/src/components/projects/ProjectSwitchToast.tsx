import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { switchMessage, useProjectStore } from '../../store/projectStore';
import './ProjectSwitchToast.css';

const VISIBLE_MS = 15000;

/** Shown after this window followed an agent's project switch, which opens
 * the canvas even from Projects. "Back to …" reopens the project that was
 * open before (none when Projects had nothing open). */
export function ProjectSwitchToast() {
  const notice = useProjectStore((state) => state.switchNotice);
  const busy = useProjectStore((state) => state.busy);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!notice || paused) return;
    const timer = window.setTimeout(() => useProjectStore.getState().dismissSwitchNotice(), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, paused]);
  if (!notice) return null;
  return (
    <div className="project-switch-toast" role="status" aria-live="polite"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="project-switch-toast__text">{switchMessage(notice)}</span>
      {notice.previousProjectId && (
        <button type="button" className="project-switch-toast__back" disabled={busy}
          onClick={() => void useProjectStore.getState().switchBack()}>
          Back to “{notice.previousProjectName ?? 'previous project'}”
        </button>
      )}
      <button type="button" className="project-switch-toast__close" aria-label="Dismiss"
        onClick={() => useProjectStore.getState().dismissSwitchNotice()}><X aria-hidden="true" /></button>
    </div>
  );
}
