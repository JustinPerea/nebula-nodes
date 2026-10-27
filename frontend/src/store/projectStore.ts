import { create } from 'zustand';
import { runsThatNeverStarted, useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { readDraft, useCreateDraftStore } from './createDraftStore';
import { useArrangeStore } from './arrangeStore';
import { fetchCLIGraph } from '../lib/api';
import { canonicalBackendAssetUrls, rewriteBackendAssetUrls } from '../lib/backend';
import {
  BrowserStringLimitError, normalizeRuntimeMediaParams, saveEditsToFile, saveProjectCopyToFile, type SavedEditsFile,
} from '../lib/graphFileShared';
import { PROJECT_SAVE_LIMIT_BYTES, projectSizeBytes } from '../lib/projectSize';
import { loadedNotice, pausedNotice, savingAgainNotice } from '../lib/savePausedCopy';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { getProjectContext, setProjectContext } from '../lib/projectContext';
import { currentProjectOf, publishOpenProject } from '../lib/currentProject';
import { holdsPersonCredential } from '../lib/personSession';
import { backendParamsVersion, onParamsOutdated, reloadPage } from '../lib/paramsOutdated';
import { clearPersistedRunHistory, loadRunHistory } from '../lib/runHistory';
import * as api from '../lib/projects';
import { wsClient } from '../lib/wsClient';
import type { ProjectSwitch } from '../lib/wsClient';
import { isOwnEcho, type EditOrigin } from '../lib/canvasUndo';
import { TAB_ID } from '../lib/tabId';
import { holdCommonsExits, holdProjects, refuseWhileCommonsUnsaved } from '../lib/commonsUnsaved';
import { showNotice } from '../lib/canvasNotice';
import { isBackendOffline, isOfflineRefusal, subscribeBackendConnection } from '../lib/backendConnection';
import {
  FailureNotice, PERSON_REQUIRED_CODE, REFUSED_FALLBACK_COPY, RequestFailedError, canTryAgain, failureCopy, failureDetails,
  failureMessage, oneLine, shortReason,
} from '../lib/errorCopy';
import { WORLD_LABS_NEEDS_CHECK } from '../lib/worldLabsWaiting';
import type { ProjectSnapshot, ProjectSummary, SavedProject, TrashedProject } from '../lib/projects';

/** An agent (or a script) opened or made a project and this tab followed it.
 * Shown as a toast with the way back. */
export interface ProjectSwitchNotice {
  /** The agent's name; null for an unnamed script or CLI call. */
  actorName: string | null;
  created: boolean;
  projectName: string;
  previousProjectId: string | null;
  previousProjectName: string | null;
  /** This tab's last unsaved changes couldn't go into the previous project,
   * so they were kept as a recovered copy instead. */
  keptCopy: boolean;
}

/**
 * What Projects' "Try again" does for the failure it shows (error copy round
 * 3b, GM - Design: "make Retry redo the failed action, never a different one.
 * If that's more than a small change, hide Retry for those failures instead.").
 * Each action records itself and what it needs to run again; a refusal the
 * same request would get again records nothing (no Try again). `load`: read
 * the saved projects again, as startup does (a failed load, a stop, a
 * conflict); `full` when that only reloads (the line says so and keeps its
 * whole reason), `reopen` when it then finishes an open whose reply was lost.
 */
export type ProjectRetry =
  | { action: 'load'; full?: boolean; reopen?: string }
  | { action: 'list' }
  | { action: 'save' }
  | { action: 'open'; id: string }
  | { action: 'create'; name?: string; then?: () => Promise<void> }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'restore'; id: string }
  | { action: 'purge'; id: string }
  | { action: 'emptyTrash'; ids: string[] }
  | { action: 'cover'; id: string; url: string | null };

/** What the Projects screen offers beside its error: 'redo' (Try again
 * redoes the failure, so the reason is GM's short line), 'reload' (Try again
 * reloads the saved projects, as the line says; the whole line stays) or
 * 'none' (no Try again; the whole line). */
export type ProjectRetryOffer = 'redo' | 'reload' | 'none';

export function projectRetryOffer(state: { error: string | null; errorRetry: ProjectRetry | null }): ProjectRetryOffer {
  if (!state.error || !state.errorRetry) return 'none';
  return state.errorRetry.action === 'load' && state.errorRetry.full ? 'reload' : 'redo';
}

/** The text behind the Projects error line's collapsed Details toggle: a
 * person-only refusal's own words, written for agents (GM - Design, Q116 a:
 * "The agents' text stays behind Details."), only while the line it was
 * written for is still the one showing. */
export function projectErrorDetails(state: { error: string | null; errorDetails: ProjectErrorDetails | null }): string | null {
  return state.error !== null && state.errorDetails?.line === state.error ? state.errorDetails.raw : null;
}

/** Details for one error line: the line it belongs to, so a later line
 * (set anywhere, by any action) never shows them. */
export interface ProjectErrorDetails { line: string; raw: string }
function detailsFor(line: string, error: unknown): ProjectErrorDetails | null {
  const raw = failureDetails(error);
  return raw ? { line, raw } : null;
}

interface ProjectState {
  screen: 'home' | 'workspace';
  initialized: boolean; loading: boolean; busy: boolean;
  projects: ProjectSummary[]; activeProject: ProjectSummary | null;
  /** Recently deleted, newest first. Restorable until each entry's purgeAt. */
  trash: TrashedProject[];
  /** The project the Undo toast offers to bring back. */
  lastDeleted: { id: string; name: string } | null;
  workspaceRevision: string; error: string | null;
  /** What `error`'s Details toggle holds, for that line (projectErrorDetails). */
  errorDetails: ProjectErrorDetails | null;
  /** What Try again does for `error`; null hides it (projectRetryOffer). */
  errorRetry: ProjectRetry | null;
  /** The last failed save's own line, for the canvas's "Save failed · Retry". */
  saveError: string | null;
  /** 'paused': the project is over the save limit (Q118), so nothing is
   * sent until it is trimmed (savePaused). */
  saveStatus: 'saved' | 'saving' | 'unsaved' | 'error' | 'paused'; dirty: boolean;
  /** Saving is paused because the open project is over the 16 MiB save
   * limit (Q118): its size as the save check counts it, kept current as it
   * changes. Null otherwise. */
  savePaused: { bytes: number } | null;
  /** The one region notice for this state (GM's "Saving paused. …", the
   * Load graph line, then "Saving again. …"); `action`: it offers "See
   * what's large". A new id is a new notice. */
  sizeNotice: { id: number; text: string; action: boolean } | null;
  /** The "what's large" panel is open. */
  sizePanelOpen: boolean;
  openSizePanel: () => void;
  closeSizePanel: () => void;
  dismissSizeNotice: () => void;
  /** Load graph opened `fileName`: over the limit, GM's Load graph line and
   * the paused state. */
  noteLoadedGraph: (fileName: string, asNewProject?: boolean) => void;
  /** The panel's "Download a copy": the open project's canvas as a plain
   * .nebula file, so nothing is lost while saving is paused. */
  downloadProjectCopy: () => Promise<void>;
  /** The last switch this tab followed (an agent's), for the toast. */
  switchNotice: ProjectSwitchNotice | null;
  /** A stale tab's unsaved edits that Nebula refused for good as a recovered
   * project (too large, say): the Projects screen shows GM's "Couldn't save
   * your edits." with this reason, and offers to download them or continue
   * without them (Q116 a). Null otherwise. `downloadFailed`: the last
   * download couldn't be written, so the screen says GM's line 2 instead of
   * the reason, with the same two choices. `keptIn`: the edits are the open
   * project's own live canvas (the person's Open or New project, or an
   * agent's switch, while saving was paused), and the backend's switch keeps
   * its nodes, connections and settings in that project, named here, so "Continue
   * without them" loses only what only this tab had; the confirm says so. */
  /** `agentOpening`: an agent's switch left the project (GM, 2026-10-24:
   * "{agent} is opening “{name}”." above the screen's lines). */
  /** `downloadTooBig`: the last download was past the browser's string cap
   * (GM, 2026-10-25: "Couldn't download your edits." / "It's too big to
   * download in a browser."), not a write that failed. */
  unsavedEdits: { reason: string; downloadFailed?: true; downloadTooBig?: true; keptIn?: string;
    agentOpening?: { agent: string; projectName: string } } | null;
  /** The file those edits were downloaded as, for GM's line after it, and
   * whether Load graph can open it (a copy past its limits can't). */
  editsSavedAs: SavedEditsFile | null;
  /** "Download your edits": write the held copy as a .nebula file, then load
   * the projects. A cancelled save picker keeps the two choices. */
  downloadUnsavedEdits: () => Promise<void>;
  /** "Continue without them", once the person confirmed: drop the held copy
   * (nothing is sent) and load the projects. */
  continueWithoutEdits: () => Promise<void>;
  dismissSwitchNotice: () => void;
  /** Back to the project that was open before the switch in switchNotice. */
  switchBack: () => Promise<void>;
  /** Pin one of a project's images as its card cover, or null for automatic. */
  pinCover: (id: string, url: string | null) => Promise<void>;
  initialize: () => Promise<void>;
  open: (id: string) => Promise<void>;
  /** `then` runs once the new project is open (Q120: a Load graph file over
   * the limit loads into it), after #178's screen when saving was paused with
   * unsaved edits; never when the create doesn't land. */
  createProject: (name?: string, then?: () => Promise<void>) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  dismissUndo: () => void;
  goHome: () => Promise<void>;
  flush: () => Promise<void>;
  /** Projects' Try again: redoes the action in errorRetry. */
  retry: () => Promise<void>;
  /** The canvas's "Save failed · Retry": saves, whatever Projects shows. */
  retrySave: () => Promise<void>;
}

let initializing: Promise<void> | null = null;
let saveQueue: Promise<unknown> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The person's edits save this long after the last one, so typing and
 * dragging go as one save. */
const AUTOSAVE_MS = 600;
/** A change the canvas made itself (saveCanvasChange) saves quietly once the
 * canvas has held still this long, so a fit's frames go as one save. */
const CANVAS_SETTLE_MS = 300;
let canvasTimer: ReturnType<typeof setTimeout> | null = null;
/** Count the changes the save label shows: the person's own (markDirty) and
 * someone else's edits that reached this tab (saveForeignEdit). A save
 * records both when it captures the canvas, so once it lands it can tell who
 * changed what is still unsaved, and a save with neither since the last one
 * landed is only the canvas's own and leaves "Saved" alone. */
let personChanges = 0;
let foreignEdits = 0;
let savedPersonChanges = 0;
let savedForeignEdits = 0;
/** Set while the graph store applies a graphSync carrying someone else's
 * edit ('edit') or the layout the canvas wrote for an agent's nodes
 * ('canvas'); what changes meanwhile is that sync's (applyingSync), and
 * syncSaving says the edit's save is already asked for. */
