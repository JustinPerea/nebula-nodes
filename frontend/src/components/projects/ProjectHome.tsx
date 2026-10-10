import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
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

export interface TrashedProject extends ProjectSummary {
  deletedAt: string;
  purgeAt: string;
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
  trash?: TrashedProject[];
  lastDeleted?: { id: string; name: string } | null;
  onRestore?: (id: string) => void;
  onPurge?: (id: string) => void;
  onEmptyTrash?: () => void;
  onDismissUndo?: () => void;
}

const UNDO_VISIBLE_MS = 8000;

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
  const [name, setName] = useState(project.name);
  const renameButton = useRef<HTMLButtonElement>(null);
  const trimmed = name.trim();

  const finishRename = () => {
    setEditing(false);
    requestAnimationFrame(() => renameButton.current?.focus());
  };

  return (
    <article className="project-home__card" aria-label={project.name}>
      <button type="button" className="project-home__open" disabled={busy || editing} onClick={() => onOpen(project.id)} aria-label={`Open ${project.name}`}>
        <ProjectPreview key={project.thumbnail ?? 'placeholder'} thumbnail={project.thumbnail} />
        <span className="project-home__card-name">{project.name}</span>
        <span className="project-home__card-date">{editedDate(project.updatedAt)}</span>
      </button>
      <div className="project-home__card-footer">
        <span><span>{project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true"> · </span><span>{project.edgeCount} {project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>
        <span className="project-home__card-actions">
          <button type="button" className="project-home__rename" ref={renameButton} aria-label={`Rename ${project.name}`} aria-expanded={editing} disabled={busy} onClick={() => {
            if (editing) finishRename();
            else { setName(project.name); setEditing(true); }
          }}><Pencil aria-hidden="true" /></button>
          <button type="button" className="project-home__rename project-home__delete" aria-label={`Delete ${project.name}`}
            title="Move to Recently deleted" disabled={busy || editing} onClick={() => onDelete(project.id)}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
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

function daysLeft(purgeAt: string, now: number): number {
  const remaining = Date.parse(purgeAt) - now;
  return Number.isFinite(remaining) ? Math.max(0, Math.ceil(remaining / 86_400_000)) : 0;
}

function removalNote(purgeAt: string, now: number): string {
  const days = daysLeft(purgeAt, now);
  return days <= 1 ? 'Removed for good within a day' : `Removed for good in ${days} days`;
}

function deletedDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Deleted ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}`
    : 'Deleted';
}

/** Two-step button for the irreversible actions: first press arms, second confirms. */
function ConfirmInline({ label, confirmLabel, prompt, busy, onConfirm, className }: {
  label: string; confirmLabel: string; prompt: string; busy: boolean; onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    return <button type="button" ref={trigger} className={className} disabled={busy} onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="project-home__confirm" role="group" aria-label={prompt} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); disarm(); }
    }}>
      <span className="project-home__confirm-prompt">{prompt}</span>
      <button type="button" autoFocus disabled={busy} onClick={disarm}>Cancel</button>
      <button type="button" className="project-home__danger" disabled={busy} onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
    </span>
  );
}

function RecentlyDeleted({ trash, busy, onRestore, onPurge, onEmptyTrash }: {
  trash: TrashedProject[]; busy: boolean;
  onRestore: (id: string) => void; onPurge: (id: string) => void; onEmptyTrash: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Read the clock when the list opens, not on every render.
  const [now, setNow] = useState(() => Date.now());
  return (
    <section className="project-home__trash" aria-labelledby="recently-deleted-title">
      <div className="project-home__trash-header">
        <h2 id="recently-deleted-title">
          <button type="button" className="project-home__trash-toggle" aria-expanded={open} aria-controls="recently-deleted-list" onClick={() => {
            if (!open) setNow(Date.now());
            setOpen(!open);
          }}>
            <ChevronRight aria-hidden="true" />Recently deleted<span className="project-home__count" aria-hidden="true">{trash.length}</span>
            <span className="project-home__sr-only">, {trash.length} {trash.length === 1 ? 'project' : 'projects'}</span>
          </button>
        </h2>
        {open && <ConfirmInline label="Empty" confirmLabel="Delete all" prompt={`Delete ${trash.length === 1 ? 'this project' : `all ${trash.length} projects`} for good?`}
          busy={busy} onConfirm={onEmptyTrash} className="project-home__trash-empty" />}
      </div>
      {open && (
        <div id="recently-deleted-list">
          <p className="project-home__trash-note">Deleted projects stay here for 30 days. Generated files stay in your outputs folder either way.</p>
          <ul className="project-home__trash-list">
            {trash.map((entry) => (
              <li key={entry.id} className="project-home__trash-row" aria-label={entry.name}>
                <span className="project-home__trash-name">{entry.name}</span>
                <span className="project-home__trash-meta">{deletedDate(entry.deletedAt)} · {removalNote(entry.purgeAt, now)}</span>
                <span className="project-home__trash-actions">
                  <button type="button" disabled={busy} aria-label={`Restore ${entry.name}`} onClick={() => onRestore(entry.id)}><RotateCcw aria-hidden="true" />Restore</button>
                  <ConfirmInline label="Delete forever" confirmLabel="Delete forever" prompt="This can’t be undone." busy={busy}
                    onConfirm={() => onPurge(entry.id)} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function UndoToast({ project, busy, onUndo, onDismiss }: {
  project: { id: string; name: string }; busy: boolean; onUndo: () => void; onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, onDismiss, project.id]);
  return (
    <div className="project-home__toast" role="status" aria-live="polite"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="project-home__toast-text">Moved “{project.name}” to Recently deleted</span>
      <button type="button" className="project-home__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
      <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  );
}

const noop = () => {};

export function ProjectHome({ projects, loading, busy, error, onCreate, onOpen, onRename, onDelete, onRetry,
  trash = [], lastDeleted = null, onRestore = noop, onPurge = noop, onEmptyTrash = noop, onDismissUndo = noop }: ProjectHomeProps) {
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
        {!loading && trash.length > 0 && <RecentlyDeleted trash={trash} busy={busy} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} />}
      </main>
      {lastDeleted && <UndoToast key={lastDeleted.id} project={lastDeleted} busy={busy}
        onUndo={() => onRestore(lastDeleted.id)} onDismiss={onDismissUndo} />}
    </div>
  );
}
