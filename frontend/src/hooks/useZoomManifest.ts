import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

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
 * manifest). Subscribes to `nebula:agent-log-entry` events (already
 * dispatched by ChatPanel for thinking-stream lines and other action
 * publishers). Parses node IDs (n1, n2, …) out of the message, queries
 * the React Flow DOM for each, and POSTs the bounding rect.
 *
 * Browser must be FULLSCREEN during recording so getBoundingClientRect()
 * coords match Screen Studio's screen-space pixels 1:1.
 */
const NODE_ID_RE = /\b(n\d+)\b/g;

type AgentLogDetail = { source: string; message: string };

export function useZoomManifest(): void {
  const { getNode } = useReactFlow();

  useEffect(() => {
    let cancelled = false;

    fetch('/api/zoom-manifest/init', { method: 'POST' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        console.log('[zoom-manifest] init', data);
      })
      .catch((e) => console.warn('[zoom-manifest] init failed:', e));

    function handler(e: Event) {
      const detail = (e as CustomEvent<AgentLogDetail>).detail;
      if (!detail || !detail.message) return;
      const message = detail.message;
      const ids = new Set<string>();
      let match: RegExpExecArray | null;
      NODE_ID_RE.lastIndex = 0;
      while ((match = NODE_ID_RE.exec(message)) !== null) {
        ids.add(match[1]);
      }
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
        fetch('/api/zoom-manifest/entry', {
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

    window.addEventListener('nebula:agent-log-entry', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('nebula:agent-log-entry', handler);
    };
  }, [getNode]);
}
