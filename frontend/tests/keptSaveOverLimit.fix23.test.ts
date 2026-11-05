/**
 * PR #199 round 23 (RD LOW-2), the tab's side: a kept save refused for the
 * project limit keeps the kept edits and says the over-limit line, so the
 * person can delete projects and save again. It is not held and dropped from
 * kept mode as a refusal for good. The harness is keptCanvas.fix16.store's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestError } from '../src/lib/errorCopy';
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

import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
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
import { isCanvasKept, resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';

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


let stopPulses: () => void = () => {};
beforeEach(() => { stopPulses = subscribeKeptPulse(() => {}); });
afterEach(() => { stopPulses(); });

/** Kept with a typed edit, a delete and its kept Undo step. */
function keepWithEdits(): void {
  type('alpha typed');
  restoreWhileRunning();
  expect(isCanvasKept()).toBe(true);
  type('alpha typed and more');
  expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
}


const OVER_LIMIT = 'You have 501 projects and the limit is 500. You can make a new one after you delete 2 projects.';
const limitAnswer = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  detail: 'Project limit reached', limit: 'projects', projectLimit: 500, projectCount: 501, deletes: 2, ...overrides,
}), { status: 413, headers: { 'Content-Type': 'application/json' } });

describe('a kept save refused for the project limit (round 23, RD LOW-2)', () => {
  it('keeps the kept edits on the canvas and shows the over-limit line on the kept line', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(await requestError('Nebula couldn’t save your edits.', limitAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    const state = useProjectStore.getState();
    expect(isCanvasKept()).toBe(true);
    expect(state.keptEdits).toMatchObject({ saving: false });
    expect(state.keptEdits?.error).toContain(OVER_LIMIT);
    expect(state.unsavedEdits).toBeNull();
    expect(state.screen).toBe('workspace');
    expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('alpha typed and more');
  });

  it('saves again once the person has made room: the same recovery id, no new copy', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(await requestError('Nebula couldn’t save your edits.', limitAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(true);
    const copy = project('alpha-rec', 'Glass campaign (recovered)');
    vi.mocked(projects.recoverProject).mockResolvedValue(copy);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('alpha-rec')] }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: copy, workspaceRevision: 'rev-copy',
      paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    const calls = vi.mocked(projects.recoverProject).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][2]).toBe(calls[0][2]);
    expect(isCanvasKept()).toBe(false);
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha-rec');
  });

  const STORAGE_FULL = 'Nebula couldn’t save your edits as a project because Nebula’s project list is full. ';
  const storageAnswer = () => new Response(JSON.stringify({ detail: 'Project storage limit reached', limit: 'storage' }),
    { status: 413, headers: { 'Content-Type': 'application/json' } });

  it('GM r23, 3: a kept save refused for the storage cap keeps kept mode and says the project list is full, with the size advice', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(await requestError('Nebula couldn’t save your edits.', storageAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    const state = useProjectStore.getState();
    expect(isCanvasKept()).toBe(true);
    expect(state.keptEdits).toMatchObject({ saving: false });
    // No Recently deleted items in the listing: the advice that says to empty it too.
    expect(state.keptEdits?.error).toBe(`${STORAGE_FULL}Delete a project, then remove it from Recently deleted too, and Nebula will save it.`);
    expect(state.unsavedEdits).toBeNull();
    expect(state.screen).toBe('workspace');
    expect(useGraphStore.getState().keptUndo.length).toBeGreaterThan(0);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('alpha typed and more');
  });

  it('GM r23, 3: with items in Recently deleted the advice says to delete one there', async () => {
    keepWithEdits();
    useProjectStore.setState({ trash: [{ ...summary('old'), deletedAt: '2026-10-01T00:00:00Z', purgeAt: '2026-10-31T00:00:00Z' }] as never });
    vi.mocked(projects.recoverProject).mockRejectedValue(await requestError('Nebula couldn’t save your edits.', storageAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().keptEdits?.error)
      .toBe(`${STORAGE_FULL}Permanently delete a project in Recently deleted and Nebula will save it.`);
    expect(isCanvasKept()).toBe(true);
  });

  it('GM r23, 3: both limit refusals keep kept mode, each with its own line, and a save passes after room is made', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(await requestError('Nebula couldn’t save your edits.', storageAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits?.error).toContain('project list is full');
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(await requestError('Nebula couldn’t save your edits.', limitAnswer()));
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(true);
    expect(useProjectStore.getState().keptEdits?.error).toContain(OVER_LIMIT);
    expect(useProjectStore.getState().keptEdits?.error).not.toContain('project list is full');
    vi.mocked(projects.recoverProject).mockResolvedValue(project('alpha-rec', 'Glass campaign (recovered)'));
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha'), summary('alpha-rec')] }));
    vi.mocked(projects.openProject).mockResolvedValueOnce({ project: project('alpha-rec', 'Glass campaign (recovered)'),
      workspaceRevision: 'rev-copy', paramsVersion: GRAPH_PARAMS_VERSION, canvasRevision: '1' } as never);
    await useProjectStore.getState().saveKeptEdits();
    expect(isCanvasKept()).toBe(false);
  });

  it('a request too large (no store limit named) still leaves kept mode for the held edits, as before', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(await requestError('Nebula couldn’t save your edits.',
      new Response(JSON.stringify({ detail: 'Request too large' }), { status: 413, headers: { 'Content-Type': 'application/json' } })));
    await useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().unsavedEdits).not.toBeNull();
    expect(useProjectStore.getState().keptEdits).toBeNull();
    expect(isCanvasKept()).toBe(false);
  });

  it('another refusal for good (a stale revision) still leaves kept mode for the held edits', async () => {
    keepWithEdits();
    vi.mocked(projects.recoverProject).mockRejectedValue(await requestError('Nebula couldn’t save your edits.',
      new Response(JSON.stringify({ detail: 'Nope' }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
    await useProjectStore.getState().saveKeptEdits();
    expect(useProjectStore.getState().unsavedEdits).not.toBeNull();
    expect(useProjectStore.getState().keptEdits).toBeNull();
  });
});
