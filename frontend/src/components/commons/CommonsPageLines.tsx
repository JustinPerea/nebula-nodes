import type { ReactNode } from 'react';
import { CommonsErrorLine } from './CommonsErrorLine';
import { PersonLockLine, type PersonLock } from '../PersonLock';
import { PAGE_LINES_ATTR } from '../../lib/lockPlacement';

/**
 * PR #204 round 12 (GM r20 1): the Commons' one row for page-level lines, just below its header.
 * The banner's line (a load's or an action's failure, or the because line) comes first; Add's
 * lock line ("You can add references when this tab is connected as you.") sits under it as its own
 * sentence, or takes the row alone when no banner shows. The header keeps its 48 px: nothing of
 * the lock goes in it (tests/presenceRound7.toolbar holds the row to controls and states).
 * The rest of the row (upload failures, a notice, the proposals line) follows.
 */
export function CommonsPageLines({ line, lock, children, more = false }: {
  line: string | null | undefined;
  lock: PersonLock;
  /** Whether `children` has anything to show (the row renders only with something in it). */
  more?: boolean;
  children?: ReactNode;
}) {
  if (!line && !lock.shown && !more) return null;
  return (
    <div className="commons-messages" {...{ [PAGE_LINES_ATTR]: '' }}>
      <CommonsErrorLine line={line} />
      <PersonLockLine lock={lock} place="page" className="commons-messages__lock-line" />
      {children}
    </div>
  );
}
