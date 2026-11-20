import type { ProjectSummary } from './ProjectHome';
import { ASIDE_DOT } from '../../lib/labelAside';
import { groupedCount } from '../../lib/groupedCount';

const NBSP = ' ';

/** A project's node and connection counts, as its card shows them. Each count stays whole (a no-break
 * space inside it) and the line breaks before the dot (the aside form), never inside "0 nodes". */
export function ProjectCounts({ project }: { project: Pick<ProjectSummary, 'nodeCount' | 'edgeCount'> }) {
  return <span><span>{groupedCount(project.nodeCount)}{NBSP}{project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true">{ASIDE_DOT}</span><span>{groupedCount(project.edgeCount)}{NBSP}{project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>;
}
