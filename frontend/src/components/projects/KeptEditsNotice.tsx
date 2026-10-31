import { useEffect, useRef, useState } from 'react';
import { isKeptUpdateLine, keptEditsLine, useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { pulseKeptCanvas, subscribeKeptPulse, useKeptCanvas } from '../../lib/keptCanvas';
import { KEPT_MARK, useCanvasLock } from '../../lib/canvasLock';
import { RUN_LOCK_REASON } from '../../lib/cinemaScene';
import { SAVE_AS_A_PROJECT } from './restoreCopyCore';
import { DISCARD_EDITS, KeptDiscardConfirm } from './KeptDiscardConfirm';
import './KeptEditsNotice.css';

/** Each button's own offline line (GM r19, 4: Save as a project shows its own). */
export const SAVE_KEPT_OFFLINE = 'You can save it as a project when Nebula reconnects.';
export const DISCARD_KEPT_OFFLINE = 'You can discard the kept edits when Nebula reconnects.';

/**
 * GM r15 on PR #199, Q11 (review 11, HIGH-1): the line a restore (or an
 * agent's write that closed the project) leaves where the person is, when
 * the tab's latest edits weren't saved: GM r12, 1's "Nebula restored its
 * project list before your latest edits were saved. They're kept in this
 * tab." (or GM r14, 3's agent form) with [Save as a project] and, GM r20,
 * [Discard edits] (after its confirm). It stays until resolved (no Dismiss,
 * no timer); the person can keep typing meanwhile, and the unload warning
 * holds. A failed save or discard says why under the line. GM r19, 4: each
 * button names what holds it: a run (its line, as the run lock gives it),
 * then offline (its own line).
 */
export function KeptEditsNotice() {
  const kept = useProjectStore((state) => state.keptEdits);
  const onWorkspace = useProjectStore((state) => state.screen === 'workspace');
  // GM r22 (2): Nebula was updated while kept. The line goes under the kept
  // line (the canvas has no other place for it) until kept mode ends.
  const update = useProjectStore((state) => (isKeptUpdateLine(state.error) ? state.error : null));
  const [pulses, setPulses] = useState(0);
  useEffect(() => subscribeKeptPulse(() => setPulses((count) => count + 1)), []);
  // GM r16, 4: a press on a control the kept canvas disabled (lib/canvasLock's
  // kept mark) pulses this line, as following pulses the project bar.
  const canvasKept = useKeptCanvas();
  useEffect(() => {
    if (!canvasKept) return undefined;
    const pressed = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(`[${KEPT_MARK}]`)) pulseKeptCanvas();
    };
    document.addEventListener('pointerdown', pressed, true);
    return () => document.removeEventListener('pointerdown', pressed, true);
  }, [canvasKept]);
  // Offline as every canvas surface reads it (lib/canvasLock).
  const lock = useCanvasLock();
  const offline = lock.offline;
  const running = useGraphStore((state) => !state.canSwitchProject({ exceptSaves: true }));
  // The confirm belongs to the kept canvas it was asked for: it goes with it.
  const [confirmingFor, setConfirmingFor] = useState<typeof kept>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  if (!kept || !onWorkspace) return null;
  const confirming = confirmingFor !== null && confirmingFor.sourceId === kept.sourceId;
  const setConfirming = (open: boolean) => setConfirmingFor(open ? kept : null);
  // Review 14 (lock-order NIT-3): kept leaves these two on, so the next
  // locks apply in the app's order: the run, following, then offline.
  const held: ({ disabled: boolean; title?: string } & Record<string, unknown>) | null = running ? { disabled: true, title: RUN_LOCK_REASON }
    : lock.following ? { disabled: true, ...lock.mark, title: lock.title() }
      : offline ? { disabled: true, ...lock.mark } : null;
  // One busy state for both (review 14, kept-hold LOW-1).
  const busy = kept.saving || kept.discarding === true;
  const saveHeld = held ? { ...held, ...(held.title ? {} : { title: SAVE_KEPT_OFFLINE }) } : { disabled: busy };
  const discardHeld = held ? { ...held, ...(held.title ? {} : { title: DISCARD_KEPT_OFFLINE }) } : { disabled: busy };
  return (
    <div className={`canvas-undo-notice canvas-undo-notice--message kept-edits-notice${pulses > 0 ? ' kept-edits-notice--pulse' : ''}`}
      role="status" aria-live="polite" data-kept-edits="">
      <span key={pulses} className="canvas-undo-notice__text">
        {keptEditsLine(kept)}
        {update && <span className="kept-edits-notice__error" data-kept-update="">{update}</span>}
        {kept.error && <span className="kept-edits-notice__error" role="alert">{kept.error}</span>}
      </span>
      <button type="button" className="canvas-undo-notice__action" {...saveHeld} aria-busy={kept.saving || undefined}
        data-kept-save="" onClick={() => void useProjectStore.getState().saveKeptEdits()}>{SAVE_AS_A_PROJECT}</button>
      <button type="button" ref={discardButton} className="canvas-undo-notice__action kept-edits-notice__discard" {...discardHeld}
        aria-busy={kept.discarding || undefined} data-kept-discard-button=""
        onClick={() => setConfirming(true)}>{DISCARD_EDITS}</button>
      {confirming && <KeptDiscardConfirm returnTo={discardButton} onKeep={() => setConfirming(false)}
        onDiscard={() => { setConfirming(false); void useProjectStore.getState().discardKeptEdits(); }} />}
    </div>
  );
}
