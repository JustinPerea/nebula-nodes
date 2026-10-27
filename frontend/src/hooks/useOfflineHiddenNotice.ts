import { useEffect, useRef } from 'react';
import { useBackendOffline } from '../lib/useBackendOffline';

/**
 * A screen's own load-failure notice, hidden while Nebula is offline (GM, PR
 * #198 r2): "Character not found…", "Moodboard not found…", "Couldn't check
 * the Commons status…" read as if something was lost when the backend is
 * only away, and the banner already says so. Returns the notice to show
 * (null while offline). On reconnect, `onReconnect` runs once while there is
 * a notice, so the screen checks again: the notice comes back only if it
 * still applies.
 */
export function useOfflineHiddenNotice<T>(notice: T | null, onReconnect?: () => void): T | null {
  const offline = useBackendOffline();
  const wasOffline = useRef(offline);
  const latest = useRef({ notice, onReconnect });
  useEffect(() => { latest.current = { notice, onReconnect }; });

  useEffect(() => {
    const reconnected = wasOffline.current && !offline;
    wasOffline.current = offline;
    if (reconnected && latest.current.notice !== null) latest.current.onReconnect?.();
  }, [offline]);

  return offline ? null : notice;
}
