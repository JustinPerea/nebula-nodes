import { create } from 'zustand';
import { runsThatNeverStarted, useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { readDraft, useCreateDraftStore } from './createDraftStore';
import { useArrangeStore } from './arrangeStore';
import { fetchCLIGraph } from '../lib/api';
import { rewriteBackendAssetUrls } from '../lib/backend';
import { normalizeRuntimeMediaParams } from '../lib/graphFile';
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

interface ProjectState {
  screen: 'home' | 'workspace';
  initialized: boolean; loading: boolean; busy: boolean;
  projects: ProjectSummary[]; activeProject: ProjectSummary | null;
  /** Recently deleted, newest first. Restorable until each entry's purgeAt. */
  trash: TrashedProject[];
  /** The project the Undo toast offers to bring back. */
  lastDeleted: { id: string; name: string } | null;
  workspaceRevision: string; error: string | null;
  saveStatus: 'saved' | 'saving' | 'unsaved' | 'error'; dirty: boolean;
  /** The last switch this tab followed (an agent's), for the toast. */
  switchNotice: ProjectSwitchNotice | null;
  dismissSwitchNotice: () => void;
  /** Back to the project that was open before the switch in switchNotice. */
  switchBack: () => Promise<void>;
  /** Pin one of a project's images as its card cover, or null for automatic. */
  pinCover: (id: string, url: string | null) => Promise<void>;
  initialize: () => Promise<void>;
  open: (id: string) => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  dismissUndo: () => void;
  goHome: () => Promise<void>;
  flush: () => Promise<void>;
  retry: () => Promise<void>;
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
let pendingRecovery: { sourceProjectId: string; snapshot: ProjectSnapshot; recoveryId: string; paramsVersion: number } | null = null;
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
 * own immutable copy, including nested Paper recipes and run history. */
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
  return JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
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

function applyProject(project: SavedProject, revision: string, bootstrap = false): void {
  applying = true;
  const previous = getProjectContext();
  try {
    setProjectContext({ id: project.id, revision });
    canvasParamsVersion = GRAPH_PARAMS_VERSION;
    const snapshot = rewriteBackendAssetUrls(project.snapshot);
    if (!useGraphStore.getState().loadProjectGraph(snapshot.nodes, snapshot.edges, snapshot.runHistory, { bootstrap })) {
      setProjectContext(previous);
      throw new Error('The current canvas is still busy. Finish or stop its run before switching projects.');
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
    pendingRecovery = null;
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
      initialized: true, dirty: false, saveStatus: 'saved', error: null,
    });
    lastSaved = JSON.stringify(captureProjectSnapshot());
    lastSeen = lastSaved;
    savedPersonChanges = personChanges;
    savedForeignEdits = foreignEdits;
  } finally { applying = false; }
}

function showError(error: unknown): void {
  useProjectStore.setState({ error: error instanceof Error ? error.message : 'Could not save the project.' });
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
function preserveWorkspaceConflict(message: string, neverRan?: Set<string>, captured?: ProjectSnapshot): void {
  cancelPendingSaves();
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
  if (dirty && context) pendingRecovery = {
    sourceProjectId: context.id, snapshot, recoveryId: crypto.randomUUID().replaceAll('-', ''),
    paramsVersion: canvasParamsVersion,
  };
  useProjectStore.setState({ screen: 'home', initialized: false, loading: false, dirty, error: message });
}
/** Save a stale tab's unsaved work as an inactive recovered copy, once: the
 * recoveryId makes a retry of the same request idempotent, and afterwards the
 * captured canvas counts as saved, so a later conflict doesn't copy it again. */
async function recoverPendingWork(): Promise<boolean> {
  const recovery = pendingRecovery;
  if (!recovery) return false;
  await api.recoverProject(recovery.sourceProjectId, recovery.snapshot, recovery.recoveryId, recovery.paramsVersion);
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
      const reason = error instanceof Error ? error.message : 'the backend did not answer';
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Your unsaved edits couldn't be saved as a recovered project yet (${reason}). Try again before reloading.` });
      return;
    }
    if (superseded()) return;
    const kept = recovered ? ' Your unsaved edits were saved as a recovered project.' : ' Your saved work is kept.';
    useProjectStore.setState({ dirty: false });
    const newer = backendVersion === null || backendVersion > GRAPH_PARAMS_VERSION;
    const reload = newer ? reloadOnceFor(backendVersion) : null;
    if (reload === 'reload') {
      reloadingForParams = true;
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Reloading it so it uses the update.${kept}` });
      reloadPage();
      return;
    }
    if (reload === 'unmarked') {
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Reload the tab to use the update.${kept}` });
      return;
    }
    useProjectStore.setState({ error: newer
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
  useProjectStore.setState({ dirty: true, saveStatus: 'unsaved' });
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
  useProjectStore.setState({ dirty: true, saveStatus: 'saving' });
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

async function activate(action: () => Promise<api.ProjectActivation>): Promise<void> {
  const state = useProjectStore.getState();
  if (!state.initialized || state.busy) return;
  if (!useGraphStore.getState().canSwitchProject()) {
    showError(new Error('Finish or stop the current run and let pending edits finish before switching projects.'));
    return;
  }
  useProjectStore.setState({ busy: true, error: null });
  let reserved = false;
  try {
    // The outgoing snapshot must be durable before the backend can replace it.
    await useProjectStore.getState().flush();
    if (!useGraphStore.getState().canSwitchProject()) {
      throw new Error('The canvas became busy. Let pending edits and runs finish before switching projects.');
    }
    reserved = useGraphStore.getState().reserveGraphImport();
    if (!reserved) throw new Error('The canvas became busy. Try again when its run finishes.');
    const result = await action();
    useGraphStore.getState().releaseGraphImport({ discardSuspended: true });
    reserved = false;
    const backendVersion = backendParamsVersion(result.paramsVersion);
    if (backendVersion !== GRAPH_PARAMS_VERSION) {
      // Not loaded: its values may be from before an upgrade (a backend that
      // sends no version predates the gate). The flush above saved the canvas.
      void handleParamsVersionChange(backendVersion);
      return;
    }
    applyProject(result.project, result.workspaceRevision);
    updateSummary(result.project);
    useProjectStore.setState({ screen: 'workspace' });
    if (result.warnings?.length) alert(`Opened.\n${result.warnings.map((line) => `• ${line}`).join('\n')}`);
  } catch (error) {
    // A lost activation reply can follow a successful server commit. Re-read
    // on Retry instead of sending a second create/open or saving under an old
    // identity. Definite validation rejections retain the current workspace.
    if (reserved && !(error instanceof api.ProjectRequestError && error.status < 500)) {
      preserveWorkspaceConflict('Could not confirm the project change. Try again to reload saved projects safely.');
    } else showError(error);
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
      throw new Error('The active project changed while loading. Try again to reload projects.');
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

/** What the toast says when an agent (or a script) switched the open project. */
export function switchMessage(notice: ProjectSwitchNotice): string {
  const who = notice.actorName ?? 'An outside app';
  const what = notice.created ? `made a new project, “${notice.projectName}”, and opened it` : `opened “${notice.projectName}”`;
  const kept = notice.keptCopy ? ' Your last unsaved changes were kept as a copy in Projects.' : '';
  return `${who} ${what}.${kept}`;
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
  useProjectStore.setState({ busy: true, error: null });
  let keptCopy = false;
  try {
    await saveQueue.catch(() => {});
    if (unsaved && context && snapshot) {
      try {
        await api.saveProject(context.id, snapshot, context.revision);
      } catch {
        pendingRecovery = { sourceProjectId: context.id, snapshot, recoveryId: crypto.randomUUID().replaceAll('-', ''),
          paramsVersion: canvasParamsVersion };
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
    const who = notice.actor?.name ?? 'Another app';
    const reason = error instanceof Error ? ` (${error.message})` : '';
    useProjectStore.setState({ screen: 'home', initialized: false, dirty: Boolean(pendingRecovery),
      error: `${who} opened “${notice.projectName}”, but this window couldn't follow${reason}. Try again to load it.` });
  } finally {
    useProjectStore.setState({ busy: false });
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  screen: 'home', initialized: false, loading: true, busy: false,
  projects: [], activeProject: null, trash: [], lastDeleted: null, workspaceRevision: '', error: null,
  saveStatus: 'saved', dirty: false, switchNotice: null,
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
    } catch (error) { showError(error); }
  },

  initialize: async () => {
    if (get().initialized) return;
    if (initializing) return initializing;
    set({ loading: true, error: null });
    initializing = (async () => {
      try {
        // A stale tab cannot write to its former active project. Persist its
        // unsaved authoring as an inactive recovered copy before replacement.
        await recoverPendingWork();
        await loadWorkspace();
      } catch (error) { showError(error); }
      finally { set({ loading: false }); initializing = null; }
    })();
    return initializing;
  },
  open: async (id) => {
    const state = get();
    // Returning to an already loaded project is safe even during generation.
    if (state.initialized && !state.busy && id === state.activeProject?.id) {
      set({ screen: 'workspace', error: null });
      return;
    }
    await activate(() => api.openProject(id, get().workspaceRevision));
  },
  createProject: async (name) => activate(() => api.createProject(name, get().workspaceRevision)),
  rename: async (id, name) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      await get().flush();
      updateSummary(await api.renameProject(id, name));
    } catch (error) { showError(error); }
    finally { set({ busy: false }); markDirty(true); }
  },
  remove: async (id) => {
    const state = get();
    if (!state.initialized || state.busy) return;
    const deletingActive = state.activeProject?.id === id;
    if (deletingActive && !useGraphStore.getState().canSwitchProject()) {
      showError(new Error('Finish or stop the current run before deleting the open project.'));
      return;
    }
    set({ busy: true, error: null });
    let reserved = false;
    try {
      if (deletingActive) {
        // The open canvas is being thrown away, so don't save it first. Let any
        // save already in flight land, then hold the canvas so nothing else
        // writes to a project that is about to disappear.
        cancelPendingSaves();
        await saveQueue.catch(() => {});
        reserved = useGraphStore.getState().reserveGraphImport();
        if (!reserved) throw new Error('The canvas became busy. Try again when its run finishes.');
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
        preserveWorkspaceConflict('Could not confirm the project was deleted. Try again to reload saved projects safely.');
      } else showError(error);
    } finally {
      if (reserved) useGraphStore.getState().releaseGraphImport();
      set({ busy: false });
      markDirty(true);
    }
  },
  restore: async (id) => {
    if (get().busy) return;
    set({ busy: true, error: null });
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
      showError(error);
    } finally { set({ busy: false }); }
  },
  purge: async (id) => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const trash = await api.purgeTrashedProject(id);
      set((current) => ({ trash, lastDeleted: current.lastDeleted?.id === id ? null : current.lastDeleted }));
    } catch (error) { showError(error); }
    finally { set({ busy: false }); }
  },
  emptyTrash: async () => {
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const trash = await api.emptyProjectTrash(get().trash.map((entry) => entry.id));
      set({ trash, lastDeleted: null });
    } catch (error) { showError(error); }
    finally { set({ busy: false }); }
  },
  dismissUndo: () => set({ lastDeleted: null }),
  goHome: async () => {
    if (get().busy) return;
    set({ screen: 'home', error: null });
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
      // Nothing to send, e.g. an edit undone before autosave fired. Mark it
      // clean too, or the re-flush below would keep finding it dirty forever.
      if (fingerprint === lastSaved) {
        if (state.dirty) set({ dirty: false, saveStatus: 'saved' });
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
        set({ dirty: true, saveStatus: 'error' });
        showError(error);
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
    set({ error: null });
    // A params-version stop is checked again from the listing, and the one
    // under way (its recovered copy may still be in flight) is superseded.
    if (!reloadingForParams) {
      paramsVersionChange = null;
      paramsHandling += 1;
    }
    if (!get().initialized) await get().initialize();
    else {
      try {
        await get().flush();
        // Counted with the relists, so a quiet retry still out can't replace it.
        const generation = ++listingGeneration;
        const list = await api.listProjects();
        if (generation === listingGeneration) {
          set({ projects: list.projects, trash: list.trash ?? [], ...(!get().activeProject ? { workspaceRevision: list.workspaceRevision } : {}) });
        }
      } catch (error) { showError(error); }
    }
  },
}));

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
