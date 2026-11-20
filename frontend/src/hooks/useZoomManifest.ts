import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { apiFetch } from '../lib/backend';
import { getSettings } from '../lib/api';
import { useAgentLogStore, type AgentLogEntry } from '../store/agentLogStore';

/**
 * Captures canvas-mutation events with each node's screen-space bounding
 * box and timestamp, POSTing them to the backend's zoom-manifest endpoint.
 *
 * Powers the demo-video editing chain — a custom step downstream of Chris
 * Lema's chain consumes the resulting manifest JSON to drive auto-zoom on
 * the right pixel region at the right timestamp. Beats transcript-only
 * heuristics because we have AGENT TELEMETRY, not just voice signals.
 *
 * Lifecycle: init on mount (one manifest per page load — refresh = new
 * manifest). Subscribes to the Agent log and reads each new row's `nodeIds`,
 * the nodes the agent's action touched (a structured field of the row: its
 * words name nodes by canvas name, never by id). Queries the React Flow DOM
 * for each and POSTs the bounding rect.
 *
 * Browser must be FULLSCREEN during recording so getBoundingClientRect()
 * coords match Screen Studio's screen-space pixels 1:1.
 */
export function useZoomManifest(): void {
  const { getNode } = useReactFlow();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      getSettings()
        .then((settings) => {
          if (active) setEnabled(settings.zoomTelemetryEnabled === true);
        })
        .catch((error) => console.warn('[zoom-manifest] settings check failed:', error));
    };
    refresh();
    window.addEventListener('nebula:settings-saved', refresh);
    return () => {
      active = false;
      window.removeEventListener('nebula:settings-saved', refresh);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let ready = false;
    apiFetch('/api/zoom-manifest/init', { method: 'POST' })
      .then(() => { ready = true; })
      .catch((e) => console.warn('[zoom-manifest] init failed:', e));

    function record(entry: AgentLogEntry) {
      if (!ready) return;
      const message = entry.message;
      const ids = new Set<string>(entry.nodeIds ?? []);
      if (ids.size === 0) return;

      // Multiply by devicePixelRatio so the captured bounds match the
      // recording's physical pixels (Screen Studio / QuickTime record at
      // physical resolution, ~2x logical on Retina displays). Without this,
      // the editing chain's crop/scale targets the upper-left quadrant.
      const dpr = window.devicePixelRatio || 1;
      ids.forEach((id) => {
        const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const node = getNode(id);
        const kind = (node?.type as string | undefined) ?? 'unknown';
        apiFetch('/api/zoom-manifest/entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_id: id,
            kind,
            action: message.trim(),
            dpr,
            bounds: {
              x: Math.round(rect.x * dpr),
              y: Math.round(rect.y * dpr),
              width: Math.round(rect.width * dpr),
              height: Math.round(rect.height * dpr),
            },
          }),
        }).catch((e) => console.warn('[zoom-manifest] entry failed:', e));
      });
    }

    // Each row once: the rows added since the last change, by id.
    const unsubscribe = useAgentLogStore.subscribe((state, previous) => {
      const seen = new Set(previous.entries.map((entry) => entry.id));
      for (const entry of state.entries) if (!seen.has(entry.id)) record(entry);
    });
    return unsubscribe;
  }, [enabled, getNode]);
}
