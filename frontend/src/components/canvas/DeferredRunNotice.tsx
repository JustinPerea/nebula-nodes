import { Play, X } from 'lucide-react';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import '../../styles/canvasProposals.css';
import { useLeave } from '../../lib/noticeLeave';

/**
 * The proposal bar's own notice: an agent's proposal was accepted while a run
 * was going, so its nodes were added without running, and Run starts them
 * once the run finishes. It used to share the proposal bar's panel; it sits
 * in the app's notice region now (GM - Design, 2026-10-23: "Proposal-bar
 * notices and every 3g canvas notice go there").
 */
export function DeferredRunNotice() {
  const deferredRun = useCanvasProposalsStore((s) => s.deferredRun);
  const runDeferred = useCanvasProposalsStore((s) => s.runDeferred);
  const dismissDeferred = useCanvasProposalsStore((s) => s.dismissDeferred);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  // A run waiting for its inputs counts as starting (review 15, M-B).
  const runStarting = useGraphStore((s) => s.runStarting);
  const lock = useCanvasLock();
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(deferredRun);
  if (!leave.shown) return null;
  const shown = leave.shown;
  return (
    <div className="proposal-bar proposal-bar--notice" role="status" {...leave.props}>
      <p className="proposal-bar__summary">
        Added {shown.agentName}&apos;s nodes. Run them when the current run finishes.
      </p>
      <div className="proposal-bar__actions">
        <button
          type="button"
          className="proposal-bar__button proposal-bar__button--primary"
          // Review 7, L5: canvasLock's order (run, then following, then offline).
          {...lock.act({ kept: 'run' }, { run: isExecuting || runStarting })}
          onClick={() => void runDeferred()}
        >
          <Play size={13} aria-hidden="true" />
          Run
        </button>
        <button type="button" className="proposal-bar__button" aria-label="Dismiss" onClick={dismissDeferred}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
