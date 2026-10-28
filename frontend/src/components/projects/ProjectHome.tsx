import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowUpRight, Check, ChevronRight, ImageIcon, Pencil, Plus, RotateCcw, Search, Settings, Trash2, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { coverImages, type CatalogRestore, type CoverChoices, type ProjectCover, type SavedCanvas } from '../../lib/projects';
import {
  canvasHeldUnreadableLine, canvasSavedToast, canvasWaitingLine, catalogRestoreNotice, DEFAULT_PROJECT_LIMIT, editsRecoveredToast,
  OPEN_RECENTLY_DELETED, restoreAtLimitTooltip, SAVE_AS_A_PROJECT, type CanvasLimit, type CanvasLimitContext, type NoticeNow, type RestoreRoom,
} from './catalogRestoreCopy';
import { actorLabel } from '../../lib/trash';
import { removalNote } from './trashDays';
import { lastInputWasKeyboard } from '../../lib/inputModality';
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
  retry?: 'redo' | 'reload' | 'save' | 'none';
  trash?: TrashedProject[];
  /** The project the person just moved to Recently deleted (the Undo
   * toast); ``refused`` is the line that replaces it when its Undo was
   * refused by the project limit (GM r6), with no Undo button. */
  lastDeleted?: { id: string; name: string; refused?: string } | null;
  /** `from` 'undo' when the Undo toast's button asked. */
  onRestore?: (id: string, from?: 'undo') => void;
  onPurge?: (id: string) => void;
  onEmptyTrash?: () => void;
  onDismissUndo?: () => void;
  /** A stale tab's unsaved edits Nebula refused for good (Q116 a): GM's
   * "Couldn't save your edits." with this reason, in place of the error line
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
  editsRecoveredAs?: { id: string; name: string } | null;
  onDismissEditsRecovered?: () => void;
  /** The backend's verdict on a restore now (the listing's `restoreRoom`,
   * review 6 of PR #199, L-3): Restore greys on it, held canvases counted. */
  restoreRoom?: RestoreRoom | null;
  /** Held canvases canvas-held.json couldn't read (review 6, L-1). */
  canvasHeldUnreadable?: { count: number | null } | null;
  /** Its × (GM r9: a one-time report, closed like the restore notice). */
  onDismissCanvasHeldUnreadable?: () => void;
  onDismissCanvasSaved?: () => void;
  /** How many projects the list may hold (the listing's `projectLimit`):
   * at it, Restore in Recently deleted is disabled with GM r7's tooltip. */
  projectLimit?: number;
  /** The switch that lets a restore pass the limit is on (the listing's
   * `restoreMayPassTheProjectLimit`): Restore stays enabled. */
  restorePassesLimit?: boolean;
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

function ProjectCard({ project, busy, onOpen, onRename, onDelete, loadCoverChoices, onPinCover }: Pick<ProjectHomeProps, 'busy' | 'onOpen' | 'onRename' | 'onDelete' | 'loadCoverChoices' | 'onPinCover'> & { project: ProjectSummary }) {
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
              disabled={busy || editing} onClick={() => setChoosingCover(!choosingCover)}><ImageIcon aria-hidden="true" /></button>
          )}
          <button type="button" className="project-home__rename" ref={renameButton} aria-label={`Rename ${project.name}`} aria-expanded={editing} disabled={busy} onClick={() => {
            if (editing) finishRename();
            else { setName(project.name); setEditing(true); }
          }}><Pencil aria-hidden="true" /></button>
          <button type="button" className="project-home__rename project-home__delete" aria-label={`Delete ${project.name}`}
            title="Move to Recently deleted" disabled={busy || editing} onClick={() => onDelete(project.id)}><Trash2 aria-hidden="true" /></button>
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

