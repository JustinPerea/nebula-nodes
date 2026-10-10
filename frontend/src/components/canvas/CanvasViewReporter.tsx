import { useEffect, useRef } from 'react';
import { useStore, useStoreApi, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { buildCanvasViewReport, publishCanvasView } from '../../lib/canvasView';

/** At most one report per interval; the latest state always goes out. */
const REPORT_INTERVAL_MS = 300;

/**
 * Tells the backend what the canvas looks like (viewport, node bounds, run
 * states) so agents can read it with `nebula look` instead of a screenshot.
 * Renders nothing; lives inside <ReactFlow> to read its store.
 */
export function CanvasViewReporter() {
  const store = useStoreApi<Node<NodeData>>();
  const nodes = useStore((s) => s.nodes);
  const transform = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const lastSent = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  // Created per mount: Strict Mode mounts twice, and a controller made once in
  // a ref initialiser would stay aborted after the first cleanup.
  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = controller;
    return () => {
      controller.abort();
      if (inFlight.current === controller) inFlight.current = null;
    };
  }, []);

  useEffect(() => {
    // Throttle rather than debounce: a node streaming progress changes `nodes`
    // every few hundred ms, and a debounce would never let a report through.
    const wait = Math.max(0, REPORT_INTERVAL_MS - (Date.now() - lastSent.current));
    const timeout = window.setTimeout(() => {
      lastSent.current = Date.now();
      const state = store.getState();
      const report = buildCanvasViewReport(state.transform, { width: state.width, height: state.height }, state.nodeLookup);
      const signal = inFlight.current?.signal;
      if (!signal || signal.aborted) return;
      publishCanvasView(report, signal).catch((error) => {
        if (signal.aborted) return;
        console.warn('[nebula] canvas view sync failed:', error);
      });
    }, wait);
    return () => window.clearTimeout(timeout);
  }, [store, nodes, transform, width, height]);

  return null;
}
