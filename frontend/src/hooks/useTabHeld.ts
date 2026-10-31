import { useState, useSyncExternalStore } from 'react';
import { HELD_LOOK_ATTR, HELD_PENDING_ATTR, useHeldLook } from './useHeldLook';
import { personGateAnswered, personGateHeld, personUnconfirmed, personWasPromoted, subscribePersonGate } from '../lib/personSession';

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

/** The server promoted this tab once, and now holds it (a demote). */
const demotedNow = (): boolean => personGateHeld() && personWasPromoted();

/**
 * PR #204 round 10 (GM r17 item 6, option b): a view the person alone can read (the Commons,
 * Settings' agent apps and personal agents) shows, on a demoted tab, exactly what a tab that
 * never connected shows. The switch keeps the held rule: only a demote that lasts
 * HELD_LOOK_DELAY_MS switches, so a quick reconnect (a backend restart) never flashes the view
 * away and back. `epoch` counts the promotes that ended a switch, so the view reads again.
 */
export function useDemotedView(): { demoted: boolean; epoch: number } {
  const lost = useSyncExternalStore(subscribePersonGate, demotedNow, demotedNow);
  const demoted = HELD_LOOK_ATTR in useHeldLook(lost);
  // Derived while rendering (React's "adjusting state when a prop changes"): no effect, no extra pass.
  const [seen, setSeen] = useState({ demoted: false, epoch: 0 });
  if (seen.demoted !== demoted) setSeen({ demoted, epoch: demoted ? seen.epoch : seen.epoch + 1 });
  const epoch = seen.demoted !== demoted && !demoted ? seen.epoch + 1 : seen.epoch;
  return { demoted, epoch };
}
