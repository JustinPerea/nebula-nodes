import { useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { TRY_AGAIN } from '../../lib/sceneSaveCopy';

/**
 * GM r11 answer 3: [Try again] beside "…They're kept and Nebula will try
 * again with your next change.", the line a scene save says once its timed
 * retries stop. It sends the scene's save again now; the save is an edit, so
 * it takes the canvas lock (read-only while following or offline).
 */
export function RetrySceneButton({ nodeId, onRetry }: { nodeId: string; onRetry: () => void }) {
  const retry = useGraphStore((state) => state.retrySceneSave);
  const lock = useCanvasLock();
  return (
    <button type="button" className="canvas-undo-notice__action" {...lock.act()}
      onClick={() => { retry(nodeId); onRetry(); }}>
      {TRY_AGAIN}
    </button>
  );
}
