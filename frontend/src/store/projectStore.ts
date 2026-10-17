import { create } from 'zustand';
import { runsThatNeverStarted, useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { readDraft, useCreateDraftStore } from './createDraftStore';
import { fetchCLIGraph } from '../lib/api';
import { rewriteBackendAssetUrls } from '../lib/backend';
import { normalizeRuntimeMediaParams } from '../lib/graphFile';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { getProjectContext, setProjectContext } from '../lib/projectContext';
import { backendParamsVersion, onParamsOutdated, reloadPage } from '../lib/paramsOutdated';
import { clearPersistedRunHistory, loadRunHistory } from '../lib/runHistory';
import * as api from '../lib/projects';
import { wsClient } from '../lib/wsClient';
import type { ProjectSnapshot, ProjectSummary, SavedProject, TrashedProject } from '../lib/projects';

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
let lastSaved = '';
let applying = false;
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
/** Set when the tab reloads for a params upgrade, so the unsaved-changes
 * prompt doesn't stop a reload whose edits are already in a recovered copy. */
let reloadingForParams = false;
/** The backend version this tab already reloaded for (sessionStorage), so a
 * window whose frontend build is still older after a reload stops instead of
 * reloading again. */
const PARAMS_RELOAD_KEY = 'nebula:paramsReloadedFor';

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
    viewport: ui.canvasViewport,
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
    const sessionId = snapshot.createSessionId ?? `project:${project.id}:create`;
    const draft = readDraft(snapshot.createDraft);
    if (draft) {
      useCreateDraftStore.setState((state) => ({ drafts: {
        ...state.drafts, [sessionId]: structuredClone(draft),
      } }));
    }
    useUIStore.getState().resetPanelsForFreshCanvas();
    useUIStore.setState({ viewMode: 'canvas', createSessionId: sessionId, canvasViewport: snapshot.viewport,
      commonsReturnView: 'canvas' });
    useProjectStore.setState({
      activeProject: summary(project), workspaceRevision: revision,
      initialized: true, dirty: false, saveStatus: 'saved', error: null,
    });
    lastSaved = JSON.stringify(captureProjectSnapshot());
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
function preserveWorkspaceConflict(message: string, neverRan?: Set<string>): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  const context = getProjectContext();
  let snapshot = captureProjectSnapshot();
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
  if (pendingRecovery === recovery) pendingRecovery = null;
  lastSaved = JSON.stringify(recovery.snapshot);
  return true;
}

/** A reload resets these in the app; tests share one module. */
export function resetParamsVersionChangeForTests(): void {
  paramsVersionChange = null;
  reloadingForParams = false;
  pendingRecovery = null;
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
      paramsVersionChange = null;
      const reason = error instanceof Error ? error.message : 'the backend did not answer';
      useProjectStore.setState({ error: `${PARAMS_UPDATED} Your unsaved edits couldn't be saved as a recovered project yet (${reason}). Try again before reloading.` });
      return;
    }
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

