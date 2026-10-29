import { useMemo } from 'react';
import { sceneStopLines, useGraphStore } from '../../store/graphStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { TRY_AGAIN } from '../../lib/sceneSaveCopy';

/**
 * GM r28: a scene's stop line is a state, never lost. The lines sit in
 * their own slot above the event slot (lib/noticeSlots.ts 'scene-stop'),
 * one per cause, naming their scenes with the shared rule (up to 3 by name,
 * from 4 a count); no event pushes them out. [Try again] retries every
 * scene its line names, each once: the scenes that fail stay in the line,
 * and a scene whose stop clears leaves it, so the line shrinks or goes.
 * No hold and no ×: the line goes when the stop does. A scene whose clash
 * waits is asked by its prompt instead, and the scene whose "Unsaved"
 * popover is open is left out while it is (its line is there).
 */
export function SceneStopLines() {
  const nodes = useGraphStore((state) => state.nodes);
  const stoppedScenes = useGraphStore((state) => state.stoppedScenes);
  const sceneStops = useGraphStore((state) => state.sceneStops);
  const scenePopover = useGraphStore((state) => state.scenePopover);
  const retry = useGraphStore((state) => state.retrySceneSave);
  // A try saves: read-only while following or offline, as every edit is.
  const lock = useCanvasLock();
  const lines = useMemo(() => sceneStopLines({ nodes, stoppedScenes, sceneStops, scenePopover }),
    [nodes, stoppedScenes, sceneStops, scenePopover]);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <div key={line.key} className="canvas-undo-notice scene-stop-line" role="status" aria-live="polite" data-scene-stop={line.key}>
          <span className="canvas-undo-notice__text">{line.text}</span>
          <button type="button" className="canvas-undo-notice__action" {...lock.act()}
            onClick={() => { for (const nodeId of line.nodeIds) retry(nodeId); }}>
            {TRY_AGAIN}
          </button>
        </div>
      ))}
    </>
  );
}
