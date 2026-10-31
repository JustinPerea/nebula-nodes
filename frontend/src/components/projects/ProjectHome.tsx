import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowUpRight, Check, ChevronRight, ImageIcon, Pencil, Plus, RotateCcw, Search, Settings, Trash2, X } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { coverImages, type CoverChoices, type ProjectCover } from '../../lib/projects';
import { actorLabel } from '../../lib/trash';
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
import { NoticeLeave, type LeaveProps } from '../../lib/noticeLeave';
import { LineText } from '../LineText';
import { PersonLockLine, type PersonLock } from '../PersonLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { useSlotWaiting } from '../../lib/noticeWaiting';

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
   * 'none' hides Try again (the whole line). */
  retry?: 'redo' | 'reload' | 'none' | 'reloadNebula';
  /** PR #204 round 11: Try again redoes a "Delete forever" or "Empty" (DELETE
   * /api/projects/trash/{id}, POST /api/projects/trash/empty: require_person), so on a tab that
   * isn't connected as the person it locks as those buttons do. */
  retryPersonOnly?: boolean;
  /** GM r12 item 5: where an update's recovered copy went, when the reload
   * couldn't open it (store/projectStore CopyNotice): neutral, × to close,
   * [Restore] while it is in Recently deleted. */
  copyNotice?: { line: string; restore: { id: string; name: string } | null; open?: { id: string; name: string } | null } | null;
  onRestoreCopy?: () => void;
  onDismissCopy?: () => void;
  /** GM #198 r22 Q2: [Open] on the notice saying where a stale tab's edits
   * were saved (a recovered project); opens it. */
  onOpenCopy?: () => void;
  /** PR #204 round 11 (GM r18): whether this tab loaded the work. A card's node and connection
   * counts come with it: while it couldn't (a tab that isn't connected as you), they show
   * nothing rather than a 0 nobody counted. */
  workLoaded?: boolean;
  trash?: TrashedProject[];
  lastDeleted?: { id: string; name: string } | null;
  onRestore?: (id: string) => void;
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
      {failed ? <p className="project-home__cover-note"><LineText text={failed} /></p>
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

function ProjectCard({ project, busy, offline = false, counts = true, onOpen, onRename, onDelete, loadCoverChoices, onPinCover }: Pick<ProjectHomeProps, 'busy' | 'onOpen' | 'onRename' | 'onDelete' | 'loadCoverChoices' | 'onPinCover'> & { project: ProjectSummary; offline?: boolean; counts?: boolean }) {
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
        {counts
          ? <span><span>{project.nodeCount} {project.nodeCount === 1 ? 'node' : 'nodes'}</span><span aria-hidden="true"> · </span><span>{project.edgeCount} {project.edgeCount === 1 ? 'connection' : 'connections'}</span></span>
          : <span data-testid="project-card-no-counts" />}
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

function deletedByNote(entry: TrashedProject): string {
  const by = entry.deletedBy;
  if (!by || by.kind === 'person') return '';
  return ` by ${actorLabel(by)}`;
}

/** Two-step button for the irreversible actions: first press arms, second confirms. */
function ConfirmInline({ label, confirmLabel, prompt, busy, onConfirm, className, lock }: {
  label: string; confirmLabel: string; prompt: string; busy: boolean; onConfirm: () => void; className?: string;
  /** A person-only action's lock (components/PersonLock): it never arms while locked. */
  lock?: PersonLock;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const disarm = () => { setArmed(false); requestAnimationFrame(() => trigger.current?.focus()); };
  if (!armed) {
    // It arms a Delete forever or an Empty: red on hover (GM r13), neutral at rest.
    return <button type="button" ref={trigger} className={[className, 'project-home__trigger--danger'].filter(Boolean).join(' ')} disabled={busy}
      {...lock?.control()} onClick={() => { if (!lock?.locked) setArmed(true); }}>{label}</button>;
  }
  return (
    <span className="project-home__confirm" role="group" aria-label={prompt} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); disarm(); }
    }}>
      <span className="project-home__confirm-prompt">{prompt}</span>
      <button type="button" autoFocus disabled={busy} onClick={disarm}>Cancel</button>
      <button type="button" className="project-home__danger" disabled={busy} {...lock?.control()}
        onClick={() => { setArmed(false); if (!lock?.locked) onConfirm(); }}>{confirmLabel}</button>
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
  // PR #204 round 10 (GM r15, r17 item 1): deleting for good is the person's alone (DELETE
  // /api/projects/trash/{id}, POST .../trash/empty: require_person). Empty and every Delete
  // forever lock as one group with one line under the heading.
  const purgeLock = usePersonLock('delete projects for good');
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
          busy={busy} onConfirm={onEmptyTrash} className="project-home__trash-empty" lock={purgeLock} />}
      </div>
      {open && <PersonLockLine lock={purgeLock} place="control" />}
      {open && (
        <div id="recently-deleted-list">
          <p className="project-home__trash-note">Deleted projects stay here for 30 days. Generated files stay in your outputs folder either way.</p>
          <ul className="project-home__trash-list">
            {trash.map((entry) => (
              <li key={entry.id} className="project-home__trash-row" aria-label={entry.name}>
                <span className="project-home__trash-name">{entry.name}</span>
                <span className="project-home__trash-meta">{deletedDate(entry.deletedAt)}{deletedByNote(entry)} · {removalNote(entry.purgeAt, now)}</span>
                <span className="project-home__trash-actions">
                  <button type="button" disabled={busy} aria-label={`Restore ${entry.name}`} onClick={() => onRestore(entry.id)}><RotateCcw aria-hidden="true" />Restore</button>
                  <ConfirmInline label="Delete forever" confirmLabel="Delete forever" prompt="This can’t be undone." busy={busy}
                    onConfirm={() => onPurge(entry.id)} lock={purgeLock} />
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
  const [paused, setPaused] = useState(false);
  // Waiting behind a capped popover (GM r13 2): its timer holds, so it isn't lost.
  const waiting = useSlotWaiting('project-home');
  useEffect(() => {
    if (paused || waiting) return;
    const timer = window.setTimeout(onDismiss, UNDO_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, waiting, onDismiss, project.id]);
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
      <span className="project-home__notice-text"><LineText text={notice.line} /></span>
      <span className="project-home__notice-actions">
        {notice.restore && <button type="button" className="project-home__notice-restore" disabled={busy} onClick={onRestore}>Restore</button>}
        {notice.open && <button type="button" className="project-home__notice-restore" disabled={busy} onClick={onOpen}>Open</button>}
        <button type="button" className="project-home__notice-close" aria-label="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
      </span>
    </div>
  );
}

const noop = () => {};

/** Which notice in the stack focus was in, by its key, and the keys of the
 * stack as it was. React's focus events bubble through portals, so focus in
 * a notice's own dialog (the held edits' confirm) counts as in the notice. */
type NoticeKey = 'copy' | 'held' | 'saved' | 'error';

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
    const notices = Array.from(stack.current?.querySelectorAll<HTMLElement>(':scope > [data-notice]') ?? []);
    const target = notices[Math.min(index, notices.length - 1)];
    if (!target) { fallback.current?.focus(); return; }
    // Its ×, else the notice itself by its tabindex: never one of its actions.
    const control = target.querySelector<HTMLElement>(`${NOTICE_DISMISS}:not(:disabled)`)
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
  unsavedEdits = null, editsSavedAs = null, onDownloadEdits = noop, onContinueWithoutEdits = noop,
  copyNotice = null, onRestoreCopy = noop, onDismissCopy = noop, onOpenCopy = noop, workLoaded = true, retryPersonOnly = false }: ProjectHomeProps) {
  const retryLock = usePersonLock('delete projects for good', retry !== 'none' && retryPersonOnly);
  const [query, setQuery] = useState('');
  // Offline is read-only (round 15 of PR #114): create, open, rename,
  // delete, restore and covers are disabled as while busy; search and
  // "Try again" (a read) still work.
  const offline = useBackendOffline();
  const locked = busy || offline;
  const stack = useRef<HTMLDivElement>(null);
  const recentHeading = useRef<HTMLHeadingElement>(null);
  const showError = !unsavedEdits && Boolean(error);
  const noticeKeys: NoticeKey[] = [
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

        {/* The notice stack (GM r14 item 1): the recovered copy's notice first,
            then the held edits or the line that says where they went, then
            the error. GM's WRAP rule: where "Try again" redoes the failure it
            is the retry, so the reason drops its own; where it only reloads,
            or can't help, the line stays whole. */}
        {noticeKeys.length > 0 && <div ref={stack} className="project-home__notices">
          {copyNotice && <div {...track('copy')}><CopyNotice notice={copyNotice} busy={locked}
            onRestore={onRestoreCopy} onOpen={onOpenCopy} onDismiss={onDismissCopy} /></div>}
          {unsavedEdits ? <div {...track('held')}><UnsavedEditsNotice reason={unsavedEdits.reason} downloadFailed={unsavedEdits.downloadFailed}
            downloadTooBig={unsavedEdits.downloadTooBig}
            keptIn={unsavedEdits.keptIn} agentOpening={unsavedEdits.agentOpening} busy={locked}
            onDownload={onDownloadEdits} onContinue={onContinueWithoutEdits} /></div>
            : editsSavedAs && <div {...track('saved')}><div tabIndex={-1} className="project-home__notice" role="status">
              {editsSavedLine(editsSavedAs.name)}</div></div>}
          {showError && <div {...track('error')}><div className="project-home__error" role="alert" tabIndex={-1} data-line-box="">
            {errorDetails ? <div className="project-home__error-text"><span>{retry === 'redo' ? <LineText text={shortLine(error!)} /> : <LineText text={error} />}</span>
              <ErrorDetails raw={errorDetails} className="project-home__error-details" /></div>
              : <span>{retry === 'redo' ? <LineText text={shortLine(error!)} /> : <LineText text={error} />}</span>}
            {/* GM r9 decision 1: after an update, [Reload Nebula] in place of Try again. */}
            {retry !== 'none' && <button type="button" disabled={loading || busy} {...retryLock.control()} onClick={retryLock.guard(onRetry)}>
              {retry === 'reloadNebula' ? 'Reload Nebula' : 'Try again'}</button>}
            <PersonLockLine lock={retryLock} place="control" /></div></div>}
        </div>}

        <section className="project-home__projects" aria-labelledby="recent-projects-title">
          <div className="project-home__section-header">
            <h2 id="recent-projects-title" ref={recentHeading} tabIndex={-1}>Recent projects{projects.length > 0 && <span className="project-home__count" aria-hidden="true">{projects.length}</span>}</h2>
            {projects.length > 0 && <div className="project-home__search"><Search aria-hidden="true" /><label className="project-home__sr-only" htmlFor="project-home-search">Search projects</label><input id="project-home-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></div>}
          </div>
          {loading ? <div className="project-home__loading" role="status"><span className="project-home__loading-dot" />Loading your projects…</div>
            : visibleProjects.length > 0 ? <div className="project-home__grid">{visibleProjects.map((project) => <ProjectCard key={project.id} project={project} busy={locked} offline={offline} counts={workLoaded} onOpen={onOpen} onRename={onRename} onDelete={onDelete} loadCoverChoices={loadCoverChoices} onPinCover={onPinCover} />)}</div>
              : projects.length > 0 ? <div className="project-home__empty" role="status"><Search className="project-home__empty-search" aria-hidden="true" /><h3>No projects match “{query.trim()}”</h3><p>Try another name or clear your search.</p><button type="button" className="project-home__secondary project-home__search-reset" onClick={() => setQuery('')}>Clear search</button></div>
                : !error && !unsavedEdits && <div className="project-home__empty"><div className="project-home__empty-graph"><NodeGraphPlaceholder /></div><h3>Your first project starts here.</h3><p>Connect ideas, models and media on a canvas of your own.</p><button type="button" className="project-home__secondary" disabled={locked} {...offlineMark(offline)} onClick={() => onCreate()}><Plus aria-hidden="true" />Create your first project</button></div>}
        </section>
        {!loading && trash.length > 0 && <RecentlyDeleted trash={trash} busy={locked} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} />}
      </main>
      {/* It leaves as it entered (fix round 7 of PR #200, GM r11 answer 2). */}
      <NoticeLeave value={lastDeleted}>{(last, leave) => <UndoToast key={last.id} project={last} busy={locked}
        onUndo={() => onRestore(last.id)} onDismiss={onDismissUndo} leave={leave} />}</NoticeLeave>
    </div>
  );
}