let syncBeingApplied: 'edit' | 'canvas' | null = null;
let syncSaving = false;
let lastSaved = '';
/** The canvas the save under way is sending. While it is out, a change is
 * measured against it, not the last save that landed: React Flow measuring an
 * agent's new nodes gives the graph a new nodes array, and next to the older
 * save that read as "Unsaved changes" though nothing saved had changed. */
let inFlight: string | null = null;
/** The canvas as of the last change looked at. A store update that leaves
 * what the project saves as it was (React Flow measuring nodes, selection)
 * isn't a change at all, so it neither reads as unsaved nor restarts a wait,
 * even while an earlier change is still waiting to save. */
let lastSeen = '';
let applying = false;
/** The view the open project was saved with. A tab that isn't connected as
 * the person (an agent's browser) keeps its own zoom and pan while open but
 * saves this one, so looking around there is never an unsaved edit; the
 * backend keeps the stored view for its saves anyway (design-canvas gap 19). */
let projectViewport: ProjectSnapshot['viewport'] = null;
/** A stale tab's unsaved work, waiting to be saved as a recovered project.
 * `projectName` names the download if Nebula refuses it for good; `held` is
 * set then, and from that moment nothing sends it again: only the person's
 * choice on the Projects screen lets go of it (Q116 a). */
interface PendingRecovery {
  sourceProjectId: string; snapshot: ProjectSnapshot; recoveryId: string; paramsVersion: number;
  projectName: string; held: boolean;
}
let pendingRecovery: PendingRecovery | null = null;
/** The open Try again was finishing when the held edits stopped it (an Open
 * whose answer was lost), or the person's own Open of another project while
 * saving was paused: done once the person has chosen. */
let heldEditsReopen: string | undefined;
/** The person's New project while saving was paused, done the same way. */
let heldEditsCreate: { name?: string; then?: () => Promise<void> } | undefined;
/** How many bytes more the backend counted than this tab did, from its last
 * 413 for the size (Q118). The two measures are the same by test, so this
 * is 0 unless they ever differ; then the canvas pauses on the backend's
 * number and doesn't send each change to be refused again. Cleared by a
 * save that lands and by loading a project. */
let sizeOffset = 0;
let sizeNoticeId = 0;
/** A save that would have ended the pause failed for another reason (a
 * dropped connection, a 5xx): the pause is dropped then, since the project
 * measured at the limit or under and the real problem is the failed save,
 * and the save that lands next still says GM's "Saving again" (review). */
let resumePending = false;
/** The person downloaded the held edits during a params-version stop: the
 * tab asks for its reload instead of reloading, so GM's line saying where
 * the file went stays on screen. */
let editsDownloaded = false;
/** The one-time param upgrades the canvas had when it was loaded. Every
 * project the backend returns is already upgraded to the backend's version,
 * and a project is applied only from a backend that reported this bundle's
 * GRAPH_PARAMS_VERSION (listing, create and open replies; a backend that
 * reports none is version 0 and is never loaded from). A stale tab's recovered
 * copy sends it, so the backend upgrades the copy from what the tab actually
 * holds rather than from its source project. */
let canvasParamsVersion = GRAPH_PARAMS_VERSION;
/** The backend's params version differs from this bundle's: the one handling
 * of it (recover once, then reload), shared by every report of it. */
let paramsVersionChange: Promise<void> | null = null;
/** Counts handlings of a params-version change. Retry starts a new one, so an
 * earlier handling whose recovered copy is answered after that is stale: it
 * must not stop, mark clean or relabel a tab Retry already moved on. */
let paramsHandling = 0;
/** Set when the tab reloads for a params upgrade, so the unsaved-changes
 * prompt doesn't stop a reload whose edits are already in a recovered copy. */
let reloadingForParams = false;
/** The backend version this tab already reloaded for (sessionStorage), so a
 * window whose frontend build is still older after a reload stops instead of
 * reloading again. */
const PARAMS_RELOAD_KEY = 'nebula:paramsReloadedFor';
/** Projects lists again on every projectsChanged (another writer made,
 * renamed, saved or deleted a project). Off Projects it waits for goHome. */
let listingStale = false;
let listing: Promise<void> | null = null;
let listAgain = false;
/** Bumped by every listing this tab applies, so an older reply never
 * replaces a newer list. */
let listingGeneration = 0;
/** A failed listing on Projects is tried again 1, 2, 4, 8 and 16 s later,
 * quietly; after that on focus, online or a socket reconnect. Off Projects
 * none is scheduled and a pending one sends nothing; goHome lists again with
 * a fresh count. */
let relistTimer: ReturnType<typeof setTimeout> | undefined;
let relistFailures = 0;
function relistIfStale(): void {
  if (listingStale && useProjectStore.getState().screen === 'home' && !paramsVersionChange) { listingStale = false; void relistProjects(); }
}

/** Persist authoring and results, excluding React Flow measurements/selection
 * and transient credential/progress presentation. JSON gives each save its
 * own immutable copy, including nested Paper recipes and run history. Asset
 * links go back to the relative ones the backend gave (applyProject and run
 * results make them absolute for display): a World's are refused otherwise. */
export function captureProjectSnapshot(): ProjectSnapshot {
  const graph = useGraphStore.getState();
  const ui = useUIStore.getState();
  const draft = ui.createSessionId ? useCreateDraftStore.getState().drafts[ui.createSessionId] : null;
  const snapshot: ProjectSnapshot = {
    nodes: graph.nodes.map((node) => {
      const data = { ...node.data, params: normalizeRuntimeMediaParams(node.data.definitionId, node.data.params) };
      delete data.keyStatus;
      delete data.progress;
      delete data.streamingText;
      delete data.streamingPartials;
      delete data.streamingSvg;
      return { id: node.id, type: node.type, position: node.position, data };
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: edge.type, data: edge.data,
    })),
    runHistory: graph.runHistory,
    viewport: holdsPersonCredential() ? ui.canvasViewport : projectViewport,
    createSessionId: ui.createSessionId,
    createDraft: draft ?? null,
  };
  return canonicalBackendAssetUrls(JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot);
}

function summary(project: SavedProject): ProjectSummary {
  const { snapshot: _snapshot, ...metadata } = project;
  void _snapshot;
  return metadata;
}
function byRecentEdit(a: ProjectSummary, b: ProjectSummary): number { return b.updatedAt.localeCompare(a.updatedAt); }
function updateSummary(project: SavedProject): void {
  const metadata = summary(project);
  useProjectStore.setState((state) => ({
    projects: [...state.projects.filter((item) => item.id !== project.id), metadata]
      .sort(byRecentEdit),
    ...(state.activeProject?.id === project.id ? { activeProject: metadata } : {}),
  }));
}

/** GM - Design, error copy round 3c: the older lines that asked the person
 * to finish or stop the current run become "A run is still going. Let it
 * finish or stop it.", every variant (opening, creating, deleting the open
 * project, a canvas that turned busy on the way). It sits under the action's
 * own heading, as the World Labs hold beside it does, and keeps its Try
 * again: that one can work once the run ends. Every one sits beside that
 * button, so the line drops its "then try again" (GM: "drop the "try again"
 * ending, per the WRAP rule ... Keep the full line wherever there's no Try
 * again button"). */
const RUN_STILL_GOING = 'A run is still going. Let it finish or stop it.';
/** After "Couldn't confirm …" and its short reason (GM, round 3c): what the
 * Try again beside it does, since it only re-reads. */
const TRY_AGAIN_CHECKS = "Try again checks your saved projects; it won't make the change twice.";
const LOAD_HEADING = "Couldn't load your projects.";
/** GM, round 3f: "Projects startup: drop "That didn't work." → "Couldn't load
 * your projects. Try again, or reload the page if it keeps happening." A full
 * disk is the one cause a person can fix, so give it its own line". */
const LOAD_GENERAL = 'Try again, or reload the page if it keeps happening.';
const LOAD_DISK_FULL = 'Your disk is full. Free up some space, then try again.';
const runStillGoing = (heading: string) => new FailureNotice(heading, RUN_STILL_GOING);

/** A failure's reason as its own sentence (GM, round 3c: "Reasons in
 * parentheses: move each into its own sentence after the heading. No
 * parentheses in error copy."): the request's line (never an error's own
 * message), short when a Try again sits beside it (GM's WRAP rule). A failure
 * with no reason of its own says none: GM's general line says "reload",
 * which these lines warn would lose the unsaved edits. */
function reasonSentence(error: unknown, short: boolean): string {
  const { reason } = failureCopy(error);
  if (reason === REFUSED_FALLBACK_COPY) return '';
  return short ? shortReason(reason) : reason;
}
const sentences = (...parts: string[]) => parts.filter(Boolean).join(' ');

/** The open project's size from its JSON text, as the backend counts it. */
const measured = (text: string) => projectSizeBytes(null, text) + sizeOffset;

/** Saving pauses (Q118): nothing is sent until the project is at the limit
 * or under. Entering shows one notice (`notice`, or GM's "Saving paused.
 * …"); while paused only the size is kept current. */
function pauseSaving(bytes: number, dirty: boolean, notice?: string): void {
  resumePending = false;
  const state = useProjectStore.getState();
  // A Load graph still under way says it with its own line (noteLoadedGraph)
  // once its answer is in: the graph it imports can reach this tab first (its
  // graphSync) and fire an autosave, and that one stays quiet.
  if (!state.savePaused && !notice && useGraphStore.getState().isImportingGraph) {
    useProjectStore.setState({ savePaused: { bytes }, saveStatus: 'paused', dirty, saveError: null });
    return;
  }
  if (!state.savePaused || notice) {
    useProjectStore.setState({
      savePaused: { bytes }, saveStatus: 'paused', dirty, saveError: null,
      sizeNotice: { id: ++sizeNoticeId, text: notice ?? pausedNotice(bytes), action: true },
    });
    return;
  }
  useProjectStore.setState({ saveStatus: 'paused', dirty,
    ...(state.savePaused.bytes !== bytes ? { savePaused: { bytes } } : {}) });
}

/** It saved again at `bytes` (GM): "Saving again. …", and the panel closes
 * by itself. The caller sets the header's status from what the save found. */
function resumeSaving(bytes: number): void {
  resumePending = false;
  useProjectStore.setState({ savePaused: null, sizePanelOpen: false,
    sizeNotice: { id: ++sizeNoticeId, text: savingAgainNotice(bytes), action: false } });
}

/** A project was loaded or let go of: no pause carried over from another. */
function clearSavePause(): void {
  sizeOffset = 0;
  resumePending = false;
  const state = useProjectStore.getState();
  if (state.savePaused || state.sizePanelOpen || state.sizeNotice) {
    useProjectStore.setState({ savePaused: null, sizePanelOpen: false, sizeNotice: null });
  }
}

