import { Home } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import './ProjectWorkspaceControls.css';

export function ProjectWorkspaceControls() {
  const project = useProjectStore((state) => state.activeProject);
  const screen = useProjectStore((state) => state.screen);
  const status = useProjectStore((state) => state.saveStatus);
  const busy = useProjectStore((state) => state.busy);
  const error = useProjectStore((state) => state.error);
  const nodeCount = useGraphStore((state) => state.nodes.length);
  if (!project || screen !== 'workspace') return null;
  const label = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : status === 'unsaved' ? 'Unsaved changes' : 'Saved';
  return (
    <div className="project-workspace-controls">
      <button type="button" className="project-workspace-controls__home" aria-label="Back to projects"
        title="Projects" disabled={busy} onClick={() => void useProjectStore.getState().goHome()}>
        <Home size={16} aria-hidden="true" />
      </button>
      <span className="project-workspace-controls__name" title={project.name}>{project.name}</span>
      {status === 'error'
        ? <button type="button" className="project-workspace-controls__retry" title={error ?? 'Retry saving'}
            onClick={() => void useProjectStore.getState().retry()}>Save failed · Retry</button>
        : <span className={`project-workspace-controls__status${status === 'saved' ? ' project-workspace-controls__status--settled' : ''}`}
            role="status">{label}</span>}
      <span className="project-workspace-controls__count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>
    </div>
  );
}
