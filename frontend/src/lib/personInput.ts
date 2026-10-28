/**
 * The person's own edits on the canvas (GM r13 on PR #199, 1): an undo step
 * the person's own action takes (graphStore pushUndo / pushOwnAdd), or their
 * Undo and Redo. Never a graphSync, an agent's edit arriving, or a canvas
 * the tab loads. The project store says the first one in each project to the
 * backend (wsClient.notePersonAct 'personInput'), which ends the protection
 * of a project filed from the person's waiting canvas.
 */
type Listener = () => void;

let listener: Listener | null = null;

/** The one listener (projectStore's subscribeProjectAutosave). */
export function onPersonInput(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

/** One of the person's own edits happened. */
export function notePersonInput(): void {
  listener?.();
}