/** `heading` names the action that loads it, for the busy line. */
function applyProject(project: SavedProject, revision: string, bootstrap = false,
  heading = "Couldn't load the project."): void {
  applying = true;
  const previous = getProjectContext();
  try {
    setProjectContext({ id: project.id, revision });
    canvasParamsVersion = GRAPH_PARAMS_VERSION;
    const snapshot = rewriteBackendAssetUrls(project.snapshot);
    if (!useGraphStore.getState().loadProjectGraph(snapshot.nodes, snapshot.edges, snapshot.runHistory, { bootstrap })) {
      setProjectContext(previous);
      throw runStillGoing(heading);
    }
    // A loaded project moves past any params-version stop, as Retry does: a
    // stop whose recovered copy is still unanswered (the tab followed an
    // agent's switch on a backend restarted at this version) is superseded,
    // so its late answer can't stop, mark clean or relabel this tab, and a
    // later version change starts a handling of its own (the stale promise
    // would otherwise swallow it). Its copy is dropped here, after its one
    // send has already gone out, and leaving it would make a later stop send
    // that old canvas instead of this project's edits. The canvas it holds was
    // saved on the way: followProjectSwitch saves it to the project it came
    // from (or recovers it), and an Open that a stop interrupted saved it
    // before asking (edits made while the request was out are replaced by
    // any load, stop or not). Retry's initialize recovers it before loading.
    if (!reloadingForParams) {
      paramsVersionChange = null;
      paramsHandling += 1;
    }
    // Held edits (Q116 a) are let go of the same way: only following an
    // agent's switch gets here while they show, after saving the canvas.
    pendingRecovery = null;
    heldEditsReopen = undefined;
    heldEditsCreate = undefined;
    editsDownloaded = false;
    if (useProjectStore.getState().unsavedEdits) useProjectStore.setState({ unsavedEdits: null });
    const sessionId = snapshot.createSessionId ?? `project:${project.id}:create`;
    const draft = readDraft(snapshot.createDraft);
    if (draft) {
      useCreateDraftStore.setState((state) => ({ drafts: {
        ...state.drafts, [sessionId]: structuredClone(draft),
      } }));
    }
    useUIStore.getState().resetPanelsForFreshCanvas({ canvasEmpty: snapshot.nodes.length === 0 });
    projectViewport = snapshot.viewport ?? null;
    useUIStore.setState({ viewMode: 'canvas', createSessionId: sessionId, canvasViewport: snapshot.viewport,
      commonsReturnView: 'canvas' });
    useProjectStore.setState({
      activeProject: summary(project), workspaceRevision: revision,
      initialized: true, dirty: false, saveStatus: 'saved', error: null, errorRetry: null, saveError: null,
    });
    lastSaved = JSON.stringify(captureProjectSnapshot());
    lastSeen = lastSaved;
    savedPersonChanges = personChanges;
    savedForeignEdits = foreignEdits;
    // A project stored over the save limit opens (Q118: the backend's open
    // doesn't refuse it), with saving paused until it is trimmed.
    clearSavePause();
    const bytes = measured(lastSaved);
    if (bytes > PROJECT_SAVE_LIMIT_BYTES) pauseSaving(bytes, false);
  } finally { applying = false; }
}

/** A refusal the same request would get again (a 4xx other than 408/429:
 * World Labs state on the canvas, a stale revision, a project that's gone):
 * Try again can't redo it, so it isn't offered (GM: hide it). A refusal
 * because this tab isn't connected as the person (`code: person_required`:
 * no person token, or one from before Nebula restarted) isn't: once the
 * person opens the launch link in this tab, the same request passes, so Try
 * again stays and a held copy isn't held for it (Q116 a review). */
function refusedForGood(error: unknown): boolean {
  return error instanceof WorldLabsHold || (error instanceof RequestFailedError && !canTryAgain(error.status)
    && error.code !== PERSON_REQUIRED_CODE);
}
/** The canvas holds World Labs state that only the person can clear (a start
 * Nebula couldn't confirm, or a run it couldn't confirm): switching or
 * deleting the open project is refused in the browser until they press the
 * status bar's "I've checked Marble". Redoing it fails the same check, so it
 * offers no Try again, and the line is the backend's refusal for the same
 * state (round 3b review; GM's line for it since round 13 of PR #114, in
 * place of round 12's "Open Run History…", which named the wrong place). A
 * run that is only going keeps the busy line and its Try again: that one can
 * succeed once the run ends. */
class WorldLabsHold extends FailureNotice {
  constructor(heading: string) { super(heading, WORLD_LABS_NEEDS_CHECK); }
}
function worldLabsHold(heading: string): WorldLabsHold | null {
  const graph = useGraphStore.getState();
  return graph.providerStartAmbiguities.length > 0 || graph.uncertainWorldLabsRunId !== null
    ? new WorldLabsHold(heading) : null;
}
/** The heading each Projects action's failure reads under: the same words
 * as its request (lib/projects.ts), so a failure that isn't a request's
 * (a plain Error) names the action too. */
const RETRY_HEADINGS: Record<ProjectRetry['action'], string> = {
  load: LOAD_HEADING, list: LOAD_HEADING, save: "Couldn't save the project.", open: "Couldn't open the project.",
  create: "Couldn't create the project.", rename: "Couldn't rename the project.", delete: "Couldn't delete the project.",
  restore: "Couldn't restore the project.", purge: "Couldn't delete the project for good.",
  emptyTrash: "Couldn't empty Recently deleted.", cover: "Couldn't set the cover.",
};
/** Show `error` with what Try again does for it: `retry`, unless the backend
 * refused for good (then no Try again). The line is GM's mapping (error copy
 * round 3e): a written failure keeps its heading and reason, anything else
 * reads the action's heading over GM's general line, never its own message. */
function showError(error: unknown, retry: ProjectRetry | null = null): void {
  // Refused while offline (round 15): nothing was sent and nothing is said;
  // the banner pulsed.
  if (isOfflineRefusal(error)) return;
  const line = failureMessage(error, RETRY_HEADINGS[retry?.action ?? 'save']);
  useProjectStore.setState({ error: line, errorDetails: detailsFor(line, error),
    errorRetry: refusedForGood(error) ? null : retry });
}
/** What counts as unsaved work when the tab stops for a params version: run
 * records that never ran are left out, and so is node run state (queued,
 * error), which a refused start leaves behind and which isn't authoring. */
function paramsStopWork(snapshot: ProjectSnapshot, neverRan: Set<string>): string {
  return JSON.stringify({
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      const { state: _state, error: _error, ...data } = node.data;
      void _state; void _error;
      return { ...node, data };
    }),
    runHistory: snapshot.runHistory.filter((record) => !neverRan.has(record.id)),
  });
}
/** `neverRan` is given for a params-version stop (handleParamsVersionChange). */
function preserveWorkspaceConflict(message: string, neverRan?: Set<string>, captured?: ProjectSnapshot,
  retry: ProjectRetry = { action: 'load', full: true }): void {
  cancelPendingSaves();
  // Edits held for the person's choice keep their screen: another stop
  // (another window, an update) doesn't replace it or capture them again.
  if (pendingRecovery?.held) return;
  const context = getProjectContext();
  let snapshot = captureProjectSnapshot();
  if (captured) snapshot = captured;
  let dirty: boolean;
  if (neverRan) {
    snapshot = { ...snapshot, runHistory: snapshot.runHistory.filter((record) => !neverRan.has(record.id)) };
    let saved: ProjectSnapshot | null = null;
    try { saved = lastSaved ? JSON.parse(lastSaved) as ProjectSnapshot : null; } catch { saved = null; }
    dirty = Boolean(context) && (!saved || paramsStopWork(snapshot, neverRan) !== paramsStopWork(saved, new Set()));
  } else dirty = Boolean(context) && JSON.stringify(snapshot) !== lastSaved;
  if (dirty && context) pendingRecovery = pendingRecoveryOf(context.id, snapshot);
  // Try again reloads the saved projects (initialize), as these lines say.
  useProjectStore.setState({ screen: 'home', initialized: false, loading: false, dirty, error: message, errorRetry: retry });
}
/** recoverPendingWork's refusal for good: the held edits are on the Projects
 * screen (holdRefusedEdits), so a caller stops here and shows nothing else. */
class EditsRefused extends Error {
  constructor() { super('The recovered copy was refused for good.'); this.name = 'EditsRefused'; }
}

/** GM - Design, Q116 a): the second sentence of every reason on the held
 * edits' screen, and the reason for a copy that is itself too large. */
