import { useProjectStore } from '../../store/projectStore';

/**
 * GM - Design, round 20 (follow-up 2): "Open copy" beside the failed
 * handoff's line ("…Your edits were saved as a copy, “<copy name>”."). The
 * copy is a whole project in Projects; this opens it as Open on its card
 * would (the person's own switch: it drains this canvas's saves first).
 */
export function OpenCopyButton({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const busy = useProjectStore((state) => state.busy);
  return (
    <button type="button" className="canvas-undo-notice__action" disabled={busy}
      onClick={() => { onOpen(); void useProjectStore.getState().open(projectId); }}>
      Open copy
    </button>
  );
}
