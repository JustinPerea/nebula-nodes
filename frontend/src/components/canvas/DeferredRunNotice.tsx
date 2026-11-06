import { useId, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { deferredRunKeyLock, useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useUIStore } from '../../store/uiStore';
import { withKeyLock } from '../../lib/runKeyLock';
import { nodeCardTitle, useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { PersonLockLine } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import '../../styles/canvasProposals.css';
import { useLeave } from '../../lib/noticeLeave';
import { deferredRunLine } from '../../lib/runLock';

/** A lock's props that are set: its unset keys never clear what the run lock already put on the button. */
const definedProps = <T extends object>(props: T): Partial<T> =>
  Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as Partial<T>;

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
  const lineId = useId();
  // PR #204 round 10 (GM r15): Dismiss releases the run's approval (DELETE
  // /api/canvas/approvals: require_person), so it locks through the one lock.
  const dismissLock = usePersonLock('dismiss this');
  // PR #204 round 11: with every one of its nodes deleted since Accept, Run has nothing to start
  // and only releases the approval, as Dismiss does (lib/canvasApprovals: require_person), so then
  // it locks with Dismiss and points at the same line. With nodes left it runs, which isn't
  // person-only, and stays live.
  const nothingLeft = useGraphStore((s) => !!deferredRun
    && !deferredRun.nodeIds.some((nodeId) => s.nodes.some((node) => node.id === nodeId)));
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
  // The missing key first (withKeyLock, GM PR #203 r11 item 3), then
  // canvasLock's order (review 7, L5: run, following, offline).
  const runProps = withKeyLock(lock.act({}, { run: running, runTitle: line, shown: { id: lineId, text: line } }),
    keyLock, keyLockId);
  const runKeyLocked = runProps['data-key-locked'] !== undefined;
  return (
    <div className="proposal-bar proposal-bar--notice" role="status" {...leave.props}>
      <p className="proposal-bar__summary" id={lineId}>{line}</p>
      <div className="proposal-bar__actions">
        <button
          type="button"
          className="proposal-bar__button proposal-bar__button--primary"
          {...runProps}
          {...(nothingLeft ? definedProps(dismissLock.control(lineId)) : {})}
          onClick={() => {
            if (runKeyLocked) return;
            if (nothingLeft) dismissLock.guard(runDeferred)();
            else void runDeferred();
          }}
        >
          <Play size={13} aria-hidden="true" />
          Run
        </button>
        {runKeyLocked && <span id={keyLockId} className="toolbar__sr-only">{keyLock}</span>}
        <button type="button" className="proposal-bar__button" aria-label="Dismiss" {...dismissLock.control()}
          onClick={dismissLock.guard(dismissDeferred)}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <PersonLockLine lock={dismissLock} place="control" className="proposal-bar__held-line" />
    </div>
  );
}
