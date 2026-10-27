import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/backend';
import { noteProbeAnswer, refuseEditWhileOffline, startHealthProbe, subscribeOfflinePulse } from '../lib/backendConnection';
import { OFFLINE_MARK, useBackendOffline } from '../lib/useBackendOffline';

export const BACKEND_PROBE_INTERVAL_MS = 3_000;

/** GM - Design, round 14 of PR #114 ("Blocking it is"): offline is read-only.
 * Round 13 read "Nebula is offline. Reconnecting…"; GM keeps "Reconnecting…"
 * for a day when edits really queue, which they don't. */
export const OFFLINE_LINE = 'Nebula is offline. Editing is paused until it reconnects.';

/**
 * The offline banner (GM, round 14): role=status, so it is announced once
 * when it appears; it sits below the project bar so it covers nothing; on
 * reconnect it just leaves (no "Back online" toast). A blocked edit pulses
 * it once, at most once a second: a small scale nudge on a tuned spring
 * (app.css --backend-offline-spring), or with reduced motion a brief colour
 * flash. The pulse restarts a CSS animation on the same element, so the live
 * region is never re-added and never announced again.
 *
 * Each health probe is numbered as it starts and an answer older than the
 * newest one applied is ignored (review 13, L4).
 */
export function BackendConnectionStatus() {
  const offline = useBackendOffline();
  const banner = useRef<HTMLDivElement>(null);
  const [pulse, setPulse] = useState<{ seq: number; kind: 'spring' | 'flash' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const seq = startHealthProbe();
      try {
        const response = await apiFetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Backend health failed: ${response.status}`);
        if (!cancelled) noteProbeAnswer(seq, 'online');
      } catch {
        if (!cancelled) noteProbeAnswer(seq, 'offline');
      }
    };
    void probe();
    const interval = window.setInterval(() => void probe(), BACKEND_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // A press on a control disabled because Nebula is offline (OFFLINE_MARK),
  // or on a port of the read-only canvas, pulses the banner. One listener on
  // the document; nothing watches the DOM (review 14, H1).
  useEffect(() => {
    if (!offline) return;
    const pressed = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[${OFFLINE_MARK}], .canvas--read-only .react-flow__handle`)) refuseEditWhileOffline();
    };
    document.addEventListener('pointerdown', pressed, true);
    return () => document.removeEventListener('pointerdown', pressed, true);
  }, [offline]);

  useEffect(() => subscribeOfflinePulse(() => {
    const reduce = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPulse((previous) => ({ seq: (previous?.seq ?? 0) + 1, kind: reduce ? 'flash' : 'spring' }));
  }), []);

  // Restart the animation in place: drop the attribute, reflow, set it again.
  useEffect(() => {
    const element = banner.current;
    if (!element || !pulse) return;
    element.removeAttribute('data-pulse');
    void element.offsetWidth;
    element.setAttribute('data-pulse', pulse.kind);
  }, [pulse]);

  useEffect(() => { if (!offline) setPulse(null); }, [offline]);

  if (!offline) return null;

  return (
    <div
      ref={banner}
      className="backend-connection backend-connection--offline"
      role="status"
      aria-live="polite"
      data-pulse-seq={pulse?.seq}
      onAnimationEnd={() => banner.current?.removeAttribute('data-pulse')}
    >
      {OFFLINE_LINE}
    </div>
  );
}
