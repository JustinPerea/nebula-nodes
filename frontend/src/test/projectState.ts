import { useProjectStore } from '../store/projectStore';
import type { ProjectSummary } from '../lib/projects';

/** A project as the listing gives it, for tests. */
export function projectSummary(id: string, name: string): ProjectSummary {
  return { id, name, createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null };
}

/** Make `open` the canvas project this tab has open (null: none, as on a
 * fresh install), with `others` also in the project list. Tests use it
 * instead of mocking lib/currentProject, which reads this store. */
export function setOpenProject(open: [string, string] | null, others: Array<[string, string]> = []): void {
  const projects = [...(open ? [open] : []), ...others].map(([id, name]) => projectSummary(id, name));
  useProjectStore.setState({
    initialized: true,
    screen: open ? 'workspace' : 'home',
    activeProject: open ? projectSummary(open[0], open[1]) : null,
    projects,
  });
}
