import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/backend';
import { noteBackendConnection } from '../lib/backendConnection';

type ConnectionState = 'online' | 'offline';

export const BACKEND_PROBE_INTERVAL_MS = 3_000;

/** GM - Design, round 13 of PR #114 (was "Backend offline — Canvas edits
 * remain local. Reconnecting…"). GM's second sentence, "Your changes stay in
 * this tab until it reconnects.", goes in only if edits to an open canvas
 * really queue while offline; they don't (the round 13 notes say what
 * happens to them), so it stays out. */
export const OFFLINE_LINE = 'Nebula is offline. Reconnecting…';

/** Persistent, non-blocking truth for local backend loss and recovery. Each
 * answer is noted for the rest of the tab (lib/backendConnection: an add
 * while offline says GM's line before sending anything). */
export function BackendConnectionStatus() {
  const [connection, setConnection] = useState<ConnectionState>('online');
  const previous = useRef<ConnectionState>('online');

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const response = await apiFetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Backend health failed: ${response.status}`);
        if (cancelled) return;

        previous.current = 'online';
        noteBackendConnection('online');
        setConnection('online');
      } catch {
        if (cancelled) return;
        previous.current = 'offline';
        noteBackendConnection('offline');
        setConnection('offline');
      }
    };

    void probe();
    const interval = window.setInterval(() => void probe(), BACKEND_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  if (connection === 'online') return null;

  return (
    <div
      className="backend-connection backend-connection--offline"
      role="status"
      aria-live="polite"
    >
      {OFFLINE_LINE}
    </div>
  );
}
