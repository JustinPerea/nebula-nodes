import { useMemo } from 'react';
import type { AgentNote } from '../../lib/agentNotes';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { HELD_PROPOSAL_LINE, HELD_QUESTIONS_LINE } from '../../store/heldAssetProposals';
import { heldAsks } from './agentNeedsYou';

/**
 * One rule for "this tab can't act on that ask yet" (GM, #204 r3 item 2), used by every
 * surface that offers it: the Agents panel's Needs-you rows, the badge's count, and an
 * Update's own Review or Answer button in the opened list and on its arrival card. A tab
 * not connected as the person knows an ask only from its Update: it holds no question
 * set's answer key and gets no proposal (they go to the person's sockets only), so those
 * buttons stay where they are, greyed, with the lock reason as their tooltip, and turn on
 * at the promote. Nothing moves.
 */

type Sets = Readonly<Record<string, { answerKey?: string | null }>>;

/** Whether this tab holds the ask `id`: a question set it can answer, or a proposal it has. */
export function holdsAskIn(sets: Sets, canvasProposals: Readonly<Record<string, unknown>>,
  assetProposals: Readonly<Record<string, unknown>>): (id: string) => boolean {
  return (id) => Boolean(sets[id]?.answerKey) || id in canvasProposals || id in assetProposals;
}

/** `holdsAskIn` over this tab's stores. */
export function useHoldsAsk(): (id: string) => boolean {
  const sets = useAgentQuestionsStore((s) => s.sets);
  const canvasProposals = useCanvasProposalsStore((s) => s.proposals);
  const assetProposals = useAssetProposalsStore((s) => s.proposals);
  return useMemo(() => holdsAskIn(sets, canvasProposals, assetProposals), [sets, canvasProposals, assetProposals]);
}

/** Whether this tab is held: the gate held and the person's sync hasn't come since
 * (assetProposalsStore `awaitingSync`, which the held placeholders read too). */
export function useTabHeld(): boolean {
  return useAssetProposalsStore((s) => s.awaitingSync);
}

/** The lock reason for an Update's ask while this tab is held and doesn't hold that ask, or
 * null when it can act on it (or the Update asks nothing). The same test as the Needs-you
 * rows: `heldAsks`, and their `tabHeld`. */
export function heldLockFor(note: AgentNote, holds: (id: string) => boolean, tabHeld = true): string | null {
  if (!tabHeld) return null;
  const [ask] = heldAsks([note], holds);
  if (!ask) return null;
  return ask.kind === 'questions' ? HELD_QUESTIONS_LINE : HELD_PROPOSAL_LINE;
}

/** The ops a held lock greys: the ones that open the ask. Show on canvas and Not now stay. */
export const HELD_OPS: ReadonlySet<string> = new Set(['proposal.review', 'question.answer']);

export function useHeldLock(note: AgentNote): string | null {
  const holds = useHoldsAsk();
  return heldLockFor(note, holds, useTabHeld());
}
