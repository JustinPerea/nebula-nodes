import { useSyncExternalStore } from 'react';
import { HELD_PENDING_ATTR, useHeldLook } from '../../hooks/useHeldLook';
import { personGateAnswered, personUnconfirmed, subscribePersonGate } from '../../lib/personSession';
import type { AgentNote } from '../../lib/agentNotes';
import { HELD_PROPOSAL_LINE, HELD_QUESTIONS_LINE } from '../../store/heldAssetProposals';
import { heldAsks } from './agentNeedsYou';

/**
 * One rule for "this tab can't act on that ask yet" (GM, #204 r3 item 2; r5 item 2), used
 * by every surface that offers it: the Agents panel's Needs-you rows, an Update's own Review
 * or Answer button in the opened list and on its arrival card, and an open proposal's
 * Accept and Reject. A tab not confirmed as the person (held, demoted, or not answered yet)
 * keeps those where they are, greyed, with the lock reason as their tooltip, and they turn
 * on at the promote. Nothing moves. `holdsAskIn` is what the counts read: which asks this
 * tab knows only from their Updates.
 */

type Sets = Readonly<Record<string, { answerKey?: string | null }>>;

/** Whether this tab holds the ask `id`: a question set it can answer, or a proposal it has. */
export function holdsAskIn(sets: Sets, canvasProposals: Readonly<Record<string, unknown>>,
  assetProposals: Readonly<Record<string, unknown>>): (id: string) => boolean {
  return (id) => Boolean(sets[id]?.answerKey) || id in canvasProposals || id in assetProposals;
}

/**
 * Whether this tab isn't confirmed as the person (GM, #204 r5 item 2: "held is a state, not a
 * path"): held by a refusal, demoted after a promote, or a fresh page whose socket hasn't
 * answered yet (personSession personUnconfirmed). One state for every lock: an Update's Review
 * and Answer, the Agents panel's Needs-you rows, an open proposal's Accept and Reject.
 */
export function useTabHeld(): boolean {
  return useSyncExternalStore(subscribePersonGate, personUnconfirmed, personUnconfirmed);
}

/**
 * GM r5 2a: before the socket's first answer a lock keeps its own look for HELD_LOOK_DELAY_MS
 * (data-held-pending: aria-disabled, no grey, no reason yet), so a normal load, which answers
 * inside that, never shows grey; a slow one greys, then lifts. A refusal locks at once.
 * Whether this lock is in that first moment.
 */
export function useLockPending(locked: boolean): boolean {
  const answered = useSyncExternalStore(subscribePersonGate, personGateAnswered, personGateAnswered);
  return HELD_PENDING_ATTR in useHeldLook(locked && !answered);
}

/** The lock reason for an Update's ask while this tab isn't confirmed as the person, or null
 * when it can act on it (or the Update asks nothing). Every open ask locks, held or synced:
 * a demoted tab keeps the proposals it synced listed, but can't open them (GM r5 2b). */
export function heldLockFor(note: AgentNote, tabHeld = true): string | null {
  if (!tabHeld) return null;
  const [ask] = heldAsks([note], () => false);
  if (!ask) return null;
  return ask.kind === 'questions' ? HELD_QUESTIONS_LINE : HELD_PROPOSAL_LINE;
}

/** The ops a held lock greys: the ones that open the ask. Show on canvas and Not now stay. */
export const HELD_OPS: ReadonlySet<string> = new Set(['proposal.review', 'question.answer']);

export function useHeldLock(note: AgentNote): string | null {
  return heldLockFor(note, useTabHeld());
}
