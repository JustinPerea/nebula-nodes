import { useCallback } from 'react';
import { getViewportForBounds, useReactFlow, useStoreApi, type Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { CANVAS_FIT_DURATION, computeCanvasFitPadding, unionRects } from '../lib/canvasFit';
import { ghostBoxes } from '../lib/canvasProposals';
import { useCanvasProposalsStore } from '../store/canvasProposalsStore';

/**
 * Fit view (the bottom bar's button, Shift+1, the command palette): every
 * node, and every open proposal's ghosts, clear of the floating chrome.
 * Ghosts aren't React Flow nodes, so plain fitView left one off screen and
 * the person had to press Show. With no proposal open it is fitView itself.
 */
export function useFitCanvasView(): (duration?: number) => void {
  const { fitView, getNodes, getNodesBounds, setViewport } = useReactFlow<Node<NodeData>>();
  const store = useStoreApi<Node<NodeData>>();
  return useCallback((duration = CANVAS_FIT_DURATION) => {
    const padding = computeCanvasFitPadding();
    const { proposals, drag } = useCanvasProposalsStore.getState();
    const ghosts = Object.values(proposals)
      .filter((entry) => !entry.closing)
      .flatMap((entry) => ghostBoxes(entry.view, drag[entry.view.id]));
    if (ghosts.length === 0) {
      void fitView({ padding, duration });
      return;
    }
    const nodes = getNodes().filter((node) => !node.hidden);
    const bounds = unionRects([...(nodes.length > 0 ? [getNodesBounds(nodes)] : []), ...ghosts]);
    if (!bounds) return;
    const { width, height, minZoom, maxZoom } = store.getState();
    if (width <= 0 || height <= 0) return;
    void setViewport(getViewportForBounds(bounds, width, height, minZoom, maxZoom, padding), { duration });
  }, [fitView, getNodes, getNodesBounds, setViewport, store]);
}
