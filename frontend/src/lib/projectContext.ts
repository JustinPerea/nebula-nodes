/** Request identity is captured before an async request starts. Keeping this
 * separate from stores avoids cycles in transport and history persistence. */
/** `canvas`: which canvas of the project the tab holds (backend
 * main._canvas_revision, new on every clear and import), when the tab has
 * heard it. A write sends the one read when the person acted
 * (X-Nebula-Canvas-Revision), so Nebula refuses it once that canvas was
 * cleared or replaced (round 19 of PR #195, review 18 H-A). */
export interface ProjectContext { id: string; revision: string; canvas?: string }
let context: ProjectContext | null = null;

export function getProjectContext(): ProjectContext | null { return context; }
export function setProjectContext(value: ProjectContext | null): void {
  context = value ? { ...value } : null;
}

/** Nebula named the canvas it holds now (a graphSync, a clear's or an
 * import's answer): the tab takes it, when it is about the project and
 * workspace revision the tab holds. A new object, so a write admitted
 * earlier keeps the one it read. */
export function adoptCanvasRevision(workspaceRevision: unknown, canvas: unknown): void {
  if (!context || typeof canvas !== 'string' || canvas === context.canvas) return;
  if (workspaceRevision !== undefined && workspaceRevision !== context.revision) return;
  context = { ...context, canvas };
}

/** A clear's or an import's answer names the canvas Nebula holds now. An
 * answer without one (an older backend, a test's) changes nothing. */
export async function adoptCanvasRevisionFrom(response: unknown): Promise<void> {
  try {
    const body = await (response as Response).clone().json() as { canvasRevision?: unknown } | null;
    adoptCanvasRevision(undefined, body?.canvasRevision);
  } catch { /* No canvas named: the graphSync's says it. */ }
}

/** What the backend answers a canvas write sent for another project or an
 * older workspace (backend main._check_workspace_revision), word for word.
 * The canvas gives a write the same answer when it held it back for that
 * reason (graphStore.graphMutationFetch, review 17 H-1), so the person reads
 * what a refused write always said. */
export const STALE_CANVAS_DETAIL = 'This canvas is out of date. Open the current project before editing or running it.';
