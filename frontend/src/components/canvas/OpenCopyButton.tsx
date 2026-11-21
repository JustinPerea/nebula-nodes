import { useProjectStore } from '../../store/projectStore';
import { keptLockTitle, useKeptCanvas } from '../../lib/keptCanvas';
import { KEPT_MARK } from '../../lib/canvasLock';

/**
 * Design: "Open copy" beside the failed handoff's line
 * ("…Your edits were saved as a copy, “<copy name>”."). The copy is a
 * whole project in Projects; this opens it as Open on its card would (the
 * person's own switch: it drains this canvas's saves first).
 */
export function OpenCopyButton({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const busy = useProjectStore((state) => state.busy);
  // Design, PR #199: opening another project would strand a kept canvas.
  const kept = useKeptCanvas();
  return (
    <button type="button" className="canvas-undo-notice__action"
      {...(kept ? { [KEPT_MARK]: '', disabled: true, title: keptLockTitle('open') } : { disabled: busy })}
      onClick={() => { onOpen(); void useProjectStore.getState().open(projectId); }}>
      Open copy
    </button>
  );
}