function RecentlyDeleted({ trash, busy, onRestore, onPurge, onEmptyTrash, openRequest = 0, onOpened = noop, fromNotice = [],
  atLimit = null, restoreRoom = null }: {
  trash: TrashedProject[]; busy: boolean;
  /** The project limit when a restore is refused now (GM r7): Restore is
   * disabled in the shared grey, focusable, its tooltip saying why. */
  atLimit?: number | null;
  /** Why, from the backend (L-3): the real number of deletes, and whether
   * a canvas waiting to be saved holds the last place. */
  restoreRoom?: RestoreRoom | null;
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
                  {atLimit !== null
                    ? <button type="button" disabled={busy} aria-disabled="true" title={restoreAtLimitTooltip(atLimit, restoreRoom)}
                      className="project-home__restore--at-limit" aria-label={`Restore ${entry.name}`}><RotateCcw aria-hidden="true" />Restore</button>
                    : <button type="button" disabled={busy} aria-label={`Restore ${entry.name}`} onClick={() => onRestore(entry.id)}><RotateCcw aria-hidden="true" />Restore</button>}
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
  project: { id: string; name: string; refused?: string }; busy: boolean; onUndo: () => void; onDismiss: () => void;
}) {
  // A hold is per notice, as the app's other toasts (review 5 of PR #199,
  // N-2): the pointer or focus that held "Moved…" doesn't hold the refusal
  // that replaces it, so after a mouse Undo the refusal leaves on its own
  // time even under the pointer; pointing at it again (or focusing it) holds it.
  const notice = `${project.id}|${project.refused ?? ''}`;
  const [heldFor, setHeldFor] = useState<string | null>(null);
  const paused = heldFor === notice;
  // The refusal starts its own time in the same spot (GM r6: it replaces
  // the toast, so a dead Undo never stays up to be pressed again).
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, onDismiss, notice]);
  // The Undo button goes with the refusal: when it had focus, focus stays in
  // the toast (its ×) rather than dropping to the page. That focus is
  // Nebula's, not the person's, so it holds nothing. Only from the keyboard
  // (review 6 of PR #199, N-4; GM): after a mouse click focus stays where
  // the click left it, and the ring shows only on :focus-visible.
  const close = useRef<HTMLButtonElement>(null);
  const movingFocus = useRef(false);
  useEffect(() => {
    if (!project.refused || !lastInputWasKeyboard()) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      movingFocus.current = true;
      close.current?.focus();
      movingFocus.current = false;
    }
  }, [project.refused]);
  // In the app's notice region, like every toast (GM - Design, 2026-10-23).
  return (
    <InNoticeRegion slot="project-home">
      <div className="project-home__toast" role="status" aria-live="polite"
        onMouseEnter={() => setHeldFor(notice)} onMouseLeave={() => setHeldFor(null)}
        onFocus={() => { if (!movingFocus.current) setHeldFor(notice); }} onBlur={() => setHeldFor(null)}>
        {project.refused
          ? <span className="project-home__toast-text">{project.refused}</span>
          : <><span className="project-home__toast-text">Moved “{project.name}” to Recently deleted</span>
            <button type="button" className="project-home__toast-undo" disabled={busy} onClick={onUndo}>Undo</button></>}
        <button ref={close} type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </div>
    </InNoticeRegion>
  );
}

const noop = () => {};

/** The limit to say when a restore is refused now, else null (L-3): the
 * backend's own verdict, which counts canvases held aside to be saved; a
 * listing without it (an older backend) by the count of projects. */
function restoreRefusedNow(count: number, projectLimit: number | undefined, passes: boolean,
  room: RestoreRoom | null): number | null {
  if (passes) return null;
  const limit = projectLimit ?? DEFAULT_PROJECT_LIMIT;
  if (room) return limit;
  return projectLimit !== undefined && count >= projectLimit ? projectLimit : null;
}

/** The notice after Nebula restored a damaged project list (GM's lines,
 * catalogRestoreCopy). Its status region is in the page from the start and
 * filled after it mounts, so screen readers announce it (a live region
 * reads changes, not what it held when it appeared: review 1 of PR #199,
 * L8). × closes it and puts focus on the page heading. */
