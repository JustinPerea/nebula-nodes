import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { SavedCanvas } from '../../lib/projects';
import { DEFAULT_PROJECT_LIMIT, OPEN_RECENTLY_DELETED } from './restoreCopyCore';
import type { CanvasLimit, CanvasLimitContext } from './catalogRestoreCopy';
import type { RestoreCopy } from './restoreCopyLoader';
import { InNoticeRegion } from '../InNoticeRegion';
import { UNDO_VISIBLE_MS } from './toastTiming';

/**
 * The notices of Projects home that only show when something happened (the
 * canvas waiting at a limit, held canvases Nebula couldn't read, and the
 * saved toasts), in their own chunk (review 21 LOW-1 on PR #199, the entry
 * chunk's budget). ProjectHome loads it the first time one of them shows;
 * until then it shows nothing.
 */

/** GM r9: the held canvases that couldn't be read, when no restore notice
 * shows to say it: its own notice, styled like the restore notice, closed
 * with × (a one-time report; only the waiting line has no ×). */
export function CanvasHeldUnreadableNotice({ copy, count, onDismiss }: { copy: RestoreCopy; count: number | null; onDismiss: () => void }) {
  return (
    <div className="project-home__notice project-home__restore" role="status">
      <span className="project-home__restore-text">{copy.canvasHeldUnreadableLine(count)}</span>
      <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  );
}

/** GM r5's waiting line (r6's wording): the canvas isn't saved as a
 * project yet, the list is at a limit, nothing in it is lost. A slim notice where the restore notice sits; it
 * can't be dismissed while the canvas waits and goes once it is saved. The
 * size cap's adds "Open Recently deleted" (only a delete for good frees it). */
export function CanvasWaitingNotice({ copy, waiting, trashCount, onOpenRecentlyDeleted }: {
  copy: RestoreCopy;
  waiting: { reason: CanvasLimit; projectLimit?: number; canvases?: CanvasLimitContext['canvases']; deletes?: number | null }; trashCount: number;
  onOpenRecentlyDeleted: () => void;
}) {
  const line = copy.canvasWaitingLine(waiting.reason, {
    projectLimit: waiting.projectLimit ?? DEFAULT_PROJECT_LIMIT, trashHasItems: trashCount > 0, canvases: waiting.canvases,
    deletes: waiting.deletes,
  });
  return (
    // No ×: the stack's focus rule can land on it, so it takes focus itself.
    <div className="project-home__notice project-home__restore project-home__waiting" role="status" tabIndex={-1}>
      <span className="project-home__restore-text">{line}</span>
      {waiting.reason === 'storage' && trashCount > 0 && <button type="button" className="project-home__restore-action project-home__restore-action--neutral"
        onClick={onOpenRecentlyDeleted}>{OPEN_RECENTLY_DELETED}</button>}
    </div>
  );
}

/** GM r5: "Once saved: the normal toast", with the project's real name. */
export function CanvasSavedToast({ copy, project, onDismiss }: {
  copy: RestoreCopy;
  project: { id: string; name: string; overSaveLimit?: boolean; another?: boolean; agentCopy?: { agent?: string | null };
    filed?: SavedCanvas[] };
  onDismiss: () => void;
}) {
  return <SavedToast text={copy.canvasSavedToast(project.name, project.filed, project.overSaveLimit === true,
    project.another === true, project.agentCopy)} onDismiss={onDismiss} />;
}

/** The app's saved toast: it goes after UNDO_VISIBLE_MS, held while pointed
 * at or focused. Keyed by the caller on what it names. */
export function SavedToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, onDismiss]);
  return (
    <InNoticeRegion slot="project-home">
      <div className="project-home__toast" role="status" aria-live="polite"
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="project-home__toast-text">{text}</span>
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}