const KEEP_OR_CONTINUE = 'Download them so nothing is lost, or continue without them.';
const EDITS_TOO_LARGE = 'These edits are too large for Nebula to save.';
const asSentence = (line: string) => (!line || /[.!?”"]$/.test(line) ? line : `${line}.`);

/** The held edits' reason (GM): too large for a copy the backend found too
 * big (a 413 that names no store limit: the snapshot's size, its node or
 * value count); else the mapped reason the screen used before (a reason with
 * none of its own says nothing, since GM's general line says "reload"),
 * then GM's second sentence. Read from the status and the answer's `limit`,
 * never from its words. */
function heldEditsReason(error: unknown): string {
  if (error instanceof RequestFailedError && error.status === 413 && error.storageLimit === null) {
    return sentences(EDITS_TOO_LARGE, KEEP_OR_CONTINUE);
  }
  return sentences(asSentence(reasonSentence(error, false)), KEEP_OR_CONTINUE);
}

/** The backend refused `recovery` for good: hold it and show the person the
 * choice. The tab stays stopped (no project, nothing saves) and the unload
 * prompt stays armed until they choose. */
function holdRefusedEdits(recovery: PendingRecovery, error: unknown, reason = heldEditsReason(error),
  keptIn?: string): void {
  recovery.held = true;
  heldEditsReopen = undefined;
  // A create that loads a file (Q120) is the person's own ask: it still
  // runs after their choice when an agent's switch brings the screen back.
  if (!heldEditsCreate?.then) heldEditsCreate = undefined;
  useProjectStore.setState({ screen: 'home', initialized: false, loading: false, dirty: true, error: null,
    errorRetry: null, unsavedEdits: { reason, ...(keptIn ? { keptIn } : {}) }, editsSavedAs: null, sizePanelOpen: false });
}

/** The held edits' reason for a copy over the save limit (GM, Q116 a). */
const EDITS_OVER_LIMIT = sentences(EDITS_TOO_LARGE, KEEP_OR_CONTINUE);

/** Edits over the save limit that are about to leave the canvas (the person
 * opening or making another project, an agent's switch, a stale tab's copy):
 * the backend would refuse them, so nothing is sent; they are held on #178's
 * screen for "Download your edits" or "Continue without them". `liveKept`:
 * they are the backend's live canvas too (the person's switch, an agent's),
 * which the backend's switch keeps in the project it leaves (the screen's
 * confirm names it); a stale tab's copy is not. */
function holdOverLimitEdits(sourceProjectId: string, snapshot: ProjectSnapshot, liveKept = false): void {
  const recovery = pendingRecoveryOf(sourceProjectId, snapshot);
  pendingRecovery = recovery;
  holdRefusedEdits(recovery, null, EDITS_OVER_LIMIT, liveKept ? recovery.projectName : undefined);
}

/** The person chose (downloaded the edits, or continued without them): the
 * tab lets go of the copy, and the canvas it came from counts as handled, so
 * a later stop doesn't copy it again. */
function letGoOfHeldEdits(recovery: PendingRecovery, savedAs: SavedEditsFile | null = null): void {
  if (pendingRecovery === recovery) pendingRecovery = null;
  lastSaved = JSON.stringify(recovery.snapshot);
  // One update: the screen trades the notice for the saved line at once, so
  // focus can move to it (ProjectHome).
  useProjectStore.setState({ unsavedEdits: null, dirty: false, editsSavedAs: savedAs });
}

/** After the choice: load the projects, then the open Try again was finishing. */
async function loadAfterHeldEdits(): Promise<void> {
  const reopen = heldEditsReopen;
  const create = heldEditsCreate;
  heldEditsReopen = undefined;
  heldEditsCreate = undefined;
  const store = useProjectStore.getState();
  await store.initialize();
  const state = useProjectStore.getState();
  if (state.error || !state.initialized || state.unsavedEdits) return;
  if (create) { await state.createProject(create.name, create.then); return; }
  if (!reopen) return;
  if (state.activeProject?.id === reopen && getProjectContext()) useProjectStore.setState({ screen: 'workspace' });
  else await state.open(reopen);
}

/** The project a stale tab's copy comes from, by name, for the download. */
function projectNameOf(id: string): string {
  const state = useProjectStore.getState();
  return (state.activeProject?.id === id ? state.activeProject.name : state.projects.find((item) => item.id === id)?.name)
    ?? 'Untitled project';
}

function pendingRecoveryOf(sourceProjectId: string, snapshot: ProjectSnapshot): PendingRecovery {
  return { sourceProjectId, snapshot, recoveryId: crypto.randomUUID().replaceAll('-', ''),
    paramsVersion: canvasParamsVersion, projectName: projectNameOf(sourceProjectId), held: false };
}

/** Save a stale tab's unsaved work as an inactive recovered copy, once: the
 * recoveryId makes a retry of the same request idempotent, and afterwards the
 * captured canvas counts as saved, so a later conflict doesn't copy it again.
 * Every send of the copy goes through here (Projects' load and Try again, a
 * params-version stop, following an agent's switch). A refusal a retry can't
 * fix (a 4xx other than 408/429) holds it for the person (holdRefusedEdits)
 * and throws EditsRefused; once held, it is never sent again. */
async function recoverPendingWork(): Promise<boolean> {
  const recovery = pendingRecovery;
  if (!recovery) return false;
  if (recovery.held) throw new EditsRefused();
  // A copy over the save limit would be refused (413): held without sending.
  if (projectSizeBytes(recovery.snapshot) > PROJECT_SAVE_LIMIT_BYTES) {
    holdRefusedEdits(recovery, null, EDITS_OVER_LIMIT);
    throw new EditsRefused();
  }
  try {
    await api.recoverProject(recovery.sourceProjectId, recovery.snapshot, recovery.recoveryId, recovery.paramsVersion);
  } catch (error) {
    if (pendingRecovery === recovery && refusedForGood(error)) {
      holdRefusedEdits(recovery, error);
      throw new EditsRefused();
    }
    throw error;
  }
  // Another send of the same copy (Retry) already finished it, and the tab
  // may have loaded a project since: "saved" is what that project holds now,
  // not this older canvas, so a late answer leaves it alone.
  if (pendingRecovery !== recovery) return true;
  pendingRecovery = null;
  lastSaved = JSON.stringify(recovery.snapshot);
  return true;
}

/** A reload resets this module's state in the app; tests share one module, so
 * each test starts from this. A handling of a params-version change still in
 * flight from an earlier test is superseded, so its late answer writes nothing. */
export function resetProjectStoreForTests(): void {
  initializing = null;
  saveQueue = Promise.resolve();
  cancelPendingSaves();
  lastSaved = '';
  inFlight = null;
  lastSeen = '';
  personChanges = foreignEdits = savedPersonChanges = savedForeignEdits = 0;
  syncBeingApplied = null;
  syncSaving = false;
  applying = false;
  projectViewport = null;
  pendingRecovery = null;
  heldEditsReopen = undefined;
  heldEditsCreate = undefined;
  sizeOffset = 0;
  resumePending = false;
  editsDownloaded = false;
  canvasParamsVersion = GRAPH_PARAMS_VERSION;
  paramsVersionChange = null;
  paramsHandling += 1;
  reloadingForParams = false;
  clearTimeout(relistTimer);
  relistFailures = 0;
  listingStale = false;
}

/** 'reload': first time for this version, marked. 'reloaded': the mark says
 * this tab already reloaded for it, so its build is older than the backend.
 * 'unmarked': sessionStorage is blocked, so a reload couldn't be told from a
 * repeat; the tab asks for one instead. */
function reloadOnceFor(backendVersion: number | null): 'reload' | 'reloaded' | 'unmarked' {
  try {
    const mark = String(backendVersion ?? 'unknown');
    if (window.sessionStorage.getItem(PARAMS_RELOAD_KEY) === mark) return 'reloaded';
    window.sessionStorage.setItem(PARAMS_RELOAD_KEY, mark);
    return 'reload';
  } catch { return 'unmarked'; }
}
function clearParamsReloadMark(): void {
  try { window.sessionStorage.removeItem(PARAMS_RELOAD_KEY); } catch { /* Nothing to clear. */ }
}

const PARAMS_UPDATED = 'Nebula was updated while this tab was open.';
/** The backend runs another params version than this bundle (graphSync, the
 * project listing or a 409 params_outdated said so). The tab's values may be
 * from before a one-time upgrade, and the backend refuses its saves and runs,
 * so: stop saving, save unsaved work once as a recovered copy (from the
 * version this canvas was loaded at), then reload to get the bundle that
 * matches. Never applies a project in this bundle: only a reload brings the
 * new definitions and upgrade rules. */
function handleParamsVersionChange(backendVersion: number | null): Promise<void> {
  if (paramsVersionChange) return paramsVersionChange;
  const handling = ++paramsHandling;
  const superseded = () => handling !== paramsHandling;
  paramsVersionChange = (async () => {
    // A refused Run isn't unsaved work. A backend that reported a version (or
    // refused with params_outdated: null) has the gate and refuses every start
    // from this bundle, so starts still waiting for an answer are left out
    // too; version 0 has no gate, so those may really run.
    if (!pendingRecovery) preserveWorkspaceConflict(PARAMS_UPDATED, runsThatNeverStarted(backendVersion !== 0));
    let recovered: boolean;
    try {
      recovered = await recoverPendingWork();
    } catch (error) {
      if (superseded()) return;
      paramsVersionChange = null;
      // Refused for good: the held edits' screen says it (holdRefusedEdits).
      if (error instanceof EditsRefused) return;
      // Try again sends the same recovered copy again (initialize does it first).
      const line = sentences(
        "Nebula was updated while this tab was open, and your unsaved edits haven't been saved yet.",
        reasonSentence(error, true), "Try again before you reload, or they'll be lost.");
      useProjectStore.setState({ error: line, errorDetails: detailsFor(line, error), errorRetry: { action: 'load' } });
      return;
    }
    if (superseded()) return;
    const kept = recovered ? ' Your unsaved edits were saved as a recovered project.' : ' Your saved work is kept.';
    useProjectStore.setState({ dirty: false });
    const newer = backendVersion === null || backendVersion > GRAPH_PARAMS_VERSION;
    const marked = newer ? reloadOnceFor(backendVersion) : null;
    // After a download the tab asks for the reload it would make (the
    // 'unmarked' line; the mark counts the person's reload): reloading now
    // would take away GM's line saying where the file went.
    const reload = marked === 'reload' && editsDownloaded ? 'unmarked' : marked;
    if (reload === 'reload') {
      reloadingForParams = true;
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Reloading it so it uses the update.${kept}`, errorRetry: null });
      reloadPage();
      return;
    }
    if (reload === 'unmarked') {
      // These lines ask for a reload (or a rebuild, a restart): Try again
      // would only check the versions again and show the same line.
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Reload the tab to use the update.${kept}`, errorRetry: null });
      return;
    }
    useProjectStore.setState({ errorRetry: null, error: newer
      ? `Nebula was updated, but this window still has the frontend from before the update, so it can't save or run. Rebuild the frontend (or restart the dev server), then reload.${kept}`
      : `This window's frontend is newer than the Nebula backend it is connected to, so it can't save or run. Restart the backend, then reload.${kept}` });
  })();
  return paramsVersionChange;
}

function cancelPendingSaves(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = null;
}

/** Whether a store update changed what the project saves (since the last
 * one looked at) to something not saved or being saved yet. `recheck` asks
 * only the second half: after a switch, rename or delete held the tab busy,
 * a change made meanwhile was seen but not yet marked. */
function unsavedChange(recheck = false): boolean {
  const state = useProjectStore.getState();
  if (applying || !state.initialized || !state.activeProject) return false;
  const now = JSON.stringify(captureProjectSnapshot());
  const changed = recheck || now !== lastSeen;
  lastSeen = now;
  return changed && now !== (inFlight ?? lastSaved);
}

/** The person's own change: "Unsaved changes", then a save once they have
 * paused for AUTOSAVE_MS. While the tab is busy (switching projects) it is
 * only counted; the switch saves first and looks again when it finishes. */
function markDirty(recheck = false): void {
  if (!unsavedChange(recheck)) return;
  personChanges += 1;
  if (useProjectStore.getState().busy) return;
  // While saving is paused the header keeps saying so; the wait below
  // measures the change again.
  useProjectStore.setState({ dirty: true, saveStatus: useProjectStore.getState().savePaused ? 'paused' : 'unsaved' });
  if (saveTimer !== null) clearTimeout(saveTimer);
  // The person's save takes along a canvas change still settling: its quiet
  // save must not go first and cut the person's wait short.
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = null;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  }, AUTOSAVE_MS);
}

