import { useState } from 'react';
import { Home } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useGraphStore } from '../../store/graphStore';
import { shortLine } from '../../lib/errorCopy';
import './ProjectWorkspaceControls.css';

/** `onHome`: the screen's own way to Projects (the Commons asks first); `homeBusy`: it waits on a save. */
export function ProjectWorkspaceControls({ onHome, homeBusy = false }: { onHome?: (button: HTMLButtonElement) => void; homeBusy?: boolean }) {
  const project = useProjectStore((state) => state.activeProject);
  const screen = useProjectStore((state) => state.screen);
  const status = useProjectStore((state) => state.saveStatus);
  const busy = useProjectStore((state) => state.busy);
  const saveError = useProjectStore((state) => state.saveError);
  const nodeCount = useGraphStore((state) => state.nodes.length);
  const [draft, setDraft] = useState<string | null>(null);
  if (!project || screen !== 'workspace') return null;
  const finishRename = (save: boolean) => {
    const name = draft?.trim() ?? '';
    if (save && name && name !== project.name) void useProjectStore.getState().rename(project.id, name);
    setDraft(null);
  };
  const label = status === 'saving' ? 'Saving…' : status === 'error' ? 'Save failed' : status === 'unsaved' ? 'Unsaved changes' : 'Saved';
  return (
    <div className="project-workspace-controls">
      <button type="button" className="project-workspace-controls__home" aria-label={homeBusy ? 'Saving…' : 'Back to projects'}
        aria-busy={homeBusy || undefined} title="Projects" disabled={busy}
        onClick={(event) => (onHome ? onHome(event.currentTarget) : void useProjectStore.getState().goHome())}>
        <Home size={16} aria-hidden="true" />
        {homeBusy && <span className="project-workspace-controls__busy">Saving…</span>}
      </button>
      {draft !== null
        ? <input className="project-workspace-controls__name project-workspace-controls__name-input" aria-label="Project name"
            autoFocus maxLength={120} value={draft} onFocus={(event) => event.target.select()}
            onChange={(event) => setDraft(event.target.value)} onBlur={() => finishRename(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); finishRename(true); }
              else if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
            }} />
        : <button type="button" className="project-workspace-controls__name" title={`${project.name} · double-click to rename`}
            aria-label={`Rename project ${project.name}`} disabled={busy}
            onDoubleClick={() => setDraft(project.name)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); setDraft(project.name); }
            }}>{project.name}</button>}
      {status === 'error'
        // Round 3b: this Retry saves, so its tooltip is the save's own failure
        // (short: the button is the retry), never another action's.
        ? <button type="button" className="project-workspace-controls__retry" title={saveError ? shortLine(saveError) : 'Retry saving'}
            onClick={() => void useProjectStore.getState().retrySave()}>Save failed · Retry</button>
        : <span className={`project-workspace-controls__status${status === 'saved' ? ' project-workspace-controls__status--settled' : ''}`}
            role="status">{label}</span>}
      <span className="project-workspace-controls__count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>
    </div>
  );
}
