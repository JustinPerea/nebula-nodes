import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/backend';
import { clearCurrentProjectCache } from '../lib/currentProject';

type ConnectionState = 'online' | 'offline';

export const BACKEND_PROBE_INTERVAL_MS = 3_000;

/** Persistent, non-blocking truth for local backend loss and recovery. */
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

        if (previous.current === 'offline') {
          clearCurrentProjectCache();
        }
        previous.current = 'online';
        setConnection('online');
      } catch {
        if (cancelled) return;
        previous.current = 'offline';
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
      Backend offline — Canvas edits remain local. Reconnecting…
    </div>
  );
}
