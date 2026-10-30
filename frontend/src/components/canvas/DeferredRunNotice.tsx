import { useId, useMemo } from 'react';
import { Play, X } from 'lucide-react';
import { deferredRunKeyLock, useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useUIStore } from '../../store/uiStore';
import { withKeyLock } from '../../lib/runKeyLock';
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
  // GM, PR #203 r8 item 3: locked while what it runs needs a key that isn't
  // set (a keyed route's missing key), focusable, its line as the
  // reason; runDeferred refuses the same way.
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const settingsCache = useUIStore((s) => s.settingsCache);
  const keyLock = useMemo(() => (deferredRun ? deferredRunKeyLock(deferredRun, { nodes, edges }, settingsCache) : null),
    [deferredRun, nodes, edges, settingsCache]);
  const keyLockId = useId();
  const lock = useCanvasLock();
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(deferredRun);
  if (!leave.shown) return null;
  const runProps = withKeyLock(lock.act({}, { run: isExecuting || runStarting }), keyLock, keyLockId);
  const runKeyLocked = runProps['data-key-locked'] !== undefined;
  const shown = leave.shown;
  return (
    <div className="proposal-bar proposal-bar--notice" role="status" {...leave.props}>
      <p className="proposal-bar__summary">
        Added <span className="agent-name" title={shown.agentName} aria-label={shown.agentName}>{shown.agentName}</span>&apos;s nodes. Run them when the current run finishes.
      </p>
      <div className="proposal-bar__actions">
        <button
          type="button"
          className="proposal-bar__button proposal-bar__button--primary"
          // The missing key first (withKeyLock, GM PR #203 r11 item 3),
          // then canvasLock's order (review 7, L5: run, following, offline).
          {...runProps}
          onClick={() => { if (!runKeyLocked) void runDeferred(); }}
        >
          <Play size={13} aria-hidden="true" />
          Run
        </button>
        {runKeyLocked && <span id={keyLockId} className="toolbar__sr-only">{keyLock}</span>}
        <button type="button" className="proposal-bar__button" aria-label="Dismiss" onClick={dismissDeferred}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
