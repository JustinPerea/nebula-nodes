import { LineText } from './LineText';
import type { PersonLock } from '../hooks/usePersonLock';
import { LOCK_PLACE_ATTR, type LockPlace } from '../lib/lockPlacement';
import { FOCUS_LINE_ATTR } from '../hooks/useFocusHandover';
import '../styles/personLock.css';

export type { LockProps, PersonLock } from '../hooks/usePersonLock';
export type { LockPlace } from '../lib/lockPlacement';

/**
 * The lock's line, while it shows. One per lock. PR #204 round 11 (GM r18): one placement rule,
 * a lock line sits directly under the heading of what it covers (`place`):
 *
 * - 'heading': a group (a section, a list of rows) gets it right under the group's heading.
 * - 'tab': a whole tab gets it at the top of the tab, before anything else (Storage).
 * - 'control': a form, or a single row or button, gets it right under the control it locks
 *   (under its submit button: Connect, Add).
 *
 * lib/lockPlacement lockPlacementProblems reads the rule back from the page; the tests and the
 * live check run it over every screen.
 */
export function PersonLockLine({ lock, place, className }: { lock: PersonLock; place: LockPlace; className?: string }) {
  if (!lock.shown) return null;
  return (
    // tabIndex -1: it can take focus when a demote removes the control it locks (GM r19 2).
    <p id={lock.id} className={`person-lock-line${className ? ` ${className}` : ''}`} tabIndex={-1}
      {...{ [LOCK_PLACE_ATTR]: place, [FOCUS_LINE_ATTR]: '' }}>
      <LineText text={lock.line} />
    </p>
  );
}
