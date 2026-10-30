/**
 * Round 15 of PR #199 (review 13; GM r19 and r20), the store's side. The
 * harness is catalogRestore.fix11.store's.
 *
 * Fix round 11 of PR #199 (review 11; GM r14 and r15), the harness's own notes:
 * - HIGH-1 and GM r15, Q11: a restore while the person types keeps the
 *   canvas where they are, with GM r12, 1's line and [Save as a project] in
 *   the canvas notice region. Nothing typed is reverted or sent; typing goes
 *   on and joins the kept edits; the button files everything typed up to the
 *   click, opens that project and shows the saved toast.
 * - The tab learns of the restore from the backend's graphSync, and from
 *   `projectsChanged{catalogRestored}` when that sync is late or lost.
 * - GM r14, 3: an agent's write that closed the project the tab showed: its
 *   line on Projects home, or kept in the tab with the edits not saved.
 * - LOW-2: a restore (or a reconnect) lets the person's next edit say
 *   `personInput` again. GM r15, Q10: the person's log row says "kept".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
const acts = vi.hoisted(() => ({ said: [] as Array<[string, string]> }));
const graphWrites = vi.hoisted(() => ({
  sent: [] as Array<{ method: string; path: string; body: string }>,
  answer: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
  notePersonAct: (kind: string, id: string) => { acts.said.push([kind, id]); },
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    getCachedBackendBaseUrl: () => null,
    apiFetch: (path: string, init?: RequestInit, options?: unknown) => {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && path.startsWith('/api/graph')) {
        graphWrites.sent.push({ method, path, body: String(init?.body ?? '') });
        return graphWrites.answer ? graphWrites.answer(path, init)
          : Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real.apiFetch(path, init, options as never);
    },
  };
});
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
}));

import { DISCARDED_KEPT_EDITS, KEPT_UPDATE_LINE, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { resetCanvasFollowForTests } from '../src/lib/canvasFollow';
import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../src/lib/canvasNotice';
import { isCanvasKept, resetKeptCanvasForTests, setKeptCanvasSaving, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { reloadPage, reportParamsOutdated } from '../src/lib/paramsOutdated';

const initial = useProjectStore.getState();

function project(id = 'alpha', name = id === 'alpha' ? 'Glass campaign' : id, value: string = id): SavedProject {
  return {
    id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Hero prompt', params: { value }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string, name?: string) => { const { snapshot: _s, ...rest } = project(id, name); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const type = (value: string) => {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === 'n1')!;
  useGraphStore.getState().updateNodeData('n1', { params: { ...node.data.params, value } });
};
const valueOf = () => useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value;
/** A sync carrying the canvas as Nebula has it (the tab's own nodes). */
const sync = (workspaceRevision: string, more: Record<string, unknown> = {}) => emit({ type: 'graphSync', workspaceRevision,
  paramsVersion: GRAPH_PARAMS_VERSION, nodes: useGraphStore.getState().nodes.map((node) => ({ ...node })), edges: [],
  empty: false, ...more });
/** Nebula restored its project list while running: Delta's revision is gone. */
const restoreWhileRunning = () => sync('rev-restored', { catalogRestore: 'restore-new', activeProjectId: null,
  nodes: [], edges: [], empty: true });

let notices: CanvasNoticeDetail[] = [];
const onNotice = (event: Event) => { notices.push((event as CustomEvent<CanvasNoticeDetail>).detail); };
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  graphWrites.sent = [];
  graphWrites.answer = null;
  acts.said = [];
  notices = [];
  resetProjectStoreForTests();
  resetKeptCanvasForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, lateNotice: null,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true, canvasRevision: '0' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b',
    paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '0' } as never);
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  window.addEventListener(CANVAS_NOTICE_EVENT, onNotice);
  unsubscribe = subscribeProjectAutosave();
  // The socket's first sync: this tab's revision, no restore yet.
  sync('rev-a');
});
afterEach(async () => {
  window.removeEventListener(CANVAS_NOTICE_EVENT, onNotice);
  resetCanvasFollowForTests();
  graphWrites.answer = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  resetProjectStoreForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setProjectContext(null);
});


let pulses = 0;
let stopPulses: () => void = () => {};
beforeEach(() => { pulses = 0; stopPulses = subscribeKeptPulse(() => { pulses += 1; }); });
afterEach(() => { stopPulses(); });