/** Someone else's edit reached this tab (an agent's edit_canvas or `nebula
 * apply`, another window's, an outside app's). It came as one graphSync that
 * is already the whole change, coalesced where it was made, so there is
 * nothing to wait for: it reads "Saving…" from the moment it lands and saves
 * now, taking along anything of the person's still waiting. One save goes at
 * a time (saveQueue), and each captures the canvas when it starts, so a
 * second edit landing meanwhile saves next, newest state and all. A failed
 * save reads as one, and the unload prompt stays armed (dirty). */
function saveForeignEdit(): boolean {
  if (!unsavedChange()) return false;
  foreignEdits += 1;
  if (useProjectStore.getState().busy) return true;
  useProjectStore.setState({ dirty: true, saveStatus: useProjectStore.getState().savePaused ? 'paused' : 'saving' });
  // The save captures the canvas when it starts, after the whole sync is in.
  void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  return true;
}

/** A change the canvas made itself: its camera after an agent's nodes land
 * (the fit, an arrange's reveal) or the layout it wrote for them. It isn't
 * the person's edit, so it never reads "Unsaved changes" and never restarts
 * or extends the person's autosave wait: a save already waiting takes it
 * along, and otherwise it saves quietly once the canvas holds still, the
 * label keeping what it says. Until then the unload prompt still guards it. */
function saveCanvasChange(): void {
  if (!unsavedChange() || useProjectStore.getState().busy) return;
  if (!useProjectStore.getState().dirty) useProjectStore.setState({ dirty: true });
  if (saveTimer !== null) return;
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = setTimeout(() => {
    canvasTimer = null;
    void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  }, CANVAS_SETTLE_MS);
}

/** A change to what the project saves, from the graph or the camera: the
 * person's, unless it is part of a sync being applied (applyingSync). */
function noteChange(): void {
  if (syncBeingApplied === 'edit') {
    // Its save is asked for once; a later write of the same sync is only
    // looked at (lastSeen), so a measure after it isn't read as a new change.
    if (!syncSaving) syncSaving = saveForeignEdit();
    else unsavedChange();
  }
  else if (syncBeingApplied === 'canvas') saveCanvasChange();
  else markDirty();
}

/** A graphSync for the open project that is someone else's edit, or that
 * finishes an agent's arrange (the layout this or another canvas measured
 * and wrote: no `edit`, an `arranged` marker), is about to be applied: the
 * graph store does it next, in this same dispatch (wsClient hands every
 * handler the message at once), so what changes until this task's microtask
 * is that sync's, and saves the way its kind does (noteChange). Run results
 * and this tab's own echoes aren't tagged and stay the person's path. */
function applyingSync(event: { edit?: EditOrigin; arranged?: unknown }): void {
  const kind = event.edit && !isOwnEcho(event.edit, TAB_ID) ? 'edit' : !event.edit && event.arranged ? 'canvas' : null;
  if (!kind) return;
  syncBeingApplied = kind;
  syncSaving = false;
  void Promise.resolve().then(() => {
    syncBeingApplied = null;
    syncSaving = false;
  });
}

/** The canvas placed its own first camera (on mount: React Flow's start, or
 * its fit of a project saved without a view). That isn't an edit: when it is
 * all that differs from the last save, it joins what counts as saved, so a
 * project just opened or followed reads "Saved"; the next real change saves
 * it along. When more differs (an agent's first nodes, which bring this fit
 * on a canvas that opened empty), it saves with that, as the canvas's own. */
function adoptCanvasCamera(before: ProjectSnapshot['viewport']): void {
  const snapshot = captureProjectSnapshot();
  if (lastSaved && JSON.stringify({ ...snapshot, viewport: before }) === lastSaved) lastSaved = lastSeen = JSON.stringify(snapshot);
  else saveCanvasChange();
}

/** `retry` is what Try again redoes when this fails before an answer could
 * have changed anything: the same open or create. */
/** True once the project is open; `then` (a create's) waits with the held
 * edits when saving is paused with unsaved edits. */
async function activate(action: () => Promise<api.ProjectActivation>, retry: { action: 'open'; id: string } | { action: 'create'; name?: string },
  then?: () => Promise<void>): Promise<boolean> {
  const state = useProjectStore.getState();
  if (!state.initialized || state.busy) return false;
  const heading = retry.action === 'open' ? "Couldn't open the project." : "Couldn't create the project.";
  // A create's Try again keeps what was to follow it (Q120: the file loads).
  const offered: ProjectRetry = retry.action === 'create' && then ? { ...retry, then } : retry;
  const held = worldLabsHold(heading);
  if (held) { showError(held, offered); return false; }
  if (!useGraphStore.getState().canSwitchProject()) {
    showError(runStillGoing(heading), offered);
    return false;
  }
  useProjectStore.setState({ busy: true, error: null, errorRetry: null, editsSavedAs: null });
  let reserved = false;
  try {
    // The outgoing snapshot must be durable before the backend can replace it.
    await useProjectStore.getState().flush();
    // Saving is paused with edits the backend would refuse (Q118): they go to
    // #178's screen instead of being dropped, and the open or create runs
    // once the person has chosen (loadAfterHeldEdits).
    const context = getProjectContext();
    if (useProjectStore.getState().savePaused && useProjectStore.getState().dirty && context) {
      holdOverLimitEdits(context.id, captureProjectSnapshot(), true);
      // One action waits behind the screen: the latest the person asked for.
      if (retry.action === 'open') { heldEditsReopen = retry.id; heldEditsCreate = undefined; }
      else { heldEditsCreate = { name: retry.name, then }; heldEditsReopen = undefined; }
      return false;
    }
    const heldNow = worldLabsHold(heading);
    if (heldNow) throw heldNow;
    if (!useGraphStore.getState().canSwitchProject()) {
      throw runStillGoing(heading);
    }
    reserved = useGraphStore.getState().reserveGraphImport();
    if (!reserved) throw runStillGoing(heading);
    const result = await action();
    useGraphStore.getState().releaseGraphImport({ discardSuspended: true });
    reserved = false;
    const backendVersion = backendParamsVersion(result.paramsVersion);
    if (backendVersion !== GRAPH_PARAMS_VERSION) {
      // Not loaded: its values may be from before an upgrade (a backend that
      // sends no version predates the gate). The flush above saved the canvas.
      void handleParamsVersionChange(backendVersion);
      return false;
    }
    applyProject(result.project, result.workspaceRevision, false, heading);
    updateSummary(result.project);
    useProjectStore.setState({ screen: 'workspace' });
    // A canvas notice, not a window.alert (round 3f).
    if (result.warnings?.length) showNotice(`Opened.\n${result.warnings.map((line) => `• ${line}`).join('\n')}`, 'info');
    return true;
  } catch (error) {
    // A lost activation reply can follow a successful server commit. Re-read
    // on Retry instead of sending a second create/open or saving under an old
    // identity. Definite validation rejections retain the current workspace.
    //
    // Round 3b: an open is safe to finish, so its Try again reloads the saved
    // projects and then opens that project unless the first open already
    // landed (the reason line is the open's own: Try again redoes it). A
    // create isn't: a second one could make a second project, so its Try
    // again only reloads, and says so.
    if (reserved && !(error instanceof api.ProjectRequestError && error.status < 500)) {
      if (retry.action === 'open') {
        preserveWorkspaceConflict(failureMessage(error, "Couldn't open the project."), undefined, undefined,
          { action: 'load', reopen: retry.id });
      } else preserveWorkspaceConflict(sentences("Couldn't confirm the project change.", reasonSentence(error, true),
        TRY_AGAIN_CHECKS));
    } else showError(error, offered);
    return false;
  }
  finally {
    if (reserved) useGraphStore.getState().releaseGraphImport();
    useProjectStore.setState({ busy: false });
    markDirty(true);
  }
}

/** List the saved projects again, keeping whatever this tab has open. One
 * request at a time; changes that land meanwhile get one more. A tab with no
 * project open also takes the new workspace revision, so its next create or
 * open isn't refused as stale. */
function relistProjects(): Promise<void> {
  if (listing) { listAgain = true; return listing; }
  clearTimeout(relistTimer);
  listing = (async () => {
    try {
      do {
        listAgain = false;
        const generation = ++listingGeneration;
        const list = await api.listProjects();
        // The graphSync's own check handles a backend on another params version.
        if (generation !== listingGeneration || backendParamsVersion(list.paramsVersion) !== GRAPH_PARAMS_VERSION) continue;
        useProjectStore.setState((state) => {
          // The open project's card as listed now (a rename made elsewhere).
          const open = state.activeProject ? list.projects.find((project) => project.id === state.activeProject?.id) : undefined;
          return {
            projects: list.projects, trash: list.trash ?? [],
            ...(open ? { activeProject: open } : {}),
            ...(!state.activeProject && !getProjectContext() ? { workspaceRevision: list.workspaceRevision } : {}),
            ...(state.switchNotice ? { switchNotice: wayBackIn(state.switchNotice, list.projects) } : {}),
          };
        });
      } while (listAgain);
      relistFailures = 0;
    } catch {
      listingStale = true;
      if (relistFailures < 5 && useProjectStore.getState().screen === 'home') relistTimer = setTimeout(relistIfStale, 1000 * 2 ** relistFailures++);
    } finally { listing = null; }
  })();
  return listing;
}

/** The switch toast's way back, as the list has it now: renamed, or gone
 * when that project was deleted. */
function wayBackIn(notice: ProjectSwitchNotice, projects: ProjectSummary[]): ProjectSwitchNotice {
  if (!notice.previousProjectId) return notice;
  const previous = projects.find((project) => project.id === notice.previousProjectId);
  // The same notice when nothing changed: a new one restarts the toast's timer.
  if (previous?.name === notice.previousProjectName) return notice;
  return previous ? { ...notice, previousProjectName: previous.name }
    : { ...notice, previousProjectId: null, previousProjectName: null };
}

/** Let go of the loaded project: no context, an empty canvas, no Create
 * draft. Its saved copy is untouched; opening it again loads that. */
function releaseLoadedProject(): void {
  const sessionId = useUIStore.getState().createSessionId;
  applying = true;
  try {
    setProjectContext(null);
    useGraphStore.getState().loadProjectGraph([], [], []);
    useUIStore.getState().resetPanelsForFreshCanvas();
    projectViewport = null;
    useUIStore.setState({ createSessionId: null, canvasViewport: null });
  } finally { applying = false; }
  lastSaved = '';
  if (sessionId) useCreateDraftStore.setState((drafts) => {
    const { [sessionId]: _removed, ...rest } = drafts.drafts;
    void _removed;
    return { drafts: rest };
  });
  useProjectStore.setState({ activeProject: null, dirty: false, saveStatus: 'saved' });
  clearSavePause();
}

/** Load what the backend has open now (the listing and its active project).
 * Startup, Retry, and following an agent's switch all come through here. */
