import { useEffect, useState } from 'react';
import { keptEditsLine, useProjectStore } from '../../store/projectStore';
import { pulseKeptCanvas, subscribeKeptPulse, useKeptCanvas } from '../../lib/keptCanvas';
import { KEPT_MARK } from '../../lib/canvasLock';
import { SAVE_AS_A_PROJECT } from './catalogRestoreCopy';
import './KeptEditsNotice.css';

/**
 * GM r15 on PR #199, Q11 (review 11, HIGH-1): the line a restore (or an
 * agent's write that closed the project) leaves where the person is, when
 * the tab's latest edits weren't saved: GM r12, 1's "Nebula restored its
 * project list before your latest edits were saved. They're kept in this
 * tab." (or GM r14, 3's agent form) with [Save as a project]. It stays until
 * resolved (no Dismiss, no timer); the person can keep typing meanwhile, and
 * the unload warning holds. A failed save says why under the line.
 */
export function KeptEditsNotice() {
  const kept = useProjectStore((state) => state.keptEdits);
  const onWorkspace = useProjectStore((state) => state.screen === 'workspace');
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
  if (!kept || !onWorkspace) return null;
  return (
    <div className={`canvas-undo-notice canvas-undo-notice--message kept-edits-notice${pulses > 0 ? ' kept-edits-notice--pulse' : ''}`}
      role="status" aria-live="polite" data-kept-edits="">
      <span key={pulses} className="canvas-undo-notice__text">
        {keptEditsLine(kept)}
        {kept.error && <span className="kept-edits-notice__error" role="alert">{kept.error}</span>}
      </span>
      <button type="button" className="canvas-undo-notice__action" disabled={kept.saving} aria-busy={kept.saving || undefined}
        onClick={() => void useProjectStore.getState().saveKeptEdits()}>{SAVE_AS_A_PROJECT}</button>
    </div>
  );
}
