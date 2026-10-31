import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HELD_PENDING_ATTR, useHeldLook } from './useHeldLook';
import { personDemotedSettled, personGateAnswered, personHeldSettled, personUnconfirmed, subscribePersonGate } from '../lib/personSession';

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


/**
 * PR #204 round 10 (GM r17 item 6, option b): a view the person alone can read (the Commons,
 * Settings' agent apps and personal agents) shows, on a demoted tab, exactly what a tab that
 * never connected shows. The switch keeps the held rule: only a demote that lasts
 * HELD_LOOK_DELAY_MS switches, so a quick reconnect (a backend restart) never flashes the view
 * away and back. `epoch` counts the promotes that ended a switch, so the view reads again.
 */
export function useDemotedView(): { demoted: boolean; epoch: number } {
  // Round 11 (review 9 gates-trace MEDIUM-1): the 150 ms run from the demote itself
  // (personSession personDemotedSettled), so a view that mounts on a tab demoted long ago is
  // demoted from its first frame and sends nothing.
  const demoted = useSyncExternalStore(subscribePersonGate, personDemotedSettled, personDemotedSettled);
  // Derived while rendering (React's "adjusting state when a prop changes"): no effect, no extra pass.
  const [seen, setSeen] = useState({ demoted: false, epoch: 0 });
  if (seen.demoted !== demoted) setSeen({ demoted, epoch: demoted ? seen.epoch : seen.epoch + 1 });
  const epoch = seen.demoted !== demoted && !demoted ? seen.epoch + 1 : seen.epoch;
  return { demoted, epoch };
}

/**
 * PR #204 round 11: a view of something only the person may read (the agent apps list, personal
 * agents, the chat's agent list) reads it only on a tab connected as the person, never to be
 * refused. `ready`: the socket answered and the tab isn't held, so the read may go out. `held`:
 * show what a tab that isn't connected shows (the not-connected line, no rows), after the held
 * rule's 150 ms. `epoch` grows each time a held view ends, so a view that showed held reads
 * again; a quick reconnect inside 150 ms never does. Read once per epoch (useReadAsPerson).
 */
export function usePersonView(): { held: boolean; ready: boolean; epoch: number } {
  const ready = !useSyncExternalStore(subscribePersonGate, personUnconfirmed, personUnconfirmed);
  // The 150 ms from the hold itself (personSession personHeldSettled), not from this mount.
  const held = useSyncExternalStore(subscribePersonGate, personHeldSettled, personHeldSettled);
  const [seen, setSeen] = useState({ held: false, epoch: 0 });
  if (seen.held !== held) setSeen({ held, epoch: held ? seen.epoch : seen.epoch + 1 });
  const epoch = seen.held !== held && !held ? seen.epoch + 1 : seen.epoch;
  return { held, ready, epoch };
}

/** Runs `read` once each time the tab is ready and `epoch` is new (usePersonView). */
export function useReadAsPerson(read: () => void, ready: boolean, epoch: number): void {
  const done = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || done.current === epoch) return;
    done.current = epoch;
    read();
  }, [read, ready, epoch]);
}