async function loadWorkspace(): Promise<void> {
  const set = useProjectStore.setState;
  const generation = ++listingGeneration;
  const list = await api.listProjects();
  // A listing without a version is from a backend older than the gate (0).
  const backendVersion = backendParamsVersion(list.paramsVersion);
  if (backendVersion !== GRAPH_PARAMS_VERSION) {
    await handleParamsVersionChange(backendVersion);
    return;
  }
  clearParamsReloadMark();
  if (generation === listingGeneration) set({ projects: list.projects, trash: list.trash ?? [] });
  set({ workspaceRevision: list.workspaceRevision });
  if (list.activeProjectId) {
    let project = await api.getProject(list.activeProjectId);
    // Adopt browser-only legacy run records exactly once during migration.
    // The backend's recovered graph is the authority for canvas contents.
    if (list.migratedProjectId === project.id) {
      const legacyHistory = loadRunHistory(window.localStorage);
      const sessionId = useUIStore.getState().createSessionId;
      project = await api.saveProject(project.id, {
        ...project.snapshot,
        runHistory: project.snapshot.runHistory.length ? project.snapshot.runHistory : legacyHistory,
        createSessionId: sessionId,
        createDraft: sessionId ? useCreateDraftStore.getState().drafts[sessionId] ?? null : null,
      }, list.workspaceRevision);
      // The project document is now durable; retire the global key so
      // reload cannot recreate an obsolete pre-project running owner.
      clearPersistedRunHistory(window.localStorage);
    }
    const graph = await fetchCLIGraph();
    if (graph.workspaceRevision && graph.workspaceRevision !== list.workspaceRevision) {
      // Try again sits beside the line and reloads the projects (WRAP).
      throw new FailureNotice(LOAD_HEADING, 'The active project changed while loading.');
    }
    applyProject(project, list.workspaceRevision, true);
    useGraphStore.getState().hydrateProviderRecoveries(graph.providerRecoveries ?? []);
    useGraphStore.getState().hydrateProviderStartAmbiguities(graph.providerStartAmbiguities ?? []);
    if (graph.executionStatuses) useGraphStore.getState().hydrateExecutionStatuses(graph.executionStatuses);
    // The graphSync a socket gets on connect arrives before this tab has a
    // project, so it's dropped; without this an agent's arrange made while
    // no canvas was open would wait for the next unrelated sync.
    useArrangeStore.getState().setPending(graph.arrange);
    void useGraphStore.getState().reconcilePersistedWorldLabsRun();
  } else {
    setProjectContext(null);
    // Forget the project a conflict left loaded, so Open of it goes
    // through the backend and applyProject instead of open()'s shortcut
    // to a canvas with no project context.
    set({ initialized: true, activeProject: null });
  }
}

/** What the toast says when an agent (or a script) switched the open project.
 * GM's lines (2026-10-24; the project is on screen, so "made" already says it
 * opened): "Claude Code opened “{name}”. Edits saved as a copy." / "Claude
 * Code made “{name}”. Edits saved as a copy." / made with no copy: "Claude
 * Code made “{name}”." Opened with no copy is unchanged ("Claude Code opened
 * “{name}”."); round 4b: "A long name can still wrap. That's fine for a
 * toast." The agent's name is whatever the switch carries. */
export function switchMessage(notice: ProjectSwitchNotice): string {
  const who = notice.actorName ?? 'An outside app';
  const name = `“${notice.projectName}”`;
  const what = notice.created ? `made ${name}` : `opened ${name}`;
  return notice.keptCopy ? `${who} ${what}. Edits saved as a copy.` : `${who} ${what}.`;
}

/** The held edits' screen came up because an agent's switch left the project
 * (followProjectSwitch): GM's line above it names the agent and the project
 * it opens (2026-10-24). A switch with no agent's name (a script) adds
 * nothing, and neither does one that found the screen already up for another
 * cause (the copy it held then is still the one on screen). */
function noteAgentOpening(notice: ProjectSwitch, alreadyHeld: boolean): void {
  const agent = notice.actor?.kind === 'agent' && typeof notice.actor.name === 'string' ? notice.actor.name : null;
  const held = useProjectStore.getState().unsavedEdits;
  if (!agent || !held || alreadyHeld) return;
  useProjectStore.setState({ unsavedEdits: { ...held, agentOpening: { agent, projectName: notice.projectName } } });
}

/** True when a graphSync's projectSwitch is the switch away from the project
 * this tab holds: an agent (or script) opened or made a project. */
function switchedAwayFrom(notice: ProjectSwitch | undefined, context: { id: string; revision: string }): notice is ProjectSwitch {
  return Boolean(notice && typeof notice.projectId === 'string' && typeof notice.projectName === 'string'
    && notice.previousRevision === context.revision && notice.previousProjectId === context.id);
}

/** Follow an agent's project switch instead of stopping the tab as if
 * another window took over (D4). `snapshot` was captured before the graph
 * store replaced the canvas; if it has changes the backend never saw (a pan,
 * a run record, a node only this tab has), they go into the project that was
 * open (the backend's handoff, open until the next switch), or into a
 * recovered copy if that fails. `context` is null for a tab on Projects with
 * no project open: nothing to save.
 * Then the tab loads what's open now, shows its canvas (from Projects too:
 * new_project and open_project say the person's canvas follows), and says
 * who switched it. */
async function followProjectSwitch(notice: ProjectSwitch, context: { id: string; revision: string } | null,
  snapshot: ProjectSnapshot | null, unsaved: boolean): Promise<void> {
  cancelPendingSaves();
  // Nothing else may save under the old project from here on.
  setProjectContext(null);
  // The held edits' screen already up (the person's own switch, say) keeps
  // its cause: this switch adds no agent line to it.
  const alreadyHeld = Boolean(useProjectStore.getState().unsavedEdits);
  useProjectStore.setState({ busy: true, error: null, errorRetry: null });
  let keptCopy = false;
  try {
    await saveQueue.catch(() => {});
    // Edits over the save limit (Q118) can't go into the project they came
    // from, nor into a recovered copy: held for the person's choice, unsent.
    if (unsaved && context && snapshot && projectSizeBytes(snapshot) + sizeOffset > PROJECT_SAVE_LIMIT_BYTES) {
      // The backend's switch already kept its live canvas in the project left.
      holdOverLimitEdits(context.id, snapshot, true);
      noteAgentOpening(notice, alreadyHeld);
      return;
    }
    if (unsaved && context && snapshot) {
      try {
        await api.saveProject(context.id, snapshot, context.revision);
      } catch {
        pendingRecovery = pendingRecoveryOf(context.id, snapshot);
        await recoverPendingWork();
        keptCopy = true;
      }
    }
    lastSaved = '';
    await loadWorkspace();
    // Loaded unless the backend is on another params version (that reloads).
    if (getProjectContext()) useProjectStore.setState({ screen: 'workspace' });
    const actor = notice.actor?.kind === 'agent' && typeof notice.actor.name === 'string' ? notice.actor.name : null;
    // An agent that reopened the project this tab was showing reloaded it
    // from what was saved: there's no other project to go back to.
    const reopened = notice.previousProjectId === notice.projectId;
    useProjectStore.setState({ switchNotice: {
      actorName: actor, created: notice.created === true, projectName: notice.projectName,
      previousProjectId: reopened ? null : notice.previousProjectId,
      previousProjectName: reopened ? null : notice.previousProjectName, keptCopy,
    } });
  } catch (error) {
    // Refused for good: the held edits' screen says it (holdRefusedEdits).
    if (error instanceof EditsRefused) { noteAgentOpening(notice, alreadyHeld); return; }
    const who = notice.actor?.name ?? 'Another app';
    // Try again loads what is open now (initialize), as the line says.
    const line = sentences(`${who} opened “${notice.projectName}”, but this window couldn't follow it.`,
      reasonSentence(error, true));
    useProjectStore.setState({ screen: 'home', initialized: false, dirty: Boolean(pendingRecovery),
      error: line, errorDetails: detailsFor(line, error), errorRetry: { action: 'load' } });
  } finally {
    useProjectStore.setState({ busy: false });
  }
}

/** List the saved projects now (Try again's own listing): counted with the
 * relists, so a quiet retry still out can't replace it. Throws on failure. */
async function listNow(): Promise<void> {
  const generation = ++listingGeneration;
  const list = await api.listProjects();
  if (generation === listingGeneration) {
    useProjectStore.setState((state) => ({ projects: list.projects, trash: list.trash ?? [],
      ...(!state.activeProject ? { workspaceRevision: list.workspaceRevision } : {}) }));
  }
}

/** Delete for good exactly `ids` (what the person saw in Recently deleted). */
async function emptyTrashOf(ids: string[]): Promise<void> {
  const set = useProjectStore.setState;
  if (useProjectStore.getState().busy) return;
  set({ busy: true, error: null, errorRetry: null });
  try {
    const trash = await api.emptyProjectTrash(ids);
    set({ trash, lastDeleted: null });
  } catch (error) { showError(error, { action: 'emptyTrash', ids }); }
  finally { set({ busy: false }); }
}

