import { useEffect, useState } from 'react';
import { LOCK_LINE_HELD_ATTR, type PersonLock } from '../../hooks/usePersonLock';
import { useBackendOffline } from '../../lib/useBackendOffline';

/** How long Add's line waits for the page's because line before it shows alone (GM r23 1). */
export const ADD_LINE_HOLD_MS = 1500;

/**
 * PR #204 round 14 (GM r23 1, one shift on a demote): Add locks at once, but its line waits for
 * the page's because line (`ready`), so both land in the same frame and the row moves once. If
 * no because line has come within ADD_LINE_HOLD_MS, Add's line shows on its own. The wait starts
 * when the line could first show: the lock taking hold, or Nebula coming back online with the tab
 * still not connected (the loads read again then, and their line comes again). Once shown, the
 * line stays while the lock does.
 *
 * Only the line and Add's pointer to it wait: the lock itself (aria-disabled, the guard, the look)
 * is the lock's.
 */
export function useLockLineHold(lock: PersonLock, ready: boolean): PersonLock {
  const offline = useBackendOffline();
  const waiting = lock.locked && !offline;
  const [hold, setHold] = useState({ waiting, open: false });
  let open = hold.open;
  if (hold.waiting !== waiting) {
    open = false;
    setHold({ waiting, open });
  } else if (waiting && ready && !open) {
    open = true;
    setHold({ waiting, open });
  }
  useEffect(() => {
    if (!waiting || open) return undefined;
    const timer = window.setTimeout(() => setHold({ waiting: true, open: true }), ADD_LINE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, open]);
  if (open || !lock.shown) return lock;
  return {
    ...lock,
    shown: false,
    control: (describedBy) => ({
      ...lock.control(describedBy),
      'aria-describedby': describedBy || undefined,
      [LOCK_LINE_HELD_ATTR]: '',
    }),
  };
}
