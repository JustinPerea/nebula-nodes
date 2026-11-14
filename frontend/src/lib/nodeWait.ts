import type { useCanvasProposalsStore } from '../store/canvasProposalsStore';
import { proposalHoldLine, withHoldLine } from './ledgerHold';

/** What a node's header shows while a run the daily total holds waits on it. */
export interface NodeWait {
  /** The proposal it speaks for: the newest of those waiting on the node. */
  proposalId: string;
  /** How many proposals wait on the node: the header's accessible description
   * says it ("2 proposals are waiting for your OK."), never its label. */
  count: number;
  color: string;
  /** The full reason, for the header's accessible description: each waiting
   * proposal's line (the bar's), the newest first, each with the spend
   * record's hold sentence after it while that hold is on, as the bar shows it. */
  reason: string;
  /** The soonest end (epoch seconds) of a hold sentence in `reason`: the
   * reason is read again then (useNodeWait). Absent with none. */
  holdEnd?: number;
}

type ProposalsState = ReturnType<typeof useCanvasProposalsStore.getState>;

/**
 * The waiting state on a node (GM - Design, PR #212 round 2): the open
 * proposals whose held run waits on it. The reason line itself stays off the
 * node: the bar and the Updates card show it.
 */
export function waitFor(state: Pick<ProposalsState, 'proposals'>, nodeId: string, now: number = Date.now()): NodeWait | null {
  const waiting = Object.values(state.proposals)
    .filter((entry) => !entry.closing && entry.view.wait?.nodeIds.includes(nodeId))
    .map((entry) => entry.view)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (waiting.length === 0) return null;
  const lines: string[] = [];
  let holdEnd: number | undefined;
  for (const view of waiting) {
    const bar = view.wait?.barLine ?? '';
    if (!bar) continue;
    // The hold sentence the bar adds for sighted readers (review of PR #242 round 2, L6).
    const held = proposalHoldLine(view.wait?.ledgerHold, now);
    if (held) holdEnd = Math.min(holdEnd ?? Infinity, view.wait!.ledgerHold!.until);
    const line = withHoldLine(bar, held);
    if (!lines.includes(line)) lines.push(line);
  }
  return { proposalId: waiting[0].id, count: waiting.length, color: waiting[0].agent.color, reason: lines.join(' '),
    ...(holdEnd !== undefined ? { holdEnd } : {}) };
}

/** One string per wait, so a node re-renders only when its own wait changes. */
export function waitKey(wait: NodeWait | null): string {
  return wait ? JSON.stringify(wait) : '';
}

/** The id of the node's description: the reason the header's
 * aria-describedby names. */
export function waitReasonId(nodeId: string): string {
  return `node-wait-reason-${nodeId}`;
}

/** The header's accessible description (GM - Design, PR #212 round 3, item 1):
 * the count the label no longer draws, then each waiting proposal's reason.
 * One proposal: "A proposal is waiting for your OK." (new copy, the singular
 * of GM's "2 proposals are waiting for your OK"). */
export function waitDescription(wait: NodeWait): string {
  const count = wait.count > 1 ? `${wait.count} proposals are waiting for your OK.` : 'A proposal is waiting for your OK.';
  return wait.reason ? `${count} ${wait.reason}` : count;
}
