import { useEffect } from 'react';
import { useStoreApi, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import { arrangeNewNodes, sizeSignature, type ArrangeRequest, type PlacedNode } from '../../lib/arrangeEdit';
import { useArrangeStore } from '../../store/arrangeStore';
import { completeArrange, useGraphStore } from '../../store/graphStore';

/** How often to check whether the nodes have rendered at their final size. */
const CHECK_MS = 150;
/** Sizes must hold this long (an image card grows when its image loads). */
const SETTLE_MS = 300;
/** Lay out with what has been measured by then, even if an image never loaded. */
const MAX_WAIT_MS = 15000;
const MAX_ATTEMPTS = 3;

interface Watch { firstSeen: number; signature: string; stableSince: number; attempts: number; busy: boolean }

function imagesLoaded(nodeId: string): boolean {
  const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!element) return false;
  return [...element.querySelectorAll('img')].every((img) => {
    // Card images load lazily, so one off screen never loads and its card
    // never reaches its real height. Load it now: the layout needs that size.
    if (!img.complete && img.loading === 'lazy') img.loading = 'eager';
    return img.complete;
  });
}

/**
 * Lays out an agent edit's new nodes once they have rendered (decision C3).
 * The backend sends open requests with every graphSync; this waits until the
 * nodes are measured, their images loaded and their sizes steady, then runs
 * arrangeNewNodes and writes the result back with completeArrange. Renders
 * nothing; lives inside <ReactFlow> to read measured sizes.
 */
export function ArrangeController() {
  const store = useStoreApi<Node<NodeData>>();
  const pending = useArrangeStore((s) => s.pending);

  useEffect(() => {
    const { finished: done, markFinished } = useArrangeStore.getState();
    const finished = new Set(done);
    const finish = (id: string) => { finished.add(id); markFinished(id); };
    const open = pending.filter((request) => !finished.has(request.id));
    if (open.length === 0) return undefined;
    const watches = new Map<string, Watch>();

    const placed = (request: ArrangeRequest): { all: PlacedNode[]; mine: PlacedNode[]; measured: boolean } => {
      const { nodeLookup } = store.getState();
      const all = useGraphStore.getState().nodes.map((node): PlacedNode => {
        const internal = nodeLookup.get(node.id);
        return {
          id: node.id,
          position: node.position,
          width: internal?.measured?.width ?? node.measured?.width ?? node.width,
          height: internal?.measured?.height ?? node.measured?.height ?? node.height,
        };
      });
      const wanted = new Set(request.nodeIds);
      const mine = all.filter((node) => wanted.has(node.id));
      const measured = mine.length > 0 && mine.every((node) => (node.width ?? 0) > 0 && (node.height ?? 0) > 0);
      return { all, mine, measured };
    };

    const check = () => {
      const now = Date.now();
      for (const request of open) {
        if (finished.has(request.id)) continue;
        const watch = watches.get(request.id)
          ?? { firstSeen: now, signature: '', stableSince: now, attempts: 0, busy: false };
        watches.set(request.id, watch);
        if (watch.busy) continue;
        const { all, mine, measured } = placed(request);
        if (mine.length === 0) {
          // Not merged into this canvas yet. If they never arrive, stop waiting,
          // or this tab would keep drawing every node (selectMeasuring) for good.
          if (now - watch.firstSeen >= MAX_WAIT_MS) finish(request.id);
          continue;
        }
        const signature = sizeSignature(mine);
        if (signature !== watch.signature) {
          watch.signature = signature;
          watch.stableSince = now;
        }
        const settled = measured && now - watch.stableSince >= SETTLE_MS
          && mine.every((node) => imagesLoaded(node.id));
        if (!settled && now - watch.firstSeen < MAX_WAIT_MS) continue;

        const positions = arrangeNewNodes(request, all, useGraphStore.getState().edges);
        if (!positions) {
          finish(request.id);
          continue;
        }
        watch.busy = true;
        watch.attempts += 1;
        completeArrange(request.id, positions)
          .then((result) => {
            if (result !== 'refused' || watch.attempts >= MAX_ATTEMPTS) finish(request.id);
          })
          .catch((error) => {
            console.warn('[nebula] arrange write failed:', error);
            if (watch.attempts >= MAX_ATTEMPTS) finish(request.id);
          })
          .finally(() => { watch.busy = false; });
      }
    };

    const timer = window.setInterval(check, CHECK_MS);
    check();
    return () => window.clearInterval(timer);
  }, [pending, store]);

  return null;
}
