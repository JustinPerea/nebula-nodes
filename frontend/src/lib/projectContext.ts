/** Request identity is captured before an async request starts. Keeping this
 * separate from stores avoids cycles in transport and history persistence. */
export interface ProjectContext { id: string; revision: string }
let context: ProjectContext | null = null;

export function getProjectContext(): ProjectContext | null { return context; }
export function setProjectContext(value: ProjectContext | null): void {
  context = value ? { ...value } : null;
}

/** What the backend answers a canvas write sent for another project or an
 * older workspace (backend main._check_workspace_revision), word for word.
 * The canvas gives a write the same answer when it held it back for that
 * reason (graphStore.graphMutationFetch, review 17 H-1), so the person reads
 * what a refused write always said. */
export const STALE_CANVAS_DETAIL = 'This canvas is out of date. Open the current project before editing or running it.';