function markDirty(): void {
  const state = useProjectStore.getState();
  if (applying || !state.initialized || !state.activeProject || state.busy) return;
  if (JSON.stringify(captureProjectSnapshot()) === lastSaved) return;
  useProjectStore.setState({ dirty: true, saveStatus: 'unsaved' });
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  }, 600);
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
    markDirty();
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  screen: 'home', initialized: false, loading: true, busy: false,
  projects: [], activeProject: null, trash: [], lastDeleted: null, workspaceRevision: '', error: null,
  saveStatus: 'saved', dirty: false,

  initialize: async () => {
    if (get().initialized) return;
    if (initializing) return initializing;
    set({ loading: true, error: null });
    initializing = (async () => {
      try {
        // A stale tab cannot write to its former active project. Persist its
        // unsaved authoring as an inactive recovered copy before replacement.
        await recoverPendingWork();
        const list = await api.listProjects();
        // A listing without a version is from a backend older than the gate (0).
        const backendVersion = backendParamsVersion(list.paramsVersion);
        if (backendVersion !== GRAPH_PARAMS_VERSION) {
          await handleParamsVersionChange(backendVersion);
          return;
        }
        clearParamsReloadMark();
        set({ projects: list.projects, trash: list.trash ?? [], workspaceRevision: list.workspaceRevision });
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
          void useGraphStore.getState().reconcilePersistedWorldLabsRun();
        } else {
          setProjectContext(null);
          // Forget the project a conflict left loaded, so Open of it goes
          // through the backend and applyProject instead of open()'s shortcut
          // to a canvas with no project context.
          set({ initialized: true, activeProject: null });
        }
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
    finally { set({ busy: false }); markDirty(); }
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
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        await saveQueue.catch(() => {});
        reserved = useGraphStore.getState().reserveGraphImport();
        if (!reserved) throw new Error('The canvas became busy. Try again when its run finishes.');
      }
      const result = await api.deleteProject(id, get().workspaceRevision);
      if (deletingActive) {
        useGraphStore.getState().releaseGraphImport({ discardSuspended: true });
        reserved = false;
        const sessionId = useUIStore.getState().createSessionId;
        applying = true;
        try {
          setProjectContext(null);
          useGraphStore.getState().loadProjectGraph([], [], []);
          useUIStore.getState().resetPanelsForFreshCanvas();
          useUIStore.setState({ createSessionId: null, canvasViewport: null });
        } finally { applying = false; }
        lastSaved = '';
        if (sessionId) useCreateDraftStore.setState((drafts) => {
          const { [sessionId]: _removed, ...rest } = drafts.drafts;
          void _removed;
          return { drafts: rest };
        });
        set({ activeProject: null, dirty: false, saveStatus: 'saved' });
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
      markDirty();
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
      const trash = await api.emptyProjectTrash();
      set({ trash, lastDeleted: null });
    } catch (error) { showError(error); }
    finally { set({ busy: false }); }
  },
  dismissUndo: () => set({ lastDeleted: null }),
  goHome: async () => {
    if (get().busy) return;
    set({ screen: 'home', error: null });
    useUIStore.setState({ onboardingActive: false, isPlaying: false });
    try { await get().flush(); } catch { /* Home keeps the canvas and visible retry. */ }
  },
  flush: async () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
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
      set({ saveStatus: 'saving' });
      try {
        const saved = await api.saveProject(context.id, snapshot, context.revision);
        if (getProjectContext()?.revision !== context.revision) return false;
        lastSaved = fingerprint;
        updateSummary(saved);
        const dirty = JSON.stringify(captureProjectSnapshot()) !== lastSaved;
        set({ dirty, saveStatus: dirty ? 'unsaved' : 'saved' });
        if (dirty) markDirty();
        return true;
      } catch (error) {
        set({ dirty: true, saveStatus: 'error' });
        showError(error);
        throw error;
      }
    });
    saveQueue = task;
    // An edit that landed during the request also belongs to the outgoing project.
    // Only a save that landed can make progress; any other exit re-flushing
    // while dirty would spin forever.
    if (await task && get().dirty && get().saveStatus !== 'error') await get().flush();
  },
  retry: async () => {
    set({ error: null });
    // A params-version stop is checked again from the listing.
    if (!reloadingForParams) paramsVersionChange = null;
    if (!get().initialized) await get().initialize();
    else {
      try {
        await get().flush();
        const list = await api.listProjects();
        set({ projects: list.projects, trash: list.trash ?? [], ...(!get().activeProject ? { workspaceRevision: list.workspaceRevision } : {}) });
      } catch (error) { showError(error); }
    }
  },
}));

/** One coordinator stays mounted across Home, Canvas and all studios. */
export function subscribeProjectAutosave(): () => void {
  const graph = useGraphStore.subscribe((state, previous) => {
    if (state.nodes !== previous.nodes || state.edges !== previous.edges || state.runHistory !== previous.runHistory) markDirty();
  });
  const ui = useUIStore.subscribe((state, previous) => {
    if (state.canvasViewport !== previous.canvasViewport || state.createSessionId !== previous.createSessionId) markDirty();
  });
  const drafts = useCreateDraftStore.subscribe(() => markDirty());
  const socket = wsClient.subscribe((event) => {
    if (event.type !== 'graphSync') return;
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
    if (!revision || !context || state.busy || revision === context.revision) return;
    // Another tab changed the backend's active project. Keep our local canvas
    // available but stop saves and require a fresh, explicit choice from Home.
    preserveWorkspaceConflict(JSON.stringify(captureProjectSnapshot()) !== lastSaved
      ? 'The active project changed in another window. Try again to save your unsaved edits as a recovered project.'
      : 'The active project changed in another window. Reload projects to continue.');
  });
  const outdated = onParamsOutdated((backendVersion) => { void handleParamsVersionChange(backendVersion); });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (reloadingForParams || !useProjectStore.getState().dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    graph(); ui(); drafts(); socket(); outdated();
    window.removeEventListener('beforeunload', beforeUnload);
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  };
}
