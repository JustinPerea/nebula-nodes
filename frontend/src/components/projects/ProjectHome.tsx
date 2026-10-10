import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { CrabMark } from '../brand/CrabMark';
import '../../styles/project-home.css';

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  nodeCount: number;
  edgeCount: number;
  thumbnail: string | null;
}

export interface ProjectHomeProps {
  projects: ProjectSummary[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (name?: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRetry: () => void;
}

const monochromeMark = [
  { t: 0, rgb: [235, 236, 235] as [number, number, number] },
  { t: 1, rgb: [105, 107, 106] as [number, number, number] },
];

function NodeGraphPlaceholder() {
  return (
    <svg className="project-home__graph" viewBox="0 0 320 180" aria-hidden="true">
      <path className="project-home__graph-edge" d="M108 90C148 90 130 60 170 60M108 90C148 90 130 129 170 129" />
      <rect className="project-home__graph-node" x="36" y="61" width="72" height="58" rx="10" />
      <rect className="project-home__graph-node" x="170" y="32" width="108" height="56" rx="10" />
      <rect className="project-home__graph-node" x="170" y="106" width="78" height="46" rx="10" />
      <path className="project-home__graph-detail" d="M48 78H91M48 86H81M182 50H240M182 58H216M182 121H232M182 129H212" />
      <circle className="project-home__graph-port" cx="108" cy="90" r="3" />
      <circle className="project-home__graph-port" cx="170" cy="60" r="3" />
      <circle className="project-home__graph-port" cx="170" cy="129" r="3" />
    </svg>
  );
}

function ProjectPreview({ thumbnail }: { thumbnail: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`project-home__preview${thumbnail && !failed ? ' project-home__preview--image' : ''}`}>
      {thumbnail && !failed ? (
        <img src={backendAssetUrlSync(thumbnail)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : <NodeGraphPlaceholder />}
      <span className="project-home__preview-open"><ArrowUpRight aria-hidden="true" /></span>
    </div>
  );
}

function editedDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Saved project';
  return `Edited ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)}`;
}

function recentTimestamp(project: ProjectSummary) {
  const opened = Date.parse(project.lastOpenedAt ?? '');
  if (Number.isFinite(opened)) return opened;
  const updated = Date.parse(project.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}

function ProjectCard({ project, busy, onOpen, onRename, onDelete }: Pick<ProjectHomeProps, 'busy' | 'onOpen' | 'onRename' | 'onDelete'> & { project: ProjectSummary }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(project.name);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const trimmed = name.trim();

  const closeDeleteConfirm = () => {
    setConfirmingDelete(false);
    requestAnimationFrame(() => deleteButton.current?.focus());
  };

  const finishRename = () => {
    setEditing(false);
    requestAnimationFrame(() => renameButton.current?.focus());
  };

  return (
    <article className="project-home__card" aria-label={project.name}>
      <button type="button" className="project-home__open" disabled={busy || editing || confirmingDelete} onClick={() => onOpen(project.id)} aria-label={`Open ${project.name}`}>
        <ProjectPreview key={project.thumbnail ?? 'placeholder'} thumbnail={project.thumbnail} />
        <span className="project-home__card-name">{project.name}</span>
        <span className="project-home__card-date">{editedDate(project.updatedAt)}</span>
      </button>
      <div className="project-home__card-footer">
        <span><span>{project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true"> · </span><span>{project.edgeCount} {project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>
        <span className="project-home__card-actions">
          <button type="button" className="project-home__rename" ref={renameButton} aria-label={`Rename ${project.name}`} aria-expanded={editing} disabled={busy} onClick={() => {
            if (editing) finishRename();
            else { setConfirmingDelete(false); setName(project.name); setEditing(true); }
          }}><Pencil aria-hidden="true" /></button>
          <button type="button" className="project-home__rename project-home__delete" ref={deleteButton} aria-label={`Delete ${project.name}`} aria-expanded={confirmingDelete} disabled={busy} onClick={() => {
            if (confirmingDelete) closeDeleteConfirm();
            else { setEditing(false); setConfirmingDelete(true); }
          }}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
      {confirmingDelete && (
        <div className="project-home__delete-confirm" role="group" aria-label={`Delete ${project.name}`} onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); closeDeleteConfirm(); }
        }}>
          <p>Delete this project? Its canvas can’t be restored. Generated files stay in your outputs folder.</p>
          <div className="project-home__delete-actions">
            <button type="button" autoFocus disabled={busy} onClick={closeDeleteConfirm}>Cancel</button>
            <button type="button" className="project-home__delete-confirm-button" disabled={busy} onClick={() => {
              setConfirmingDelete(false);
              onDelete(project.id);
            }}>Delete project</button>
          </div>
        </div>
      )}
      {editing && (
        <form className="project-home__rename-form" aria-label={`Rename ${project.name}`} onSubmit={(event) => {
          event.preventDefault();
          if (busy || !trimmed || trimmed === project.name) return;
          onRename(project.id, trimmed);
          finishRename();
        }} onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); finishRename(); }
        }}>
          <label htmlFor={`project-name-${project.id}`} className="project-home__sr-only">Project name</label>
          <input id={`project-name-${project.id}`} autoFocus maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <button type="submit" aria-label="Save project name" disabled={busy || !trimmed || trimmed === project.name}><Check aria-hidden="true" /></button>
          <button type="button" aria-label="Cancel rename" disabled={busy} onClick={finishRename}><X aria-hidden="true" /></button>
        </form>
      )}
    </article>
  );
}