function CatalogRestoreNotice({ restore, current, heldUnreadable = null, onDismiss, onOpenRecentlyDeleted, heading }: {
  restore: CatalogRestore | null; current: NoticeNow; onDismiss: () => void;
  /** GM r9: held canvases that couldn't be read, merged in as one more line. */
  heldUnreadable?: { count: number | null } | null;
  onOpenRecentlyDeleted: (ids: string[]) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  // Filled once the region is in the page: the callback ref runs after it
  // is attached, and the content follows in the next render.
  const [ready, setReady] = useState(false);
  const attached = useCallback((region: HTMLDivElement | null) => { if (region) setReady(true); }, []);
  // Only the lines that still hold against the list now (GM r4), so a
  // restore or delete by the person or an agent updates it as it lands.
  const notice = ready && restore ? catalogRestoreNotice(restore, undefined, current, { heldUnreadable }) : null;
  return (
    // A polite live region rather than role="status": the page keeps one
    // status per notice it shows (the loading line, the saved-file line),
    // and this empty region stays in the page the whole time.
    <div ref={attached} className={notice ? 'project-home__notice project-home__restore' : 'project-home__sr-only'} aria-live="polite" aria-atomic="true">
      {notice && <>
        {/* GM r3's B layout: more than one outcome, one per line (no bullets). */}
        {notice.lines
          ? <div className="project-home__restore-text project-home__restore-lines">{notice.lines.map((line) => <p key={line}>{line}</p>)}</div>
          : <span className="project-home__restore-text">{notice.text}</span>}
        {/* Only while Recently deleted holds one of the notice's items (GM r4; L6). */}
        {notice.openRecentlyDeleted && current.trash.length > 0 && <button type="button" className="project-home__restore-action"
          onClick={() => onOpenRecentlyDeleted(notice.recentlyDeletedIds)}>{OPEN_RECENTLY_DELETED}</button>}
        <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={() => {
          // Before the button goes, so focus never drops to the page body.
          heading.current?.focus();
          onDismiss();
        }}><X aria-hidden="true" /></button>
      </>}
    </div>
  );
}

/** GM r9: the held canvases that couldn't be read, when no restore notice
 * shows to say it: its own notice, styled like the restore notice, closed
 * with × (a one-time report; only the waiting line has no ×). */
function CanvasHeldUnreadableNotice({ count, onDismiss, heading }: {
  count: number | null; onDismiss: () => void; heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="project-home__notice project-home__restore" role="status">
      <span className="project-home__restore-text">{canvasHeldUnreadableLine(count)}</span>
      <button type="button" className="project-home__toast-close" aria-label="Dismiss" onClick={() => {
        heading.current?.focus();
        onDismiss();
      }}><X aria-hidden="true" /></button>
    </div>
  );
}

/** GM r5's waiting line (r6's wording): the canvas isn't saved as a
 * project yet, the list is at a limit, nothing in it is lost. A slim notice where the restore notice sits; it
 * can't be dismissed while the canvas waits and goes once it is saved. The
 * size cap's adds "Open Recently deleted" (only a delete for good frees it). */
function CanvasWaitingNotice({ waiting, trashCount, onOpenRecentlyDeleted }: {
  waiting: { reason: CanvasLimit; projectLimit?: number; canvases?: CanvasLimitContext['canvases']; deletes?: number | null }; trashCount: number;
  onOpenRecentlyDeleted: () => void;
}) {
  const line = canvasWaitingLine(waiting.reason, {
    projectLimit: waiting.projectLimit ?? DEFAULT_PROJECT_LIMIT, trashHasItems: trashCount > 0, canvases: waiting.canvases,
    deletes: waiting.deletes,
  });
  return (
    <div className="project-home__notice project-home__restore project-home__waiting" role="status">
      <span className="project-home__restore-text">{line}</span>
      {waiting.reason === 'storage' && trashCount > 0 && <button type="button" className="project-home__restore-action"
        onClick={onOpenRecentlyDeleted}>{OPEN_RECENTLY_DELETED}</button>}
    </div>
  );
}

/** GM r5: "Once saved: the normal toast", with the project's real name. */
function CanvasSavedToast({ project, onDismiss }: {
  project: { id: string; name: string; overSaveLimit?: boolean; another?: boolean; agentCopy?: { agent?: string | null };
    filed?: SavedCanvas[] };
  onDismiss: () => void;
}) {
  return <SavedToast text={canvasSavedToast(project.name, project.filed, project.overSaveLimit === true,
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

/** The held edits' notice goes when the person chooses, and takes the
 * focused button (or the confirm's) with it, which would drop focus to the
 * page body and send the next Tab back to the top. Focus moves to the line
 * that says where the file went, or, after Continue without them, to the
 * page heading. Only when focus was lost: never from something the person
 * moved to meanwhile (Q116 a review). */
function useFocusAfterHeldEdits(held: boolean, savedLine: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>): void {
  const wasHeld = useRef(held);
  useEffect(() => {
    const had = wasHeld.current;
    wasHeld.current = held;
    if (!had || held) return;
    // After the commit that removed the notice: no frame to wait for (a
    // frame never comes in a background tab).
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (savedLine.current ?? heading.current)?.focus();
  }, [held, savedLine, heading]);
}

export function ProjectHome({ projects, loading, busy, error, errorDetails = null, onCreate, onOpen, onRename, onDelete, onRetry, retry = 'redo',
  trash = [], lastDeleted = null, onRestore = noop, onPurge = noop, onEmptyTrash = noop, onDismissUndo = noop,
  settingsOpen = false, onToggleSettings, loadCoverChoices, onPinCover,
  catalogRestore = null, onDismissCatalogRestore = noop,
  canvasNotFiled = null, canvasSaved = null, onDismissCanvasSaved = noop, editsRecoveredAs = null, onDismissEditsRecovered = noop,
  projectLimit, restorePassesLimit = false,
  restoreRoom = null, canvasHeldUnreadable = null, onDismissCanvasHeldUnreadable = noop,
  unsavedEdits = null, editsSavedAs = null, onDownloadEdits = noop, onContinueWithoutEdits = noop }: ProjectHomeProps) {
  const [query, setQuery] = useState('');
  // Offline is read-only (round 15 of PR #114): create, open, rename,
  // delete, restore and covers are disabled as while busy; search and
  // "Try again" (a read) still work.
  const offline = useBackendOffline();
  const locked = busy || offline;
  const savedLine = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusAfterHeldEdits(Boolean(unsavedEdits), savedLine, heading);
  const [trashOpenRequest, setTrashOpenRequest] = useState(0);
  const [trashFromNotice, setTrashFromNotice] = useState<string[]>([]);
  const trashOpened = useCallback(() => setTrashOpenRequest(0), []);
  const openTrash = useCallback((ids: string[] = []) => {
    setTrashFromNotice(ids);
    setTrashOpenRequest((last) => Math.max(Date.now(), last + 1));
  }, []);
  const current = useMemo<NoticeNow>(() => ({ projects, trash, canvasNotFiled }), [projects, trash, canvasNotFiled]);
  // The waiting line, unless the restore notice already says the limit.
  const restoreSaysLimit = Boolean(catalogRestore && canvasNotFiled
    && catalogRestoreNotice(catalogRestore, undefined, current).canvasLine === 'limit');
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
          <div><p className="project-home__eyebrow">Your workspace</p><h1 id="project-home-title" ref={heading} tabIndex={-1}>A place for your next idea.</h1><p className="project-home__intro">Start a new canvas or pick up where you left off.</p></div>
          <button className="project-home__new" type="button" disabled={loading || locked || Boolean(unsavedEdits)} {...offlineMark(offline)} onClick={() => onCreate()}><Plus aria-hidden="true" />New project</button>
        </section>

        <CatalogRestoreNotice restore={catalogRestore} current={current} onDismiss={onDismissCatalogRestore} heading={heading}
          heldUnreadable={canvasHeldUnreadable} onOpenRecentlyDeleted={openTrash} />
        {canvasNotFiled && !restoreSaysLimit && <CanvasWaitingNotice waiting={canvasNotFiled} trashCount={trash.length}
          onOpenRecentlyDeleted={() => openTrash()} />}
        {canvasHeldUnreadable && !catalogRestore && <CanvasHeldUnreadableNotice count={canvasHeldUnreadable.count}
          onDismiss={onDismissCanvasHeldUnreadable} heading={heading} />}

        {/* GM's WRAP rule: where "Try again" redoes the failure it is the retry, so the
            reason drops its own; where it only reloads, or can't help, the line stays whole. */}
        {unsavedEdits ? <UnsavedEditsNotice reason={unsavedEdits.reason} downloadFailed={unsavedEdits.downloadFailed}
          downloadTooBig={unsavedEdits.downloadTooBig}
          keptIn={unsavedEdits.keptIn} agentOpening={unsavedEdits.agentOpening} busy={locked}
          onDownload={onDownloadEdits} onContinue={onContinueWithoutEdits} />
          : editsSavedAs && <div ref={savedLine} tabIndex={-1} className="project-home__notice" role="status">
            {editsSavedLine(editsSavedAs.name)}</div>}
        {!unsavedEdits && error && <div className="project-home__error" role="alert">
          {errorDetails ? <div className="project-home__error-text"><span>{retry === 'redo' ? shortLine(error) : error}</span>
            <ErrorDetails raw={errorDetails} className="project-home__error-details" /></div>
            : <span>{retry === 'redo' ? shortLine(error) : error}</span>}
          {retry !== 'none' && <button type="button" disabled={loading || busy} onClick={onRetry}>
            {retry === 'save' ? SAVE_AS_A_PROJECT : 'Try again'}</button>}</div>}

        <section className="project-home__projects" aria-labelledby="recent-projects-title">
          <div className="project-home__section-header">
            <h2 id="recent-projects-title">Recent projects{projects.length > 0 && <span className="project-home__count" aria-hidden="true">{projects.length}</span>}</h2>
            {projects.length > 0 && <div className="project-home__search"><Search aria-hidden="true" /><label className="project-home__sr-only" htmlFor="project-home-search">Search projects</label><input id="project-home-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></div>}
          </div>
          {loading ? <div className="project-home__loading" role="status"><span className="project-home__loading-dot" />Loading your projects…</div>
            : visibleProjects.length > 0 ? <div className="project-home__grid">{visibleProjects.map((project) => <ProjectCard key={project.id} project={project} busy={locked} onOpen={onOpen} onRename={onRename} onDelete={onDelete} loadCoverChoices={loadCoverChoices} onPinCover={onPinCover} />)}</div>
              : projects.length > 0 ? <div className="project-home__empty" role="status"><Search className="project-home__empty-search" aria-hidden="true" /><h3>No projects match “{query.trim()}”</h3><p>Try another name or clear your search.</p><button type="button" className="project-home__secondary" onClick={() => setQuery('')}>Clear search</button></div>
                : !error && !unsavedEdits && <div className="project-home__empty"><div className="project-home__empty-graph"><NodeGraphPlaceholder /></div><h3>Your first project starts here.</h3><p>Connect ideas, models and media on a canvas of your own.</p><button type="button" className="project-home__secondary" disabled={locked} {...offlineMark(offline)} onClick={() => onCreate()}><Plus aria-hidden="true" />Create your first project</button></div>}
        </section>
        {!loading && trash.length > 0 && <RecentlyDeleted trash={trash} busy={locked} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} openRequest={trashOpenRequest} onOpened={trashOpened} fromNotice={trashFromNotice}
          atLimit={restoreRefusedNow(projects.length, projectLimit, restorePassesLimit, restoreRoom)}
          restoreRoom={restoreRoom} />}
      </main>
      {lastDeleted && <UndoToast key={lastDeleted.id} project={lastDeleted} busy={locked}
        onUndo={() => onRestore(lastDeleted.id, 'undo')} onDismiss={onDismissUndo} />}
      {canvasSaved && <CanvasSavedToast key={canvasSaved.id} project={canvasSaved} onDismiss={onDismissCanvasSaved} />}
      {editsRecoveredAs && !canvasSaved && <SavedToast key={editsRecoveredAs.id} text={editsRecoveredToast(editsRecoveredAs.name)}
        onDismiss={onDismissEditsRecovered} />}
    </div>
  );
}
