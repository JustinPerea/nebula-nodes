import { useEffect, useRef } from 'react';
import { isBackendOffline, subscribeBackendConnection } from '../lib/backendConnection';
import { useBackendOffline } from '../lib/useBackendOffline';

/**
 * A screen's own load-failure notice, hidden while Nebula is offline (GM, PR
 * #198 r2): "Character not found…", "Moodboard not found…", "Couldn't check
 * the Commons status…" read as if something was lost when the backend is
 * only away, and the banner already says so. Returns the notice to show
 * (null while offline). On reconnect, `onReconnect` runs once while there is
 * a notice, so the screen checks again: the notice comes back only if it
 * still applies.
 *
 * `onReconnect` runs from the connection's own change, not an effect after
 * the next render (PR #198 review 3, N1: that render showed the old notice
 * for a frame before the check cleared it). What it sets lands in the same
 * update as "online", so the first render back online already has it.
 */
export function useOfflineHiddenNotice<T>(notice: T | null, onReconnect?: () => void): T | null {
  const offline = useBackendOffline();
  const latest = useRef({ notice, onReconnect });
  useEffect(() => { latest.current = { notice, onReconnect }; });

  useEffect(() => {
    let wasOffline = isBackendOffline();
    return subscribeBackendConnection(() => {
      const now = isBackendOffline();
      const reconnected = wasOffline && !now;
      wasOffline = now;
      if (reconnected && latest.current.notice !== null) latest.current.onReconnect?.();
    });
  }, []);

  return offline ? null : notice;
}
