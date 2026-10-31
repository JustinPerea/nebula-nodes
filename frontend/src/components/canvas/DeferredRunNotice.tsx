import { useId, useState } from 'react';
import { Play, X } from 'lucide-react';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { nodeCardTitle, useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import '../../styles/canvasProposals.css';
import { useLeave } from '../../lib/noticeLeave';
import { deferredRunLine } from '../../lib/runLock';

/**
 * The proposal bar's own notice: an agent's proposal was accepted while a run
 * was going, so its nodes were added without running, and Run starts them
 * once the run finishes. It used to share the proposal bar's panel; it sits
 * in the app's notice region now (GM - Design, 2026-10-23: "Proposal-bar
 * notices and every 3g canvas notice go there").
 *
 * GM, PR #198 r40 item 3: a state line, read live (lib/runLock
 * deferredRunLine). While a run goes, "You can run “X” when the current run
 * finishes.", and [Run] is disabled; [Dismiss] stays enabled. GM, PR #205
 * r1: the line is already beside [Run], so [Run] has no tooltip (it covered
 * [Dismiss]) and points aria-describedby at the line (canvasLock `shown`). When the run finishes the line swaps in place to
 * "You can run “X” now." and [Run] enables: no toast, no timer. The held
 * nodes are named as their cards read now, so a rename shows at once.
 * Leaving, it keeps the line it last showed (review 1 of PR #205, NIT-3).
 */
export function DeferredRunNotice() {
  const deferredRun = useCanvasProposalsStore((s) => s.deferredRun);
  const runDeferred = useCanvasProposalsStore((s) => s.runDeferred);
  const dismissDeferred = useCanvasProposalsStore((s) => s.dismissDeferred);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  // A run waiting for its inputs counts as starting (review 15, M-B).
  const runStarting = useGraphStore((s) => s.runStarting);
  const lock = useCanvasLock();
  const lineId = useId();
  // It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2).
  const leave = useLeave(deferredRun);
  const heldIds = leave.shown?.nodeIds;
  // The held nodes' card titles in canvas order, as they read now (a stable
  // string, so an unrelated canvas change doesn't re-render the notice).
  const names = useGraphStore((s) => (heldIds
    ? s.nodes.filter((node) => heldIds.includes(node.id)).map((node) => nodeCardTitle(node)).join('\u0000') : ''));
  const live = { running: isExecuting || runStarting, line: deferredRunLine(names ? names.split('\u0000') : [], isExecuting || runStarting) };
  // Review 1 of PR #205 (NIT-3): leaving (its Run pressed, or dismissed), it
  // keeps the line it showed ("You can run “X” now.", [Run] enabled) through
  // its exit; the run that press started is not "the current run" it waited for.
  // Keyed on the notice itself: on the render it goes, useLeave has not marked it leaving yet.
  const [last, setLast] = useState(live);
  if (deferredRun && (last.line !== live.line || last.running !== live.running)) setLast(live);
  const { running, line } = deferredRun ? live : last;
  if (!leave.shown) return null;
  return (
    <div className="proposal-bar proposal-bar--notice" role="status" {...leave.props}>
      <p className="proposal-bar__summary" id={lineId}>{line}</p>
      <div className="proposal-bar__actions">
        <button
          type="button"
          className="proposal-bar__button proposal-bar__button--primary"
          // Review 7, L5: canvasLock's order (run, then following, then offline).
          {...lock.act({}, { run: running, runTitle: line, shown: { id: lineId, text: line } })}
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
