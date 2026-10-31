import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowUpRight, Check, ChevronRight, ImageIcon, Pencil, Plus, RotateCcw, Search, Settings, Trash2, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { coverImages, type CatalogRestore, type CoverChoices, type ProjectCover, type SavedCanvas } from '../../lib/projects';
import { DEFAULT_PROJECT_LIMIT, editsRecoveredToast, filedCopyLine, OPEN_RECENTLY_DELETED, restoreCopyFallback, SAVE_AS_A_PROJECT } from './restoreCopyCore';
import type { CanvasLimit, CanvasLimitContext, NoticeNow } from './catalogRestoreCopy';
import { useRestoreCopyState, type RestoreCopy } from './restoreCopyLoader';
import { actorLabel } from '../../lib/trash';
import { removalNote } from './trashDays';
import { CrabMark } from '../brand/CrabMark';
import { ProposalsFor } from '../proposals/ProposalsFor';
import { UpdatesSlot } from '../agent-notes/UpdatesSlot';
import { InNoticeRegion } from '../InNoticeRegion';
import { failureMessage, shortLine } from '../../lib/errorCopy';
import { ErrorDetails } from '../failure/ErrorDetails';
import { UnsavedEditsNotice } from './UnsavedEditsNotice';
import { editsSavedLine } from './unsavedEditsCopy';
import type { SavedEditsFile } from '../../lib/graphFileShared';
import '../../styles/project-home.css';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import { useKeptCanvas } from '../../lib/keptCanvas';
import { NoticeLeave, type LeaveProps } from '../../lib/noticeLeave';

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  nodeCount: number;
  edgeCount: number;
  thumbnail: string | null;
  /** Missing from a backend older than covers; then `thumbnail` is used. */
  cover?: ProjectCover | null;
  /** Who pinned the cover; none on a pin from before it was recorded (the person's). */
  coverBy?: { kind: string; name: string };
  /** A pin whose image left the project (Q90 a): it no longer counts, and the cover is automatic. */
  coverLostPin?: { url: string; by: { kind: string; name: string } | null };
  createdBy?: { kind: 'agent'; name: string };
}

export interface TrashedProject extends ProjectSummary {
  deletedAt: string;
  purgeAt: string;
  /** Who deleted it: you, an agent by name, or an unnamed client. Missing on older entries. */
  deletedBy?: { kind: string; name: string };
}