export function ProjectHome({ projects, loading, busy, error, onCreate, onOpen, onRename, onDelete, onRetry }: ProjectHomeProps) {
  const [query, setQuery] = useState('');
  const visibleProjects = useMemo(() => projects
    .filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => recentTimestamp(right) - recentTimestamp(left)), [projects, query]);

  return (
    <div className="project-home">
      <header className="project-home__header">
        <div className="project-home__brand"><CrabMark size={34} palette={monochromeMark} /><span>Nebula Nodes</span></div>
        <span className="project-home__location">Projects</span>
      </header>
      <main className="project-home__main" aria-busy={loading || busy}>
        <section className="project-home__welcome" aria-labelledby="project-home-title">
          <div><p className="project-home__eyebrow">Your workspace</p><h1 id="project-home-title">A place for your next idea.</h1><p className="project-home__intro">Start a new canvas or pick up where you left off.</p></div>
          <button className="project-home__new" type="button" disabled={loading || busy} onClick={() => onCreate()}><Plus aria-hidden="true" />New project</button>
        </section>

        {error && <div className="project-home__error" role="alert"><span>{error}</span><button type="button" disabled={loading || busy} onClick={onRetry}>Try again</button></div>}

        <section className="project-home__projects" aria-labelledby="recent-projects-title">
          <div className="project-home__section-header">
            <h2 id="recent-projects-title">Recent projects{projects.length > 0 && <span className="project-home__count" aria-hidden="true">{projects.length}</span>}</h2>
            {projects.length > 0 && <div className="project-home__search"><Search aria-hidden="true" /><label className="project-home__sr-only" htmlFor="project-home-search">Search projects</label><input id="project-home-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></div>}
          </div>
          {loading ? <div className="project-home__loading" role="status"><span className="project-home__loading-dot" />Loading your projects…</div>
            : visibleProjects.length > 0 ? <div className="project-home__grid">{visibleProjects.map((project) => <ProjectCard key={project.id} project={project} busy={busy} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />)}</div>
              : projects.length > 0 ? <div className="project-home__empty" role="status"><Search className="project-home__empty-search" aria-hidden="true" /><h3>No projects match “{query.trim()}”</h3><p>Try another name or clear your search.</p><button type="button" className="project-home__secondary" onClick={() => setQuery('')}>Clear search</button></div>
                : !error && <div className="project-home__empty"><div className="project-home__empty-graph"><NodeGraphPlaceholder /></div><h3>Your first project starts here.</h3><p>Connect ideas, models and media on a canvas of your own.</p><button type="button" className="project-home__secondary" disabled={busy} onClick={() => onCreate()}><Plus aria-hidden="true" />Create your first project</button></div>}
        </section>
      </main>
    </div>
  );
}
