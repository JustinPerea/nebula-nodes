import { canvasGeneration, useGraphStore } from '../../store/graphStore';
import { getProjectContext } from '../../lib/projectContext';
import { paletteDropNotes, setPaletteDropNote, type PaletteDropNote } from './usePaletteExtracts';

/**
 * GM r48 bug 2 on #222: the dropped-upload line ("Nebula couldn’t add
 * “sunset.png” … Choose the file again.") is stale over a file that has
 * since been replaced. It goes on ANY change to that param's value: a
 * person's pick, an agent's set over MCP or the CLI (a graphSync, through
 * updateNodeData), an undo or a redo. The clear is keyed on the value, not
 * on the path that changed it, so a new path can't miss it:
 *
 * - watchFileDropNotes: a store subscription. Within one canvas (the same
 *   project and graph generation), a param whose value changed between two
 *   states clears its line. A load or a replace isn't a change (the node ids
 *   are another canvas's then).
 * - fileDropNoteStale: the Inspector never shows a line over a value other
 *   than the one the param held at the pick (a change made while the person
 *   was in another project, read when the canvas loads again).
 */
export function fileDropNoteStale(note: PaletteDropNote, value: unknown): boolean {
  return note.file !== undefined && !Object.is(note.file.value, value ?? '');
}

/** The lines whose param changed from `before` to `after` (one canvas). */
export function clearChangedFileDropNotes(
  before: readonly { id: string; data: { definitionId?: string; params?: Record<string, unknown> } }[],
  after: readonly { id: string; data: { definitionId?: string; params?: Record<string, unknown> } }[],
  project: string | null,
): void {
  const waiting = paletteDropNotes().filter(([, note]) => note.file && note.file.project === project);
  if (!waiting.length) return;
  for (const [key, note] of waiting) {
    const { nodeId, key: param } = note.file!;
    const was = before.find((n) => n.id === nodeId);
    const now = after.find((n) => n.id === nodeId);
    if (!was || !now || was === now || was.data.definitionId !== now.data.definitionId) continue;
    if (!Object.is(was.data.params?.[param] ?? '', now.data.params?.[param] ?? '')) setPaletteDropNote(key, null);
  }
}

let watching = false;

/** Installed once (Inspector.tsx, at module load). */
export function watchFileDropNotes(): void {
  if (watching) return;
  watching = true;
  let generation = canvasGeneration();
  let project = getProjectContext()?.id ?? null;
  useGraphStore.subscribe((state, previous) => {
    const nowGeneration = canvasGeneration();
    const nowProject = getProjectContext()?.id ?? null;
    if (nowGeneration !== generation || nowProject !== project) {
      generation = nowGeneration;
      project = nowProject;
      return;
    }
    if (state.nodes === previous.nodes) return;
    clearChangedFileDropNotes(previous.nodes, state.nodes, nowProject);
  });
}