// Projects waits while the Commons holds unsaved labels (lib/commonsUnsaved).
export const useProjectStore = create<ProjectState>(holdCommonsExits<ProjectState>(holdProjects, (set, get) => ({
  screen: 'home', initialized: false, loading: true, busy: false,
  projects: [], activeProject: null, trash: [], lastDeleted: null, workspaceRevision: '', error: null, errorDetails: null,
  errorRetry: null, saveError: null, saveStatus: 'saved', dirty: false, switchNotice: null,
  unsavedEdits: null, editsSavedAs: null, savePaused: null, sizeNotice: null, sizePanelOpen: false,
  openSizePanel: () => { if (get().savePaused) set({ sizePanelOpen: true }); },
  closeSizePanel: () => set({ sizePanelOpen: false }),
  dismissSizeNotice: () => set({ sizeNotice: null }),
  noteLoadedGraph: (fileName, asNewProject = false) => {
    const state = get();
    if (!state.initialized || !state.activeProject || !getProjectContext()) return;
    const bytes = measured(JSON.stringify(captureProjectSnapshot()));
    if (bytes > PROJECT_SAVE_LIMIT_BYTES) pauseSaving(bytes, true, loadedNotice(fileName, bytes, asNewProject));
  },
  downloadProjectCopy: async () => {
    const project = get().activeProject;
    if (!project) return;
    try {
      await saveProjectCopyToFile(captureProjectSnapshot(), project.name);
    } catch (error) {
      console.error('[nebula] project copy download', error);
      // GM's heading (2026-10-25), the button's own words; past the string
      // cap the error carries "It's too big to download in a browser."
      showNotice(failureMessage(error, "Couldn't download a copy."));
    }
  },
  dismissSwitchNotice: () => set({ switchNotice: null }),
  switchBack: async () => {
    const back = get().switchNotice?.previousProjectId;
    if (!back) return;
    await get().open(back);
    if (get().activeProject?.id === back) set({ switchNotice: null });
  },
  pinCover: async (id, url) => {
    try {
      const project = await api.pinProjectCover(id, url);
      set((state) => ({
        projects: state.projects.map((item) => (item.id === id ? project : item)),
        ...(state.activeProject?.id === id ? { activeProject: project } : {}),
      }));
    } catch (error) { showError(error, { action: 'cover', id, url }); }
  },

  initialize: async () => {
    if (get().initialized) return;
    if (initializing) return initializing;
    set({ loading: true, error: null, errorRetry: null });
    initializing = (async () => {
      try {
        // A stale tab cannot write to its former active project. Persist its
        // unsaved authoring as an inactive recovered copy before replacement.
        await recoverPendingWork();
        await loadWorkspace();
      } catch (error) {
        // Refused for good: the held edits' screen says it (holdRefusedEdits).
        if (error instanceof EditsRefused) return;
        // Never strand the screen (round 3b review): until it loads, New
        // project and Open do nothing, so Try again always stays. A refusal
        // for good (the active project went away between the listing and its
        // read, a refused recovered copy) gets the reload form, with the
        // whole line, since Try again only reads the saved projects again.
        // An error's own message is never the line (round 3c-2): a written
        // failure keeps its heading and reason, anything else reads the
        // heading over GM's general line. While unsaved edits still wait for
        // their recovered copy it says the heading alone, as the params
        // reload does: the general line says "reload", which drops them.
        // A full disk is read from the answer (RequestFailedError.storageFull,
        // the backend's storage refusal), never from its words (round 3f).
        const copy = failureCopy(error, { heading: LOAD_HEADING });
        const general = copy.reason === REFUSED_FALLBACK_COPY;
        const reason = error instanceof RequestFailedError && error.storageFull ? LOAD_DISK_FULL
          : general ? LOAD_GENERAL : copy.reason;
        const line = oneLine({ heading: copy.heading, reason });
        const shown = pendingRecovery && general ? LOAD_HEADING : line;
        set({ error: shown, errorDetails: detailsFor(shown, error),
          errorRetry: refusedForGood(error) ? { action: 'load', full: true } : { action: 'load' } });
      }
      finally { set({ loading: false }); initializing = null; }
    })();
    return initializing;
  },
  open: async (id) => {
    const state = get();
    // Returning to an already loaded project is safe even during generation.
    if (state.initialized && !state.busy && id === state.activeProject?.id) {
      set({ screen: 'workspace', error: null, errorRetry: null });
      return;
    }
    await activate(() => api.openProject(id, get().workspaceRevision), { action: 'open', id });
  },
  createProject: async (name, then) => {
    // After activate's finally, so the load sees the project idle (not busy).
    if (await activate(() => api.createProject(name, get().workspaceRevision), { action: 'create', name }, then) && then) await then();
  },
  rename: async (id, name) => {
    if (get().busy) return;
    set({ busy: true, error: null, errorRetry: null });
    try {
      await get().flush();
      updateSummary(await api.renameProject(id, name));
    } catch (error) { showError(error, { action: 'rename', id, name }); }
    finally { set({ busy: false }); markDirty(true); }
  },
  remove: async (id) => {
    const state = get();
    if (!state.initialized || state.busy) return;
    const deletingActive = state.activeProject?.id === id;
    const held = deletingActive ? worldLabsHold("Couldn't delete the project.") : null;
    if (held) { showError(held, { action: 'delete', id }); return; }
    if (deletingActive && !useGraphStore.getState().canSwitchProject()) {
      showError(runStillGoing("Couldn't delete the project."), { action: 'delete', id });
      return;
    }
    set({ busy: true, error: null, errorRetry: null });
    let reserved = false;
    try {
      if (deletingActive) {
        // The open canvas is being thrown away, so don't save it first. Let any
        // save already in flight land, then hold the canvas so nothing else
        // writes to a project that is about to disappear.
        cancelPendingSaves();
        await saveQueue.catch(() => {});
        reserved = useGraphStore.getState().reserveGraphImport();
        if (!reserved) throw runStillGoing("Couldn't delete the project.");
      }
      const result = await api.deleteProject(id, get().workspaceRevision);
      if (deletingActive) {
        useGraphStore.getState().releaseGraphImport({ discardSuspended: true });
        reserved = false;
        releaseLoadedProject();
      }
      set((current) => ({
        projects: current.projects.filter((project) => project.id !== id),
        trash: [result.trashedProject, ...current.trash.filter((entry) => entry.id !== id)],
        lastDeleted: { id, name: result.trashedProject.name },
        workspaceRevision: result.workspaceRevision,
      }));
    } catch (error) {
      // As with switching: an unknown reply after the canvas was held may
      // follow a successful delete, so re-read instead of guessing.
      if (reserved && !(error instanceof api.ProjectRequestError && error.status < 500)) {
        // Round 3b: a second delete of the open project after an unknown
        // answer isn't small (it may be gone, or open elsewhere): Try again
        // reloads, as the line says.
        preserveWorkspaceConflict(sentences("Couldn't confirm the project was deleted.", reasonSentence(error, true),
          TRY_AGAIN_CHECKS));
      } else showError(error, { action: 'delete', id });
    } finally {
      if (reserved) useGraphStore.getState().releaseGraphImport();
      set({ busy: false });
      markDirty(true);
    }
  },
  restore: async (id) => {
    if (get().busy) return;
    set({ busy: true, error: null, errorRetry: null });
    try {
      const project = await api.restoreProject(id);
      set((current) => ({
        projects: [...current.projects.filter((item) => item.id !== id), project].sort(byRecentEdit),
        trash: current.trash.filter((entry) => entry.id !== id),
        lastDeleted: current.lastDeleted?.id === id ? null : current.lastDeleted,
      }));
    } catch (error) {
      // A 404 means it expired or was purged elsewhere: stop offering it.
      if (error instanceof api.ProjectRequestError && error.status === 404) {
        set((current) => ({ trash: current.trash.filter((entry) => entry.id !== id),
          lastDeleted: current.lastDeleted?.id === id ? null : current.lastDeleted }));
      }
      showError(error, { action: 'restore', id });
    } finally { set({ busy: false }); }
  },
  purge: async (id) => {
    if (get().busy) return;
    set({ busy: true, error: null, errorRetry: null });
    try {
      const trash = await api.purgeTrashedProject(id);
      set((current) => ({ trash, lastDeleted: current.lastDeleted?.id === id ? null : current.lastDeleted }));
    } catch (error) { showError(error, { action: 'purge', id }); }
    finally { set({ busy: false }); }
  },
  emptyTrash: async () => emptyTrashOf(get().trash.map((entry) => entry.id)),
  dismissUndo: () => set({ lastDeleted: null }),
  goHome: async () => {
    // The person's own way to Projects: refused, as the corner's Review is.
    refuseWhileCommonsUnsaved();
    if (get().busy) return;
    set({ screen: 'home', error: null, errorRetry: null });
    useUIStore.setState({ onboardingActive: false, isPlaying: false });
    relistFailures = 0;
    relistIfStale();
    try { await get().flush(); } catch { /* Home keeps the canvas and visible retry. */ }
  },
  flush: async () => {
    cancelPendingSaves();
    const task = saveQueue.catch(() => {}).then(async (): Promise<boolean> => {
      const state = get();
      const context = getProjectContext();
      if (!state.initialized || !state.activeProject || !context) return false;
      const snapshot = captureProjectSnapshot();
      const fingerprint = JSON.stringify(snapshot);
      // Over the save limit (Q118): measured before sending, so nothing is
      // sent; it saves again by itself once it is at the limit or under.
      const bytes = measured(fingerprint);
      if (bytes > PROJECT_SAVE_LIMIT_BYTES) {
        pauseSaving(bytes, fingerprint !== lastSaved);
        return false;
      }
      const wasPaused = state.savePaused !== null || resumePending;
      // Nothing to send, e.g. an edit undone before autosave fired. Mark it
      // clean too, or the re-flush below would keep finding it dirty forever.
      if (fingerprint === lastSaved) {
        if (state.dirty || wasPaused) set({ dirty: false, saveStatus: 'saved' });
        if (wasPaused) resumeSaving(bytes);
        return false;
      }
      // Offline: held, not sent and not a refused edit (no pulse); it goes
      // when Nebula answers again (the subscriber at the end of this file).
      if (isBackendOffline()) {
        set({ dirty: true, saveStatus: state.savePaused ? 'paused' : 'unsaved' });
        return false;
      }
      const captured = { person: personChanges, foreign: foreignEdits };
      // Only the canvas's own changes since the last save (saveCanvasChange):
      // "Saved" stays as it is while they go.
      const quiet = state.saveStatus === 'saved'
        && captured.person === savedPersonChanges && captured.foreign === savedForeignEdits;
      if (!quiet) set({ saveStatus: 'saving' });
      inFlight = fingerprint;
      try {
        const saved = await api.saveProject(context.id, snapshot, context.revision);
        if (getProjectContext()?.revision !== context.revision) return false;
        lastSaved = fingerprint;
        savedPersonChanges = captured.person;
        savedForeignEdits = captured.foreign;
        if (holdsPersonCredential()) projectViewport = snapshot.viewport ?? null;
        updateSummary(saved);
        if (get().saveError) set({ saveError: null });
        sizeOffset = 0;
        if (wasPaused) resumeSaving(bytes);
        if (JSON.stringify(captureProjectSnapshot()) === lastSaved) {
          set({ dirty: false, saveStatus: 'saved' });
          return true;
        }
        // Something changed while the request was out. The person's change
        // reads "Unsaved changes" as always; another edit that landed has its
        // save queued already. What only the canvas changed (its fit still
        // running) saves when it settles, or now if it already has.
        if (personChanges !== captured.person) {
          set({ dirty: true, saveStatus: 'unsaved' });
          markDirty(true);
          return true;
        }
        if (foreignEdits !== captured.foreign) {
          set({ dirty: true, saveStatus: 'saving' });
          return true;
        }
        set({ dirty: true, saveStatus: 'saved' });
        return canvasTimer === null;
      } catch (error) {
        // Offline (round 15): nothing was sent. Not a failed save: it stays
        // "Unsaved changes" and saves by itself once Nebula answers again.
        if (isOfflineRefusal(error)) {
          set({ dirty: true, saveStatus: state.savePaused ? 'paused' : 'unsaved' });
          return false;
        }
        // The backend counted it over the limit (Q118): paused on its number,
        // not a failed save.
        if (error instanceof RequestFailedError && error.overSaveLimit
          && getProjectContext()?.revision === context.revision) {
          const counted = Math.max(error.sizeBytes ?? 0, PROJECT_SAVE_LIMIT_BYTES + 1);
          sizeOffset = Math.max(0, counted - (bytes - sizeOffset));
          pauseSaving(counted, true);
          return false;
        }
        // Measured at the limit or under, so a pause ends here: the header
        // reads "Save failed · Retry" and the next edit "Unsaved changes",
        // never "Saving paused" for a project under the limit, and a paused
        // notice's "See what's large" goes with the panel (review).
        if (wasPaused) resumePending = true;
        const notice = get().sizeNotice;
        set({ dirty: true, saveStatus: 'error', saveError: failureMessage(error, "Couldn't save the project."),
          ...(state.savePaused ? { savePaused: null, sizePanelOpen: false, ...(notice?.action ? { sizeNotice: null } : {}) } : {}) });
        showError(error, { action: 'save' });
        throw error;
      } finally { inFlight = null; }
    });
    saveQueue = task;
    // An edit that landed during the request also belongs to the outgoing project.
    // Only a save that landed can make progress; any other exit re-flushing
    // while dirty would spin forever.
    if (await task && get().dirty && get().saveStatus !== 'error') await get().flush();
  },
  retry: async () => {
    const failed = get().errorRetry;
    set({ error: null, errorRetry: null });
    switch (failed?.action) {
      case 'save': return get().retrySave();
      case 'open': return get().open(failed.id);
      case 'create': return get().createProject(failed.name, failed.then);
      case 'rename': return get().rename(failed.id, failed.name);
      case 'cover': return get().pinCover(failed.id, failed.url);
      case 'delete': case 'restore': case 'purge': case 'emptyTrash': {
        // Its answer may have been lost after it landed: look first, and
        // redo it only on what is still where the person saw it.
        try { await listNow(); } catch (error) { showError(error, failed); return; }
        const listed = get().projects.some((project) => project.id === (failed as { id?: string }).id);
        const inTrash = (id: string) => get().trash.find((entry) => entry.id === id);
        if (failed.action === 'delete') {
          if (listed) return get().remove(failed.id);
          const gone = inTrash(failed.id);
          if (gone) set({ lastDeleted: { id: gone.id, name: gone.name } });
          return;
        }
        if (failed.action === 'restore') return inTrash(failed.id) ? get().restore(failed.id) : undefined;
        if (failed.action === 'purge') return inTrash(failed.id) ? get().purge(failed.id) : undefined;
        const ids = failed.ids.filter((id) => inTrash(id));
        return ids.length ? emptyTrashOf(ids) : undefined;
      }
      default: break;
    }
    // 'load' and 'list' (and a caller with nothing recorded): read the saved
    // projects again. A params-version stop is checked again from the
    // listing, and the one under way (its recovered copy may still be in
    // flight) is superseded.
    if (!reloadingForParams) {
      paramsVersionChange = null;
      paramsHandling += 1;
    }
    if (!get().initialized) await get().initialize();
    else {
      try {
        await get().flush();
        await listNow();
      } catch (error) { showError(error, { action: 'list' }); }
    }
    // An open whose reply was lost: finish it, unless it already landed.
    const reopen = failed?.action === 'load' ? failed.reopen : undefined;
    // Held edits stopped it: it finishes once the person has chosen.
    if (get().unsavedEdits) { heldEditsReopen ??= reopen; return; }
    if (!reopen || get().error || !get().initialized) return;
    if (get().activeProject?.id === reopen && getProjectContext()) set({ screen: 'workspace' });
    else await get().open(reopen);
  },
  downloadUnsavedEdits: async () => {
    const recovery = pendingRecovery;
    if (!recovery?.held || get().busy) return;
    set({ busy: true });
    let savedAs: SavedEditsFile | null = null;
    let failed = false;
    let tooBig = false;
    try {
      savedAs = await saveEditsToFile(recovery.snapshot, recovery.projectName);
    } catch (error) {
      // Past the browser's string cap (#190's case): nothing was written, and
      // trying again can't help; GM's line says why (2026-10-25).
      tooBig = error instanceof BrowserStringLimitError;
      // A file that couldn't be written at all (a full disk, a write the
      // browser refused; the writer only falls back to a plain download when
      // the picker itself fails, before a file was chosen). GM's line 2 says
      // so; the two choices stay, with the copy still held (Q116 a).
      failed = true;
      console.error('[nebula] unsaved edits download', error);
    } finally { set({ busy: false }); }
    if (savedAs === null) {
      // A failed write says GM's line 2; a cancelled save picker goes back to
      // the two choices with no line. Nothing is lost either way.
      const held = get().unsavedEdits;
      if (pendingRecovery === recovery && held) {
        // Everything else on the screen stays (the confirm's project, the agent's line).
        const { downloadFailed: _was, downloadTooBig: _big, ...kept } = held;
        void _was;
        void _big;
        set({ unsavedEdits: tooBig ? { ...kept, downloadTooBig: true } : failed ? { ...kept, downloadFailed: true } : kept });
      }
      return;
    }
    if (pendingRecovery !== recovery) return;
    editsDownloaded = true;
    letGoOfHeldEdits(recovery, savedAs);
    await loadAfterHeldEdits();
  },
  continueWithoutEdits: async () => {
    const recovery = pendingRecovery;
    if (!recovery?.held || get().busy) return;
    letGoOfHeldEdits(recovery);
    await loadAfterHeldEdits();
  },
  retrySave: async () => {
    if (get().errorRetry?.action === 'save') set({ error: null, errorRetry: null });
    try { await get().flush(); } catch { /* The failed save shows again (saveStatus 'error'). */ }
  },
})));