/** Kept with a typed edit, a delete and its kept Undo step. */
function keepWithEdits(): void {
  type('alpha typed');
  restoreWhileRunning();
  expect(isCanvasKept()).toBe(true);
  type('alpha typed and more');
  expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
}

describe('GM r20 on PR #199 (review 12 HIGH-1, review 13 kept-scratch HIGH-1): nothing replaces a kept canvas', () => {
  it('kept, then Back to projects and an open: both refused with a pulse; the canvas, kept mode and its Undo stay', async () => {
    keepWithEdits();
    const keptUndo = useGraphStore.getState().keptUndo;
    await useProjectStore.getState().goHome();
    expect(useProjectStore.getState().screen).toBe('workspace');
    await useProjectStore.getState().open('beta');
    await useProjectStore.getState().createProject('New');
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(pulses).toBeGreaterThan(0);
    expect(isCanvasKept()).toBe(true);
    expect(useGraphStore.getState().keptUndo).toBe(keptUndo);
    expect(useProjectStore.getState().keptEdits?.sourceId).toBe('alpha');
    expect(valueOf()).toBe('alpha typed and more');
  });

  it('kept, then a canvas that does get replaced (any load): kept mode, its Undo and its line go with it, so Beta is never filed as the kept source', async () => {
    keepWithEdits();
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    const beta = project('beta', 'Beta', 'beta typed');
    expect(useGraphStore.getState().loadProjectGraph(beta.snapshot.nodes, beta.snapshot.edges, [])).toBe(true);
    expect(isCanvasKept()).toBe(false);
    expect(useGraphStore.getState().keptUndo).toEqual([]);
    expect(useGraphStore.getState().keptRedo).toEqual([]);
    expect(useProjectStore.getState().keptEdits).toBeNull();
    // [Save as a project] has nothing to file now: never Beta's canvas under alpha.
    await useProjectStore.getState().saveKeptEdits();
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
    // A kept Undo step of the lost canvas never lands on Beta (review 13, K6c).
    useGraphStore.getState().undo();
    expect(valueOf()).toBe('beta typed');
  });

  it('kept, then [Discard edits]: the open of the saved project goes, kept mode ends, and Beta can be opened after', async () => {
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: null, workspaceRevision: 'rev-restored' }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: project('alpha', 'Glass campaign', 'alpha saved'),
      workspaceRevision: 'rev-alpha', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().discardKeptEdits();
    expect(vi.mocked(projects.openProject)).toHaveBeenCalledWith('alpha', 'rev-restored');
    expect(isCanvasKept()).toBe(false);
    expect(useGraphStore.getState().keptUndo).toEqual([]);
    expect(useProjectStore.getState()).toMatchObject({ keptEdits: null, screen: 'workspace', activeProject: { id: 'alpha' }, dirty: false });
    expect(valueOf()).toBe('alpha saved');
    expect(notices).toContainEqual({ text: DISCARDED_KEPT_EDITS, tone: 'info' });
    expect(DISCARDED_KEPT_EDITS).toBe('Discarded the kept edits.');
    // Not kept any more: the person's open goes.
    await useProjectStore.getState().open('beta');
    expect(vi.mocked(projects.openProject)).toHaveBeenLastCalledWith('beta', 'rev-alpha');
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
  });

  it('[Discard edits] when the restored list doesn’t hold the project: Projects home (its restore notice says where it is)', async () => {
    keepWithEdits();
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('beta')], activeProjectId: null,
      workspaceRevision: 'rev-restored' }));
    await useProjectStore.getState().discardKeptEdits();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState()).toMatchObject({ keptEdits: null, screen: 'home', activeProject: null });
    expect(useGraphStore.getState().nodes).toEqual([]);
    // On the home, in its own notice stack (the canvas notice region isn't
    // on the home: the live check found the line never showed).
    expect(useProjectStore.getState().copyNotice).toEqual({ line: DISCARDED_KEPT_EDITS, restore: null });
    expect(notices).not.toContainEqual({ text: DISCARDED_KEPT_EDITS, tone: 'info' });
  });

  it('kept, then a graph loaded over it (Load, Import, a sample): released the same way', async () => {
    keepWithEdits();
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    const beta = project('beta', 'Beta', 'beta typed');
    useGraphStore.getState().loadGraph(beta.snapshot.nodes, beta.snapshot.edges);
    expect(valueOf()).toBe('beta typed');
    expect(isCanvasKept()).toBe(false);
    expect(useGraphStore.getState().keptUndo).toEqual([]);
    expect(useProjectStore.getState().keptEdits).toBeNull();
  });

  it('[Discard edits] and [Save as a project] wait while a run holds the switch (GM r19, 4; review 13 LOW-3)', async () => {
    keepWithEdits();
    useGraphStore.setState({ isExecuting: true });
    vi.mocked(projects.listProjects).mockClear();
    await useProjectStore.getState().saveKeptEdits();
    await useProjectStore.getState().discardKeptEdits();
    // Discard doesn't even ask for the list: its button names the run.
    expect(vi.mocked(projects.listProjects)).not.toHaveBeenCalled();
    expect(vi.mocked(projects.recoverProject)).not.toHaveBeenCalled();
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits).not.toBeNull();
    useGraphStore.setState({ isExecuting: false });
  });

  it('kept, then an agent opens another project: the tab doesn’t follow; the kept canvas stays', () => {
    keepWithEdits();
    sync('rev-beta', { projectSwitch: { projectId: 'beta', projectName: 'Beta', previousRevision: 'rev-restored',
      actor: { kind: 'agent', name: 'Codex' } }, nodes: [], edges: [] });
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().busy).toBe(false);
    expect(vi.mocked(projects.openProject)).not.toHaveBeenCalled();
    expect(useProjectStore.getState().keptEdits?.sourceId).toBe('alpha');
    expect(valueOf()).toBe('alpha typed and more');
  });

  it('kept, then a second restore: the same kept canvas, source and Undo; nothing loads over it', () => {
    keepWithEdits();
    const keptUndo = useGraphStore.getState().keptUndo;
    sync('rev-restored-2', { catalogRestore: 'restore-second', activeProjectId: null, nodes: [], edges: [], empty: true });
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits?.sourceId).toBe('alpha');
    expect(useGraphStore.getState().keptUndo).toBe(keptUndo);
    expect(valueOf()).toBe('alpha typed and more');
  });

  it('the unload guard holds while kept (a reload, a tab close, Back) and goes when kept mode ends', async () => {
    keepWithEdits();
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    // Nothing unsaved but the kept canvas: the guard is the kept one's own.
    useProjectStore.setState({ dirty: false });
    const kept = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(kept);
    expect(kept.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    expect(useGraphStore.getState().loadProjectGraph([], [], [])).toBe(true);
    expect(isCanvasKept()).toBe(false);
    useProjectStore.setState({ dirty: false });
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('an update while kept never reloads by itself: the line says to save or discard first', async () => {
    keepWithEdits();
    // The kept tab's own write refused as params_outdated (a sync while kept is set aside).
    reportParamsOutdated(GRAPH_PARAMS_VERSION + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().error).toBe(KEPT_UPDATE_LINE);
  });
});

describe('GM r19 on PR #199, 4: in the store’s gate, kept comes before the run', () => {
  it('a delete while the kept save is on its way and this tab runs: the kept pulse, not the run’s lock', () => {
    keepWithEdits();
    setKeptCanvasSaving(true);
    useGraphStore.setState({ isExecuting: true });
    const before = useGraphStore.getState().nodes.length;
    pulses = 0;
    useGraphStore.getState().deleteNode('n1');
    expect(pulses).toBe(1);
    expect(useGraphStore.getState().nodes).toHaveLength(before);
    useGraphStore.setState({ isExecuting: false });
    setKeptCanvasSaving(false);
  });
});

describe('review 13 of PR #199, kept-scratch LOW-1: a kept step says nothing to Nebula and leaves the saved history', () => {
  it('a kept duplicate, Arrange, typing and an add: no personInput, the saved Undo untouched', async () => {
    keepWithEdits();
    acts.said = [];
    const saved = useGraphStore.getState().undoStack;
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => ({ ...node, selected: true })) }));
    useGraphStore.getState().duplicateSelected();
    useGraphStore.getState().autoLayout();
    useGraphStore.getState().autoLayoutSelected();
    type('typed again');
    await useGraphStore.getState().addNode('text-input', { x: 400, y: 0 });
    expect(acts.said.filter(([kind]) => kind === 'personInput')).toEqual([]);
    expect(useGraphStore.getState().undoStack).toBe(saved);
    expect(useGraphStore.getState().redoStack).toEqual([]);
    expect(graphWrites.sent).toEqual([]);
  });
});
