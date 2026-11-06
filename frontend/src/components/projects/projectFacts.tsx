import type { ProjectSummary } from './ProjectHome';

/** A project's node and connection counts, as its card shows them. */
export function ProjectCounts({ project }: { project: Pick<ProjectSummary, 'nodeCount' | 'edgeCount'> }) {
  return <span><span>{project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true"> · </span><span>{project.edgeCount} {project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>;
}