export interface ProjectHomeProps {
  projects: ProjectSummary[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  /** The text behind `error`'s collapsed Details toggle: a person-only
   * refusal's own words, written for agents (GM, Q116 a). */
  errorDetails?: string | null;
  onCreate: (name?: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRetry: () => void;
  /** What Try again does for `error` (error copy round 3b, store/projectStore
   * projectRetryOffer): 'redo' redoes the failure (the reason is GM's short
   * line), 'reload' only reloads the saved projects (the whole line stays),
   * 'save' is [Save as a project] (GM r12 on PR #199, 1: the edits a
   * restore stopped, kept in this tab; the whole line), and
   * 'none' hides Try again (the whole line). */
  retry?: 'redo' | 'reload' | 'save' | 'none' | 'reloadNebula';
  /** GM r12 item 5: where an update's recovered copy went, when the reload
   * couldn't open it (store/projectStore CopyNotice): neutral, × to close,
   * [Restore] while it is in Recently deleted. */
  copyNotice?: { line: string; restore: { id: string; name: string } | null; open?: { id: string; name: string } | null } | null;
  onRestoreCopy?: () => void;
  onDismissCopy?: () => void;
  /** GM #198 r22 Q2: [Open] on the notice saying where a stale tab's edits
   * were saved (a recovered project); opens it. */
  onOpenCopy?: () => void;
  trash?: TrashedProject[];
  /** The project the person just moved to Recently deleted (the Undo
   * toast). Its Undo may pass the project limit (Justin, 2026-10-29), so it
   * is never refused by it. */
  lastDeleted?: { id: string; name: string } | null;
  /** `from` 'undo' when the Undo toast's button asked. */
  onRestore?: (id: string, from?: 'undo') => void;
  onPurge?: (id: string) => void;
  onEmptyTrash?: () => void;
  onDismissUndo?: () => void;
  /** A stale tab's unsaved edits Nebula refused for good (Q116 a): GM's
   * "Couldn’t save your edits." with this reason, in place of the error line
   * and its Try again, until the person downloads them or continues without. */
  unsavedEdits?: { reason: string; downloadFailed?: boolean; downloadTooBig?: boolean; keptIn?: string; agentOpening?: { agent: string; projectName: string } } | null;
  /** The file the held edits were downloaded as, for GM's line after it, and
   * whether Load graph can open it. */
  editsSavedAs?: SavedEditsFile | null;
  onDownloadEdits?: () => void;
  onContinueWithoutEdits?: () => void;
  /** Settings (API keys included) opens from home too, so a first run needn't start a project to add keys. */
  settingsOpen?: boolean;
  onToggleSettings?: () => void;
  /** Cover picker: the project's images, and pinning one (null = automatic). */
  loadCoverChoices?: (id: string) => Promise<CoverChoices>;
  onPinCover?: (id: string, url: string | null) => void;
  /** Nebula restored a damaged project list: GM's line (catalogRestoreCopy),
   * shown until the person closes it with ×. */
  catalogRestore?: CatalogRestore | null;
  /** How many projects the list may hold (the listing's `projectLimit`): the
   * restore notice's left-out line names it (GM r18 on PR #199, Q5). */
  projectLimit?: number;
  onDismissCatalogRestore?: () => void;
  /** The live canvas isn't a project and the list had no room to save it
   * (the listing's `canvasNotFiled`): GM r5's waiting line, until it is saved. */
  canvasNotFiled?: { reason: CanvasLimit; projectLimit?: number; canvases?: CanvasLimitContext['canvases']; deletes?: number | null } | null;
  /** A waiting canvas was saved as this project (the listing's `canvasSaved`):
   * GM's toast, once per tab, naming each canvas filed with it (`filed`). */
  canvasSaved?: { id: string; name: string; overSaveLimit?: boolean; another?: boolean; agentCopy?: { agent?: string | null };
    filed?: SavedCanvas[] } | null;
  /** The project [Save as a project] saved this tab's edits as (GM r12 on
   * PR #199, 1): its toast names it. */
  editsRecoveredAs?: { id: string; name: string; dropped?: string } | null;
  onDismissEditsRecovered?: () => void;
  /** GM r14 on PR #199, 3: the line for a tab sent home after an agent's
   * write closed its project ("Codex cleared the canvas. “X” is kept as its
   * own project."), so it never goes home silently. */
  agentClosedNote?: { id: string; text: string } | null;
  onDismissAgentClosedNote?: () => void;
  /** Held canvases canvas-held.json couldn't read (review 6, L-1). */
  canvasHeldUnreadable?: { count: number | null } | null;
  /** Its × (GM r9: a one-time report, closed like the restore notice). */
  onDismissCanvasHeldUnreadable?: () => void;
  onDismissCanvasSaved?: () => void;
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

function ProjectPreview({ project }: { project: Pick<ProjectSummary, 'cover' | 'thumbnail'> }) {
  const [failed, setFailed] = useState<string[]>([]);
  const { images, mosaic } = coverImages(project);
  const shown = images.filter((url) => !failed.includes(url));
  const fail = (url: string) => setFailed((current) => [...current, url]);
  return (
    <div className={`project-home__preview${shown.length ? ' project-home__preview--image' : ''}`}>
      {shown.length === 0 ? <NodeGraphPlaceholder /> : mosaic && shown.length > 1 ? (
        <div className={`project-home__mosaic project-home__mosaic--${shown.length}`} data-testid="project-cover-mosaic">
          {shown.map((url) => <img key={url} src={backendAssetUrlSync(url)} alt="" loading="lazy" onError={() => fail(url)} />)}
        </div>
      ) : <img src={backendAssetUrlSync(shown[0])} alt="" loading="lazy" onError={() => fail(shown[0])} />}
      <span className="project-home__preview-open"><ArrowUpRight aria-hidden="true" /></span>
    </div>
  );
}

/** Pick the card's picture from the project's own images (the person only;
 * the backend refuses agents), or go back to automatic. */
function CoverPicker({ project, busy, load, onPin, onClose }: {
  project: ProjectSummary; busy: boolean; load: (id: string) => Promise<CoverChoices>;
  onPin: (url: string | null) => void; onClose: () => void;
}) {
  const [choices, setChoices] = useState<CoverChoices | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load(project.id).then((found) => { if (live) setChoices(found); })
      .catch((error: unknown) => { if (live) setFailed(failureMessage(error, "Couldn't load the cover choices.")); });
    return () => { live = false; };
  }, [load, project.id]);
  const pinned = choices?.pinned ?? null;
  // An agent's pick says so; yours stays plain "Cover".
  const setBy = pinned && choices?.pinnedBy && choices.pinnedBy.kind !== 'person' ? actorLabel(choices.pinnedBy) : null;
  return (
    <div className="project-home__cover-picker" role="group" aria-label={`Cover for ${project.name}`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
      <div className="project-home__cover-picker-head">
        <span>{setBy ? `Cover · set by ${setBy}` : 'Cover'}</span>
        <button type="button" className="project-home__cover-auto" aria-pressed={!pinned} disabled={busy || !choices}
          onClick={() => { onPin(null); onClose(); }}>Automatic</button>
        <button type="button" className="project-home__cover-close" aria-label="Close cover picker" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      {choices?.lostPin && <p className="project-home__cover-note">
        {choices.lostPin.by?.kind === 'person' ? 'The image you pinned' : 'The pinned image'} is no longer in this project, so the cover is automatic.</p>}
      {failed ? <p className="project-home__cover-note">{failed}</p>
        : !choices ? <p className="project-home__cover-note">Loading images…</p>
          : choices.images.length === 0 ? <p className="project-home__cover-note">No images in this project yet.</p>
            : (
              <div className="project-home__cover-grid">
                {choices.images.map((choice) => (
                  <button key={choice.url} type="button" className="project-home__cover-choice" aria-pressed={pinned === choice.url}
                    aria-label={`Use this ${choice.kind === 'reference' ? 'reference' : 'image'} as the cover`} disabled={busy}
                    onClick={() => { onPin(choice.url); onClose(); }}>
                    <img src={backendAssetUrlSync(choice.url)} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
    </div>
  );
}

function coverTitle(project: ProjectSummary): string {
  if (project.cover?.source !== 'pinned') return 'Choose cover';
  return project.coverBy && project.coverBy.kind !== 'person' ? `Cover: set by ${actorLabel(project.coverBy)}` : 'Cover: pinned';
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

function ProjectCard({ project, busy, offline = false, onOpen, onRename, onDelete, loadCoverChoices, onPinCover }: Pick<ProjectHomeProps, 'busy' | 'onOpen' | 'onRename' | 'onDelete' | 'loadCoverChoices' | 'onPinCover'> & { project: ProjectSummary; offline?: boolean }) {
  // GM r18: the icons disabled offline carry the offline mark (the
  // not-allowed cursor, and a press pulses the banner).
  const off = offlineMark(offline);
  const [editing, setEditing] = useState(false);
  const [choosingCover, setChoosingCover] = useState(false);
  const coverButton = useRef<HTMLButtonElement>(null);
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
        <ProjectPreview key={coverImages(project).images.join('|') || 'placeholder'} project={project} />
        <span className="project-home__card-name">{project.name}</span>
        <span className="project-home__card-date">{editedDate(project.updatedAt)}{project.createdBy ? ` · Made by ${project.createdBy.name}` : ''}</span>
      </button>
      <div className="project-home__card-footer">
        <span><span>{project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true"> · </span><span>{project.edgeCount} {project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>
        <span className="project-home__card-actions">
          {loadCoverChoices && onPinCover && (
            <button type="button" className="project-home__rename" ref={coverButton} aria-label={`Choose a cover for ${project.name}`}
              title={coverTitle(project)} aria-expanded={choosingCover}
              disabled={busy || editing} {...off} onClick={() => setChoosingCover(!choosingCover)}><ImageIcon aria-hidden="true" /></button>
          )}
          <button type="button" className="project-home__rename" ref={renameButton} aria-label={`Rename ${project.name}`} aria-expanded={editing} disabled={busy} {...off} onClick={() => {
            if (editing) finishRename();
            else { setName(project.name); setEditing(true); }
          }}><Pencil aria-hidden="true" /></button>
          <button type="button" className="project-home__rename project-home__delete" aria-label={`Delete ${project.name}`}
            title="Move to Recently deleted" disabled={busy || editing} {...off} onClick={() => onDelete(project.id)}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
      {/* An agent asking to change the cover the person pinned (Q60 a). */}
      <ProposalsFor kind="project" targetId={project.id} />
      {choosingCover && loadCoverChoices && onPinCover && (
        <CoverPicker project={project} busy={busy} load={loadCoverChoices} onPin={(url) => onPinCover(project.id, url)}
          onClose={() => { setChoosingCover(false); requestAnimationFrame(() => coverButton.current?.focus()); }} />
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

function deletedDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Deleted ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)}`
    : 'Deleted';
}

function deletedByNote(entry: TrashedProject): string {
  const by = entry.deletedBy;
  if (!by || by.kind === 'person') return '';
  return ` by ${actorLabel(by)}`;
}

/** Two-step button for the irreversible actions: first press arms, second confirms. */
function ConfirmInline({ label, confirmLabel, prompt, busy, onConfirm, className }: {
  label: string; confirmLabel: string; prompt: string; busy: boolean; onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    // It arms a Delete forever or an Empty: red on hover (GM r13), neutral at rest.
    return <button type="button" ref={trigger} className={[className, 'project-home__trigger--danger'].filter(Boolean).join(' ')} disabled={busy}
      onClick={() => setArmed(true)}>{label}</button>;
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

function RecentlyDeleted({ trash, busy, onRestore, onPurge, onEmptyTrash, openRequest = 0, onOpened = noop, fromNotice = [] }: {
  trash: TrashedProject[]; busy: boolean;
  /** The restore notice's items it opened the list to (GM r4): marked, and
   * the first scrolled into view. */
  fromNotice?: string[];
  onRestore: (id: string) => void; onPurge: (id: string) => void; onEmptyTrash: () => void;
  /** When the person last asked the list open (the restore notice's
   * "Open Recently deleted"), as the clock at that click; 0 for none. A new
   * value opens the list and moves focus to it, then `onOpened` clears it,
   * so the list coming back later (an agent deletes a project after the
   * trash emptied) never reopens it or takes focus (review 2 of PR #199, L6). */
  openRequest?: number;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Read the clock when the list opens, not on every render.
  const [openedAt, setNow] = useState(() => Date.now());
  // A project deleted while the list is open was deleted after the clock was
  // read: the clock is at least the newest delete (GM r7, bug 2).
  const now = Math.max(openedAt, ...trash.map((entry) => Date.parse(entry.deletedAt)).filter(Number.isFinite));
  const toggle = useRef<HTMLButtonElement>(null);
  // A new request opens the list in this render (React's "adjust state when
  // a prop changes"), so the effect below only moves focus.
  const [seenRequest, setSeenRequest] = useState(0);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest) { setNow(openRequest); setOpen(true); }
  }
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!openRequest) return;
    toggle.current?.focus();
    toggle.current?.scrollIntoView?.({ block: 'nearest' });
    // "Opens to those" (GM r4): the notice's first item in view, focus kept on the toggle.
    list.current?.querySelector<HTMLElement>('[data-from-notice="true"]')?.scrollIntoView?.({ block: 'nearest' });
    onOpened();
  }, [openRequest, onOpened]);
  return (
    <section className="project-home__trash" aria-labelledby="recently-deleted-title">
      <div className="project-home__trash-header">
        <h2 id="recently-deleted-title">
          <button ref={toggle} type="button" className="project-home__trash-toggle" aria-expanded={open} aria-controls="recently-deleted-list" onClick={() => {
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
          <ul className="project-home__trash-list" ref={list}>
            {trash.map((entry) => (
              <li key={entry.id} className="project-home__trash-row" aria-label={entry.name}
                data-from-notice={fromNotice.includes(entry.id) ? 'true' : undefined}>
                <span className="project-home__trash-name">{entry.name}</span>
                <span className="project-home__trash-meta">{deletedDate(entry.deletedAt)}{deletedByNote(entry)} · {removalNote(entry.deletedAt, entry.purgeAt, now)}</span>
                <span className="project-home__trash-actions">
                  {/* A restore may pass the project limit (Justin, 2026-10-29): never greyed by it. */}
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

function UndoToast({ project, busy, onUndo, onDismiss, leave }: {
  project: { id: string; name: string }; busy: boolean; onUndo: () => void; onDismiss: () => void; leave?: LeaveProps;
}) {
  // Held while pointed at or focused, as the app's other toasts.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, onDismiss]);
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="project-home">
      <div className="project-home__toast" role="status" aria-live="polite" {...leave}
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="project-home__toast-text">Moved “{project.name}” to Recently deleted</span>
        <button type="button" className="project-home__toast-undo" disabled={busy} onClick={onUndo}>Undo</button>
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}

/** GM r12 item 5, r14 item 1: the recovered copy's notice. Not a toast: the
 * inline notice at the top of Projects home, first in the notice stack.
 * Neutral, the line, [Restore] while the copy is in Recently deleted, and ×;
 * it stays until the person closes it or restores. */
function CopyNotice({ notice, busy, onRestore, onOpen, onDismiss }: {
  notice: { line: string; restore: { id: string; name: string } | null; open?: { id: string; name: string } | null };
  busy: boolean; onRestore: () => void; onOpen: () => void; onDismiss: () => void;
}) {
  return (
    <div className="project-home__notice project-home__notice--copy" role="status" data-copy-notice="">
      <span className="project-home__notice-text">{notice.line}</span>
      <span className="project-home__notice-actions">
        {notice.restore && <button type="button" className="project-home__notice-restore" disabled={busy} onClick={onRestore}>Restore</button>}
        {notice.open && <button type="button" className="project-home__notice-restore" disabled={busy} onClick={onOpen}>Open</button>}
        <button type="button" className="project-home__notice-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </span>
    </div>
  );
}

const noop = () => {};

/** The notice after Nebula restored a damaged project list (GM's lines,
 * catalogRestoreCopy). Its status region is in the page from the start and
 * filled after it mounts, so screen readers announce it (a live region
 * reads changes, not what it held when it appeared: review 1 of PR #199,
 * L8). × closes it, and focus follows the notice stack's rule (PR #200 GM
 * r16; review 13 of PR #199, MEDIUM-1): the notice now in its place, else
 * "Recent projects". */
function CatalogRestoreNotice({ copy, copyFailed = false, restore, current, heldUnreadable = null, onDismiss, onOpenRecentlyDeleted }: {
  /** The restore copy, once loaded (restoreCopyLoader): empty until then. */
  copy: RestoreCopy | null;
  /** Its chunk failed to load (it is tried again at the next focus or
   * reconnect): the notice says RESTORE_COPY_FALLBACK meanwhile, or, while
   * this tab keeps edits, GM r23's full sentence (restoreCopyFallback). */
  copyFailed?: boolean;
  restore: CatalogRestore | null; current: NoticeNow; onDismiss: () => void;
  /** GM r9: held canvases that couldn't be read, merged in as one more line. */
  heldUnreadable?: { count: number | null } | null;
  onOpenRecentlyDeleted: (ids: string[]) => void;
}) {
  // Filled once the region is in the page: the callback ref runs after it
  // is attached, and the content follows in the next render.
  const [ready, setReady] = useState(false);
  const attached = useCallback((region: HTMLDivElement | null) => { if (region) setReady(true); }, []);
  // Only the lines that still hold against the list now (GM r4), so a
  // restore or delete by the person or an agent updates it as it lands.
  const notice = ready && restore && copy ? copy.catalogRestoreNotice(restore, undefined, current, { heldUnreadable }) : null;
  // GM r23 (3) on PR #199: the short fallback only when nothing is kept.
  const kept = useKeptCanvas();
  return (
    // A polite live region rather than role="status": the page keeps one
    // status per notice it shows (the loading line, the saved-file line),
    // and this empty region stays in the page the whole time.
    <div ref={attached} className={notice || (ready && restore && copyFailed) ? 'project-home__notice project-home__restore' : 'project-home__sr-only'} aria-live="polite" aria-atomic="true">
      {!notice && ready && restore && copyFailed && <>
        <span className="project-home__restore-text" data-restore-fallback="">{restoreCopyFallback(kept)}</span>
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </>}
      {notice && <>
        {/* GM r3's B layout: more than one outcome, one per line (no bullets). */}
        {notice.lines
          ? <div className="project-home__restore-text project-home__restore-lines">{notice.lines.map((line) => <p key={line}>{line}</p>)}</div>
          : <span className="project-home__restore-text">{notice.text}</span>}
        {/* Only while Recently deleted holds one of the notice's items (GM r4; L6). */}
        {notice.openRecentlyDeleted && current.trash.length > 0 && <button type="button" className="project-home__restore-action project-home__restore-action--neutral"
          onClick={() => onOpenRecentlyDeleted(notice.recentlyDeletedIds)}>{OPEN_RECENTLY_DELETED}</button>}
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </>}
    </div>
  );
}

/** GM r9: the held canvases that couldn't be read, when no restore notice
 * shows to say it: its own notice, styled like the restore notice, closed
 * with × (a one-time report; only the waiting line has no ×). */
function CanvasHeldUnreadableNotice({ copy, count, onDismiss }: { copy: RestoreCopy; count: number | null; onDismiss: () => void }) {
  return (
    <div className="project-home__notice project-home__restore" role="status">
      <span className="project-home__restore-text">{copy.canvasHeldUnreadableLine(count)}</span>
      <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  );
}

/** GM r5's waiting line (r6's wording): the canvas isn't saved as a
 * project yet, the list is at a limit, nothing in it is lost. A slim notice where the restore notice sits; it
 * can't be dismissed while the canvas waits and goes once it is saved. The
 * size cap's adds "Open Recently deleted" (only a delete for good frees it). */
function CanvasWaitingNotice({ copy, waiting, trashCount, onOpenRecentlyDeleted }: {
  copy: RestoreCopy;
  waiting: { reason: CanvasLimit; projectLimit?: number; canvases?: CanvasLimitContext['canvases']; deletes?: number | null }; trashCount: number;
  onOpenRecentlyDeleted: () => void;
}) {
  const line = copy.canvasWaitingLine(waiting.reason, {
    projectLimit: waiting.projectLimit ?? DEFAULT_PROJECT_LIMIT, trashHasItems: trashCount > 0, canvases: waiting.canvases,
    deletes: waiting.deletes,
  });
  return (
    // No ×: the stack's focus rule can land on it, so it takes focus itself.
    <div className="project-home__notice project-home__restore project-home__waiting" role="status" tabIndex={-1}>
      <span className="project-home__restore-text">{line}</span>
      {waiting.reason === 'storage' && trashCount > 0 && <button type="button" className="project-home__restore-action project-home__restore-action--neutral"
        onClick={onOpenRecentlyDeleted}>{OPEN_RECENTLY_DELETED}</button>}
    </div>
  );
}

/** GM r5: "Once saved: the normal toast", with the project's real name. */
function CanvasSavedToast({ copy, project, onDismiss }: {
  copy: RestoreCopy;
  project: { id: string; name: string; overSaveLimit?: boolean; another?: boolean; agentCopy?: { agent?: string | null };
    filed?: SavedCanvas[] };
  onDismiss: () => void;
}) {
  return <SavedToast text={copy.canvasSavedToast(project.name, project.filed, project.overSaveLimit === true,
    project.another === true, project.agentCopy)} onDismiss={onDismiss} />;
}

/** The app's saved toast: it goes after UNDO_VISIBLE_MS, held while pointed
 * at or focused. Keyed by the caller on what it names. */
function SavedToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, onDismiss]);
  return (
    <InNoticeRegion slot="project-home">
      <div className="project-home__toast" role="status" aria-live="polite"
        onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        <span className="project-home__toast-text">{text}</span>
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}

/** Which notice in the stack focus was in, by its key, and the keys of the
 * stack as it was. React's focus events bubble through portals, so focus in
 * a notice's own dialog (the held edits' confirm) counts as in the notice. */
// Review 13 of PR #199 (MEDIUM-1): the restore notices above the stack
// follow its rule too, in page order: the restore notice, the waiting line,
// the held canvases that couldn't be read, then the stack.
type NoticeKey = 'restore' | 'waiting' | 'unreadable' | 'copy' | 'held' | 'saved' | 'error';

/** The notice stack's focus rule (GM pr200 r16 #2, which replaced GM r15's
 * "first control"): when a notice goes and takes focus with it, focus moves
 * to the notice now in its place (the next one), else the one before, onto
 * its × (Dismiss). Never onto a primary or destructive action (Restore,
 * Download, Try again, Run, Undo, Delete): a second Enter must not act. A
 * notice with no × (the held edits, the saved line, the error) takes focus
 * itself; with the stack empty, the "Recent projects" heading. Never the
 * body. Only when focus was lost: never from something the person moved to
 * meanwhile (Q116 a review). After the commit that removed the notice: no
 * frame to wait for (a frame never comes in a background tab). */
/** The × every dismissable notice carries (CopyNotice). */
const NOTICE_DISMISS = 'button.project-home__notice-close';
/** Any notice's × as the rule looks for it: the stack's, or the restore notices'. */
const ANY_NOTICE_DISMISS = `${NOTICE_DISMISS}:not(:disabled), button.project-home__toast-close:not(:disabled)`;

function useNoticeStackFocus(keys: NoticeKey[], stack: RefObject<HTMLElement | null>,
  fallback: RefObject<HTMLElement | null>) {
  const focused = useRef<NoticeKey | null>(null);
  const previous = useRef<NoticeKey[]>(keys);
  const joined = keys.join(' ');
  useEffect(() => {
    const before = previous.current;
    previous.current = keys;
    const was = focused.current;
    if (!was || keys.includes(was)) return;
    focused.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const index = before.indexOf(was);
    const notices = Array.from(stack.current?.querySelectorAll<HTMLElement>('[data-notice]') ?? []);
    const target = notices[Math.min(index, notices.length - 1)];
    if (!target) { fallback.current?.focus(); return; }
    // Its ×, else the notice itself by its tabindex: never one of its actions.
    const control = target.querySelector<HTMLElement>(ANY_NOTICE_DISMISS)
      ?? target.querySelector<HTMLElement>('[tabindex="-1"]');
    (control ?? fallback.current)?.focus();
    // keys is read through `joined`: a new array each render, the same stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, stack, fallback]);
  return {
    track: (key: NoticeKey) => ({
      'data-notice': key,
      onFocus: () => { focused.current = key; },
      onBlur: (event: { relatedTarget: EventTarget | null }) => {
        // Moving elsewhere forgets it; focus that goes with the element
        // (no related target) is what the rule above catches.
        if (event.relatedTarget) focused.current = null;
      },
    }),
  };
}

export function ProjectHome({ projects, loading, busy, error, errorDetails = null, onCreate, onOpen, onRename, onDelete, onRetry, retry = 'redo',
  trash = [], lastDeleted = null, onRestore = noop, onPurge = noop, onEmptyTrash = noop, onDismissUndo = noop,
  settingsOpen = false, onToggleSettings, loadCoverChoices, onPinCover,
  catalogRestore = null, onDismissCatalogRestore = noop, projectLimit,
  canvasNotFiled = null, canvasSaved = null, onDismissCanvasSaved = noop, editsRecoveredAs = null, onDismissEditsRecovered = noop,
  agentClosedNote = null, onDismissAgentClosedNote = noop,
  canvasHeldUnreadable = null, onDismissCanvasHeldUnreadable = noop,
  unsavedEdits = null, editsSavedAs = null, onDownloadEdits = noop, onContinueWithoutEdits = noop,
  copyNotice = null, onRestoreCopy = noop, onDismissCopy = noop, onOpenCopy = noop }: ProjectHomeProps) {
  const [query, setQuery] = useState('');
  // Offline is read-only (round 15 of PR #114): create, open, rename,
  // delete, restore and covers are disabled as while busy; search and
  // "Try again" (a read) still work.
  const offline = useBackendOffline();
  const locked = busy || offline;
  const stack = useRef<HTMLDivElement>(null);
  const recentHeading = useRef<HTMLHeadingElement>(null);
  const showError = !unsavedEdits && Boolean(error);
  const current = useMemo<NoticeNow>(() => ({ projects, trash, canvasNotFiled, projectLimit }), [projects, trash, canvasNotFiled, projectLimit]);
  // The waiting line, unless the restore notice already says the limit.
  // Review 13 of PR #199 (LOW-1): the restore copy loads when one of its
  // notices has something to say, not with the entry chunk.
  const { copy, failed: copyFailed } = useRestoreCopyState(Boolean(catalogRestore || canvasNotFiled || canvasHeldUnreadable || canvasSaved));
  const restoreSaysLimit = Boolean(catalogRestore && canvasNotFiled && copy
    && copy.catalogRestoreNotice(catalogRestore, undefined, current).canvasLine === 'limit');
  const showWaiting = Boolean(canvasNotFiled && copy) && !restoreSaysLimit;
  const showUnreadable = Boolean(canvasHeldUnreadable && copy) && !catalogRestore;
  const noticeKeys: NoticeKey[] = [
    ...(catalogRestore ? ['restore' as const] : []),
    ...(showWaiting ? ['waiting' as const] : []),
    ...(showUnreadable ? ['unreadable' as const] : []),
    ...(copyNotice ? ['copy' as const] : []),
    ...(unsavedEdits ? ['held' as const] : editsSavedAs ? ['saved' as const] : []),
    ...(showError ? ['error' as const] : []),
  ];
  const { track } = useNoticeStackFocus(noticeKeys, stack, recentHeading);
  // GM #198 r22 Q2: the notice saying where Try again saved the edits takes
  // the banner's place, and focus goes to its × (never [Open]), unless the
  // person had moved on to something else. While the projects loaded, the
  // stack rule may have parked focus on "Recent projects": that counts as
  // still the banner's.
  const savedAsCopy = copyNotice?.open ? copyNotice : null;
  useEffect(() => {
    if (!savedAsCopy) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && active !== recentHeading.current
      && !stack.current?.contains(active)) return;
    stack.current?.querySelector<HTMLElement>(`[data-notice="copy"] ${NOTICE_DISMISS}`)?.focus();
  }, [savedAsCopy]);
  const [trashOpenRequest, setTrashOpenRequest] = useState(0);
  const [trashFromNotice, setTrashFromNotice] = useState<string[]>([]);
  const trashOpened = useCallback(() => setTrashOpenRequest(0), []);
  const openTrash = useCallback((ids: string[] = []) => {
    setTrashFromNotice(ids);
    setTrashOpenRequest((last) => Math.max(Date.now(), last + 1));
  }, []);
  const visibleProjects = useMemo(() => projects
    .filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((left, right) => recentTimestamp(right) - recentTimestamp(left)), [projects, query]);

  return (
    <div className="project-home">
      <header className="project-home__header">
        <div className="project-home__brand"><CrabMark size={34} palette={monochromeMark} /><span>Nebula Nodes</span></div>
        <span className="project-home__location">Projects</span>
        {/* Room for the Updates chip beside Settings (Q107 a; layouts.css). */}
        <UpdatesSlot />
        {onToggleSettings && <button type="button" className="project-home__settings" aria-label="Settings"
          title="Settings and API keys" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={onToggleSettings}>
          <Settings aria-hidden="true" />
        </button>}
      </header>
      <main className="project-home__main" aria-busy={loading || busy}>
        <section className="project-home__welcome" aria-labelledby="project-home-title">
          <div><p className="project-home__eyebrow">Your workspace</p><h1 id="project-home-title">A place for your next idea.</h1><p className="project-home__intro">Start a new canvas or pick up where you left off.</p></div>
          <button className="project-home__new" type="button" disabled={loading || locked || Boolean(unsavedEdits)} {...offlineMark(offline)} onClick={() => onCreate()}><Plus aria-hidden="true" />New project</button>
        </section>

        {/* Every notice on the home, in page order, under one focus rule
            (useNoticeStackFocus; review 13 of PR #199, MEDIUM-1). */}
        <div ref={stack} className="project-home__notice-area">
        {/* The same element with or without a restore: its live region stays in the page. */}
        <div {...(catalogRestore ? track('restore') : {})}><CatalogRestoreNotice copy={copy} copyFailed={copyFailed} restore={catalogRestore} current={current}
          onDismiss={onDismissCatalogRestore} heldUnreadable={canvasHeldUnreadable} onOpenRecentlyDeleted={openTrash} /></div>
        {showWaiting && canvasNotFiled && copy && <div {...track('waiting')}><CanvasWaitingNotice copy={copy} waiting={canvasNotFiled} trashCount={trash.length}
          onOpenRecentlyDeleted={() => openTrash()} /></div>}
        {showUnreadable && canvasHeldUnreadable && copy && <div {...track('unreadable')}><CanvasHeldUnreadableNotice copy={copy} count={canvasHeldUnreadable.count}
          onDismiss={onDismissCanvasHeldUnreadable} /></div>}

        {/* The notice stack (GM r14 item 1): the recovered copy's notice first,
            then the held edits or the line that says where they went, then
            the error. GM's WRAP rule: where "Try again" redoes the failure it
            is the retry, so the reason drops its own; where it only reloads,
            or can't help, the line stays whole. */}
        {(copyNotice || unsavedEdits || editsSavedAs || showError) && <div className="project-home__notices">
          {copyNotice && <div {...track('copy')}><CopyNotice notice={copyNotice} busy={locked}
            onRestore={onRestoreCopy} onOpen={onOpenCopy} onDismiss={onDismissCopy} /></div>}
          {unsavedEdits ? <div {...track('held')}><UnsavedEditsNotice reason={unsavedEdits.reason} downloadFailed={unsavedEdits.downloadFailed}
            downloadTooBig={unsavedEdits.downloadTooBig}
            keptIn={unsavedEdits.keptIn} agentOpening={unsavedEdits.agentOpening} busy={locked}
            onDownload={onDownloadEdits} onContinue={onContinueWithoutEdits} /></div>
            : editsSavedAs && <div {...track('saved')}><div tabIndex={-1} className="project-home__notice" role="status">
              {editsSavedLine(editsSavedAs.name)}</div></div>}
          {showError && <div {...track('error')}><div className="project-home__error" role="alert" tabIndex={-1}>
            {errorDetails ? <div className="project-home__error-text"><span>{retry === 'redo' ? shortLine(error!) : error}</span>
              <ErrorDetails raw={errorDetails} className="project-home__error-details" /></div>
              : <span>{retry === 'redo' ? shortLine(error!) : error}</span>}
            {/* GM r9 decision 1: after an update, [Reload Nebula] in place of Try again. */}
            {retry !== 'none' && <button type="button" disabled={loading || busy} onClick={onRetry}>
              {retry === 'reloadNebula' ? 'Reload Nebula' : retry === 'save' ? SAVE_AS_A_PROJECT : 'Try again'}</button>}</div></div>}
        </div>}
        </div>

        <section className="project-home__projects" aria-labelledby="recent-projects-title">
          <div className="project-home__section-header">
            <h2 id="recent-projects-title" ref={recentHeading} tabIndex={-1}>Recent projects{projects.length > 0 && <span className="project-home__count" aria-hidden="true">{projects.length}</span>}</h2>
            {projects.length > 0 && <div className="project-home__search"><Search aria-hidden="true" /><label className="project-home__sr-only" htmlFor="project-home-search">Search projects</label><input id="project-home-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></div>}
          </div>
          {loading ? <div className="project-home__loading" role="status"><span className="project-home__loading-dot" />Loading your projects…</div>
            : visibleProjects.length > 0 ? <div className="project-home__grid">{visibleProjects.map((project) => <ProjectCard key={project.id} project={project} busy={locked} offline={offline} onOpen={onOpen} onRename={onRename} onDelete={onDelete} loadCoverChoices={loadCoverChoices} onPinCover={onPinCover} />)}</div>
              : projects.length > 0 ? <div className="project-home__empty" role="status"><Search className="project-home__empty-search" aria-hidden="true" /><h3>No projects match “{query.trim()}”</h3><p>Try another name or clear your search.</p><button type="button" className="project-home__secondary project-home__search-reset" onClick={() => setQuery('')}>Clear search</button></div>
                : !error && !unsavedEdits && <div className="project-home__empty"><div className="project-home__empty-graph"><NodeGraphPlaceholder /></div><h3>Your first project starts here.</h3><p>Connect ideas, models and media on a canvas of your own.</p><button type="button" className="project-home__secondary" disabled={locked} {...offlineMark(offline)} onClick={() => onCreate()}><Plus aria-hidden="true" />Create your first project</button></div>}
        </section>
        {!loading && trash.length > 0 && <RecentlyDeleted trash={trash} busy={locked} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} openRequest={trashOpenRequest} onOpened={trashOpened} fromNotice={trashFromNotice} />}
      </main>
      {/* It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2). */}
      <NoticeLeave value={lastDeleted}>{(last, leave) => <UndoToast key={last.id} project={last} busy={locked}
        onUndo={() => onRestore(last.id, 'undo')} onDismiss={onDismissUndo} leave={leave} />}</NoticeLeave>
      {canvasSaved && copy && <CanvasSavedToast key={canvasSaved.id} copy={copy} project={canvasSaved} onDismiss={onDismissCanvasSaved} />}
      {editsRecoveredAs && !canvasSaved && <SavedToast key={editsRecoveredAs.id} text={filedCopyLine(editsRecoveredToast(editsRecoveredAs.name), editsRecoveredAs)}
        onDismiss={onDismissEditsRecovered} />}
      {agentClosedNote && !canvasSaved && !editsRecoveredAs && <SavedToast key={agentClosedNote.id} text={agentClosedNote.text}
        onDismiss={onDismissAgentClosedNote} />}
    </div>
  );
}
