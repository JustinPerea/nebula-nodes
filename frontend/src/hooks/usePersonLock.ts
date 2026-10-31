import { useId, type SyntheticEvent } from 'react';
import { useLockPending, useTabHeld } from './useTabHeld';
import { personLockLine } from '../lib/errorCopy';

/** Marks a control locked by usePersonLock (tests read it; styles may). Its value is the verb. */
export const PERSON_LOCK_ATTR = 'data-person-lock';

export interface LockProps {
  'aria-disabled'?: true;
  'data-held-pending'?: '';
  'aria-describedby'?: string;
  'data-person-lock'?: string;
}

export interface PersonLock {
  /** This tab isn't confirmed as the person: held, demoted, or not answered yet. */
  locked: boolean;
  /** The lock's words ("You can <verb> when this tab is connected as you."), shown or not. */
  line: string;
  /** The line is on screen (after the first moment: GM r5 2a). */
  shown: boolean;
  /** The line's element id, for aria-describedby. */
  id: string;
  /** Spread on each control the lock holds: aria-disabled, the first-moment look and the line
   * (after `describedBy`, the control's own description, when it has one). */
  control: (describedBy?: string) => LockProps;
  /** Wraps a control's handler: while locked it does nothing (aria-disabled doesn't stop a click). */
  guard: <A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => void;
}

/**
 * PR #204 round 10 (GM r15): the one lock for a control whose route is the person's alone
 * (personGateRoutes.py: require_person / person_only / the Commons' human_dep). While this tab
 * isn't connected as the person, the control stays where it is and focusable (aria-disabled, the
 * shared disabled look after the first moment), the line sits under it with no tooltip, and both
 * lift on the promote. A demoted tab locks too (GM r16 Q4). The line renders through
 * components/PersonLock; tests/personLockSweep.ratchet.test.ts fails a control that reaches a
 * person-only route without this.
 */
export function usePersonLock(verb: string, active = true): PersonLock {
  // `active`: whether the control is live at all (an ask still open); a closed one never locks.
  const locked = useTabHeld() && active;
  const pending = useLockPending(locked);
  const shown = locked && !pending;
  const id = useId();
  const line = personLockLine(verb);
  return {
    locked, line, shown, id,
    control: (describedBy) => ({
      'aria-disabled': locked || undefined,
      'data-held-pending': locked && pending ? '' : undefined,
      'aria-describedby': [describedBy, shown ? id : undefined].filter(Boolean).join(' ') || undefined,
      'data-person-lock': locked ? verb : undefined,
    }),
    guard: (fn) => (...args) => {
      if (locked) {
        const event = args[0] as SyntheticEvent | undefined;
        if (event && typeof event === 'object' && 'preventDefault' in event) event.preventDefault();
        return;
      }
      void fn(...args);
    },
  };
}
