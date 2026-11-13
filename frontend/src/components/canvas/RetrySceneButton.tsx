import { useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { TRY_AGAIN } from '../../lib/sceneSaveCopy';
import { useHeldLook } from '../../hooks/useHeldLook';

/**
 * GM r11 answer 3: [Try again] beside "…They’re kept, and Nebula will try
 * again with your next change.", the line a scene save says once its timed
 * retries stop. It sends the scene's save again now; the save is an edit, so
 * it takes the canvas lock (read-only while following or offline).
 */
export function RetrySceneButton({ nodeId, onRetry }: { nodeId: string; onRetry: () => void }) {
  const retry = useGraphStore((state) => state.retrySceneSave);
  // GM r29 call 2: disabled while its try is on its way, the label as it is.
  // aria-disabled, not disabled: a focused button that turns disabled loses
  // focus to the page (review 18 LOW-1); a press meanwhile does nothing.
  // GM r30: grey after a moment (useHeldLook), no reason tooltip.
  const trying = useGraphStore((state) => nodeId in state.sceneTries);
  const held = useHeldLook(trying);
  const lock = useCanvasLock();
  return (
    <button type="button" className="canvas-undo-notice__action" {...lock.act({ kept: 'scene' })} {...held}
      onClick={() => { if (trying) return; retry(nodeId); onRetry(); }}>
      {TRY_AGAIN}
    </button>
  );
}