// "This project" for Characters, Moodboards and Styles follows the open
// canvas project (lib/currentProject): this store is its only source.
useProjectStore.subscribe((state) => publishOpenProject(currentProjectOf(state)));

/** One coordinator stays mounted across Home, Canvas and all studios. */
export function subscribeProjectAutosave(): () => void {
  const graph = useGraphStore.subscribe((state, previous) => {
    if (state.nodes !== previous.nodes || state.edges !== previous.edges || state.runHistory !== previous.runHistory) noteChange();
  });
  const ui = useUIStore.subscribe((state, previous) => {
    // The marks stay until the next setCanvasViewport; a camera cleared by a
    // graph replacement (null) is never the canvas's own.
    const moved = state.canvasViewport !== previous.canvasViewport;
    if (moved && state.canvasViewport && state.canvasViewportInitial) adoptCanvasCamera(previous.canvasViewport);
    else if (moved && state.canvasViewport && state.canvasViewportByCanvas) saveCanvasChange();
    else if (moved || state.createSessionId !== previous.createSessionId) noteChange();
  });
  const drafts = useCreateDraftStore.subscribe(() => markDirty());
  // First, so it sees the canvas before the graph store swaps in the new graph.
  const socket = wsClient.subscribeFirst((event) => {
    if (event.type === 'projectsChanged') {
      const state = useProjectStore.getState();
      // The toast's way back shows on the canvas too: a change to that
      // project (renamed, deleted) is listed now, not on the next visit.
      const wayBack = state.switchNotice?.previousProjectId;
      // The open project renamed elsewhere (an agent's rename_project, another
      // tab): the canvas header follows now.
      const openRenamed = event.change === 'renamed' && !!event.projectId && event.projectId === state.activeProject?.id;
      if ((state.screen === 'home' || (wayBack && event.projectId === wayBack) || openRenamed) && !paramsVersionChange) void relistProjects();
      if (state.screen !== 'home') listingStale = true;
      return;
    }
    if (event.type !== 'graphSync') return;
    // A reconnect starts with one: a listing that failed meanwhile goes again.
    relistIfStale();
    // A sync without a version is from a backend older than the gate (0).
    const paramsVersion = backendParamsVersion((event as unknown as { paramsVersion?: unknown }).paramsVersion);
    if (paramsVersion !== GRAPH_PARAMS_VERSION) {
      // Checked before the revision: an upgrade also rotates it, and this tab
      // must reload rather than offer to load the project in this bundle.
      void handleParamsVersionChange(paramsVersion);
      return;
    }
    const revision = (event as unknown as { workspaceRevision?: string }).workspaceRevision;
    const context = getProjectContext();
    const state = useProjectStore.getState();
    if (!revision || state.busy) return;
    if (!context) {
      // Projects with no project open (a first run, or the open one was
      // deleted): an agent's new_project or open_project from the workspace
      // this tab listed opens it here too.
      const notice = event.projectSwitch;
      if (state.initialized && !state.activeProject && revision !== state.workspaceRevision
        && notice && typeof notice.projectId === 'string' && typeof notice.projectName === 'string'
        && notice.previousRevision === state.workspaceRevision) {
        void followProjectSwitch(notice, null, null, false);
      } else if (state.initialized && state.screen === 'home' && revision !== state.workspaceRevision) {
        // A revision this tab never listed: the socket missed the changes
        // (the sync a reconnect starts with), so list again.
        void relistProjects();
      }
      return;
    }
    if (revision === context.revision) {
      // A change to the open project: an agent's edit saves at once.
      applyingSync(event as { edit?: EditOrigin; arranged?: unknown });
      return;
    }
    const snapshot = captureProjectSnapshot();
    const unsaved = JSON.stringify(snapshot) !== lastSaved;
    // An agent or script opened or made a project: follow it, with a way back.
    if (switchedAwayFrom(event.projectSwitch, context)) {
      void followProjectSwitch(event.projectSwitch, context, snapshot, unsaved);
      return;
    }
    // On Projects with everything saved there is nothing to protect: let go
    // of the project still loaded from before (another window opened another
    // one, or it was deleted) instead of stopping the screen with a conflict.
    if (state.screen === 'home' && !unsaved && useGraphStore.getState().canSwitchProject()) {
      releaseLoadedProject();
      void relistProjects();
      return;
    }
    // The person changed the active project in another tab. Keep our local
    // canvas available but stop saves and require a fresh, explicit choice from Home.
    preserveWorkspaceConflict(unsaved
      ? 'The active project changed in another window. Try again to save your unsaved edits as a recovered project.'
      : 'The active project changed in another window. Reload projects to continue.', undefined, snapshot);
  });
  const outdated = onParamsOutdated((backendVersion) => { void handleParamsVersionChange(backendVersion); });
  for (const type of ['focus', 'online']) window.addEventListener(type, relistIfStale);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (reloadingForParams || !useProjectStore.getState().dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    graph(); ui(); drafts(); socket(); outdated(); clearTimeout(relistTimer);
    window.removeEventListener('beforeunload', beforeUnload);
    for (const type of ['focus', 'online']) window.removeEventListener(type, relistIfStale);
    cancelPendingSaves();
  };
}

// Back online (round 15): a save the offline gate held goes now.
subscribeBackendConnection(() => {
  const project = useProjectStore.getState();
  if (isBackendOffline() || !project.dirty || project.saveStatus === 'error') return;
  void project.flush().catch(() => { /* Visible retry state. */ });
});
