import { create } from 'zustand';
import { useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { readDraft, useCreateDraftStore } from './createDraftStore';
import { fetchCLIGraph } from '../lib/api';
import { rewriteBackendAssetUrls } from '../lib/backend';
import { normalizeRuntimeMediaParams } from '../lib/graphFile';
import { getProjectContext, setProjectContext } from '../lib/projectContext';
import { clearPersistedRunHistory, loadRunHistory } from '../lib/runHistory';
import * as api from '../lib/projects';
import { wsClient } from '../lib/wsClient';
import type { ProjectSnapshot, ProjectSummary, SavedProject } from '../lib/projects';

interface ProjectState {
  screen: 'home' | 'workspace';
  initialized: boolean; loading: boolean; busy: boolean;
  projects: ProjectSummary[]; activeProject: ProjectSummary | null;
  workspaceRevision: string; error: string | null;
  saveStatus: 'saved' | 'saving' | 'unsaved' | 'error'; dirty: boolean;
  initialize: () => Promise<void>;
  open: (id: string) => Promise<void>;
  createProject: (name?: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  goHome: () => Promise<void>;
  flush: () => Promise<void>;
  retry: () => Promise<void>;
}

let initializing: Promise<void> | null = null;
let saveQueue: Promise<void> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaved = '';
let applying = false;
let pendingRecovery: { sourceProjectId: string; snapshot: ProjectSnapshot; recoveryId: string } | null = null;

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
function updateSummary(project: SavedProject): void {
  const metadata = summary(project);
  useProjectStore.setState((state) => ({
    projects: [...state.projects.filter((item) => item.id !== project.id), metadata]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    ...(state.activeProject?.id === project.id ? { activeProject: metadata } : {}),
  }));
}

function applyProject(project: SavedProject, revision: string, bootstrap = false): void {
  applying = true;
  const previous = getProjectContext();
  try {
    setProjectContext({ id: project.id, revision });
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
function preserveWorkspaceConflict(message: string): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  const context = getProjectContext();
  const snapshot = captureProjectSnapshot();
  const dirty = Boolean(context) && JSON.stringify(snapshot) !== lastSaved;
  if (dirty && context) pendingRecovery = {
    sourceProjectId: context.id, snapshot, recoveryId: crypto.randomUUID().replaceAll('-', ''),
  };
  useProjectStore.setState({ screen: 'home', initialized: false, loading: false, dirty, error: message });
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
  projects: [], activeProject: null, workspaceRevision: '', error: null,
  saveStatus: 'saved', dirty: false,

  initialize: async () => {
    if (get().initialized) return;
    if (initializing) return initializing;
    set({ loading: true, error: null });
    initializing = (async () => {
      try {
        // A stale tab cannot write to its former active project. Persist its
        // unsaved authoring as an inactive recovered copy before replacement.
        if (pendingRecovery) {
          const recovery = pendingRecovery;
          await api.recoverProject(recovery.sourceProjectId, recovery.snapshot, recovery.recoveryId);
          if (pendingRecovery === recovery) pendingRecovery = null;
        }
        const list = await api.listProjects();
        set({ projects: list.projects, workspaceRevision: list.workspaceRevision });
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
          set({ initialized: true });
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
  goHome: async () => {
    if (get().busy) return;
    set({ screen: 'home', error: null });
    useUIStore.setState({ onboardingActive: false, isPlaying: false });
    try { await get().flush(); } catch { /* Home keeps the canvas and visible retry. */ }
  },
  flush: async () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    const task = saveQueue.catch(() => {}).then(async () => {
      const state = get();
      const context = getProjectContext();
      if (!state.initialized || !state.activeProject || !context) return;
      const snapshot = captureProjectSnapshot();
      const fingerprint = JSON.stringify(snapshot);
      if (fingerprint === lastSaved) return;
      set({ saveStatus: 'saving' });
      try {
        const saved = await api.saveProject(context.id, snapshot, context.revision);
        if (getProjectContext()?.revision !== context.revision) return;
        lastSaved = fingerprint;
        updateSummary(saved);
        const dirty = JSON.stringify(captureProjectSnapshot()) !== lastSaved;
        set({ dirty, saveStatus: dirty ? 'unsaved' : 'saved' });
        if (dirty) markDirty();
      } catch (error) {
        set({ dirty: true, saveStatus: 'error' });
        showError(error);
        throw error;
      }
    });
    saveQueue = task;
    await task;
    // An edit that landed during the request also belongs to the outgoing project.
    if (get().dirty && get().saveStatus !== 'error') await get().flush();
  },
  retry: async () => {
    set({ error: null });
    if (!get().initialized) await get().initialize();
    else {
      try {
        await get().flush();
        const list = await api.listProjects();
        set({ projects: list.projects, ...(!get().activeProject ? { workspaceRevision: list.workspaceRevision } : {}) });
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
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!useProjectStore.getState().dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    graph(); ui(); drafts(); socket();
    window.removeEventListener('beforeunload', beforeUnload);
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
  };
}
