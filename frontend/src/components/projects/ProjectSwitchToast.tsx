import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { switchMessage, useProjectStore, type ProjectSwitchNotice } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { InNoticeRegion } from '../InNoticeRegion';
import './ProjectSwitchToast.css';
import { useLeave } from '../../lib/noticeLeave';
import { keptLockTitle, useKeptCanvas } from '../../lib/keptCanvas';
import { KEPT_MARK } from '../../lib/canvasLock';

const VISIBLE_MS = 15000;

const switchKey = (notice: ProjectSwitchNotice | null) =>
  notice && `${notice.actorName}\n${notice.projectName}\n${notice.previousProjectId}\n${notice.created}`;

/** Shown after this window followed an agent's project switch, which opens
 * the canvas even from Projects. "Back to …" reopens the project that was
 * open before (none when Projects had nothing open). A switch that arrives
 * while the Commons holds unsaved labels opens behind it (#163): the toast
 * keeps no timer while the person is still in the Commons, and starts its
 * 15 s once they leave it, for the canvas or Projects (commons-leave). */
export function ProjectSwitchToast() {
  const notice = useProjectStore((state) => state.switchNotice);
  const busy = useProjectStore((state) => state.busy);
  // GM r20 on PR #199: opening another project would strand a kept canvas.
  const kept = useKeptCanvas();
  // In the Commons is what App shows: Projects wins over it, and leaving by
  // Projects keeps viewMode 'commons' behind Projects (#163).
  const commonsView = useUIStore((state) => state.viewMode === 'commons' && state.commonsEnabled);
  const onProjects = useProjectStore((state) => state.screen === 'home');
  const inCommons = commonsView && !onProjects;
  const [paused, setPaused] = useState(false);
  const key = switchKey(notice);
  const [seen, setSeen] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  if (key !== seen) {
    setSeen(key);
    setHeld(Boolean(key) && inCommons);
  } else if (held && !inCommons) {
    setHeld(false);
  }
  useEffect(() => {
    if (!notice || paused || held) return;
    const timer = window.setTimeout(() => useProjectStore.getState().dismissSwitchNotice(), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, paused, held]);
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(notice);
  if (!leave.shown) return null;
  const shown = leave.shown;
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="project-switch">
      <div className="project-switch-toast" role="status" aria-live="polite" {...leave.props}
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="project-switch-toast__text">{switchMessage(shown)}</span>
        {shown.previousProjectId && (
          <button type="button" className="project-switch-toast__back"
            {...(kept ? { [KEPT_MARK]: '', disabled: true, title: keptLockTitle('open') } : { disabled: busy })}
            onClick={() => void useProjectStore.getState().switchBack()}>
            Back to “{shown.previousProjectName ?? 'previous project'}”
          </button>
        )}
        <button type="button" className="project-switch-toast__close" aria-label="Dismiss"
          onClick={() => useProjectStore.getState().dismissSwitchNotice()}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}
