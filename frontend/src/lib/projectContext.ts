/** Request identity is captured before an async request starts. Keeping this
 * separate from stores avoids cycles in transport and history persistence. */
export interface ProjectContext { id: string; revision: string }
let context: ProjectContext | null = null;

export function getProjectContext(): ProjectContext | null { return context; }
export function setProjectContext(value: ProjectContext | null): void {
  context = value ? { ...value } : null;
}
