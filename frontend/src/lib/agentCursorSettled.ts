/**
 * When a cursor's "propose" or "wait" is over (GM - Design's cursor spec, §2:
 * they hold "until the person acts"). Pure: the layer feeds it what the
 * canvas already holds, so a reload with the answer settled draws no state.
 *
 * - propose waits on its proposal (the event's `proposalId`): settled once
 *   it is no longer open here (accepted, rejected, withdrawn, expired or
 *   superseded), but only after the canvas has been told its proposals
 *   (`proposalsSynced`: before that, absent means unknown, not settled). A
 *   propose with no proposal id (point_at `propose`) waits on the agent's
 *   open proposals: settled when it has none.
 * - wait has no object of its own; it waits on the agent's questions
 *   (ask_person): settled once a question set that agent asked has closed
 *   (answered, dismissed, withdrawn or expired) since the cursor's event
 *   and none of its sets is still open. With no question set, nothing ends
 *   it but the agent's next event or the cursor's expiry.
 */
import type { AgentCursorAction } from './agentPresenceActions';

export interface SettledCursor {
  action: AgentCursorAction;
  /** The agent's id. */
  id: string;
  proposalId: string | null;
  /** When the event reached this tab (a replay: when it happened). */
  receivedAt: number;
}

export interface SettledWorld {
  /** The canvas has been sent its proposals (proposalSync). */
  proposalsSynced: boolean;
  /** Proposals this tab holds. `closing` is set once one is decided. */
  proposals: Readonly<Record<string, { view: { agent: { id: string } }; closing?: string }>>;
  /** Question sets this tab holds. */
  questionSets: Readonly<Record<string, { view: { agent: { id: string }; status: string; closedAt: number | null } }>>;
}

export function isSettled(cursor: SettledCursor, world: SettledWorld): boolean {
  if (cursor.action === 'propose') {
    if (!world.proposalsSynced) return false;
    if (cursor.proposalId) {
      const entry = world.proposals[cursor.proposalId];
      return !entry || entry.closing !== undefined;
    }
    return !Object.values(world.proposals).some((p) => p.view.agent.id === cursor.id && p.closing === undefined);
  }
  if (cursor.action === 'wait') {
    const mine = Object.values(world.questionSets).filter((s) => s.view.agent.id === cursor.id);
    if (mine.some((s) => s.view.status === 'open')) return false;
    return mine.some((s) => s.view.closedAt !== null && s.view.closedAt >= cursor.receivedAt);
  }
  return false;
}
