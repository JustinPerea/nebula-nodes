import { useSyncExternalStore } from 'react';
import { HELD_PENDING_ATTR, useHeldLook } from './useHeldLook';
import { personGateAnswered, personUnconfirmed, subscribePersonGate } from '../lib/personSession';

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
