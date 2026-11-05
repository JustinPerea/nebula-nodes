import type { useCanvasProposalsStore } from '../store/canvasProposalsStore';

/** What a node's header shows while a run the daily total holds waits on it. */
export interface NodeWait {
  /** The proposal it speaks for: the newest of those waiting on the node. */
  proposalId: string;
  /** How many proposals wait on the node ("Waiting for your OK · 2"). */
  count: number;
  color: string;
  /** The full reason, for the header's accessible description: each waiting
   * proposal's line (the bar's), the newest first. */
  reason: string;
}

type ProposalsState = ReturnType<typeof useCanvasProposalsStore.getState>;

/**
 * The waiting state on a node (GM - Design, PR #212 round 2): the open
 * proposals whose held run waits on it. The reason line itself stays off the
 * node: the bar and the Updates card show it.
 */
export function waitFor(state: Pick<ProposalsState, 'proposals'>, nodeId: string): NodeWait | null {
  const waiting = Object.values(state.proposals)
    .filter((entry) => !entry.closing && entry.view.wait?.nodeIds.includes(nodeId))
    .map((entry) => entry.view)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (waiting.length === 0) return null;
  const lines = [...new Set(waiting.map((view) => view.wait?.barLine ?? '').filter(Boolean))];
  return { proposalId: waiting[0].id, count: waiting.length, color: waiting[0].agent.color, reason: lines.join(' ') };
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
