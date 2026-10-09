import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore, captureProjectSnapshot, subscribeProjectAutosave } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import type { SavedProject } from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';

vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(),
  openProject: vi.fn(), createProject: vi.fn(), renameProject: vi.fn(), recoverProject: vi.fn(),
}));

const initial = useProjectStore.getState();
function project(id = 'alpha'): SavedProject {
  return {
    id, name: id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: { x: 20, y: 30, zoom: 0.8 }, createSessionId: null },
  };
}
let unsubscribe: (() => void) | null = null;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setProjectContext(null);
  window.localStorage.clear();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], providerRecoveries: [], providerStartAmbiguities: [],
    isExecuting: false, isImportingGraph: false, createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.spyOn(execution, 'executeGraph').mockResolvedValue({ status: 'complete' } as never);
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha', workspaceRevision: 'rev-a' });
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b' });
  vi.mocked(projects.createProject).mockResolvedValue({ project: { ...project('beta'), nodeCount: 0,
    snapshot: { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null } }, workspaceRevision: 'rev-b' });
});
afterEach(async () => {
  unsubscribe?.(); unsubscribe = null;
  await Promise.resolve();
  vi.useRealTimers();
  setProjectContext(null);
});

describe('saved project coordinator', () => {
  it('starts at Home while restoring the active project without generation', async () => {
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().screen).toBe('home');
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    expect(getProjectContext()).toEqual({ id: 'alpha', revision: 'rev-a' });
    expect(useUIStore.getState().createSessionId).toBe('project:alpha:create');
    expect(useUIStore.getState().canvasViewport).toEqual({ x: 20, y: 30, zoom: 0.8 });
    expect(execution.executeGraph).not.toHaveBeenCalled();
    expect(projects.openProject).not.toHaveBeenCalled();
  });
  it('saves outgoing edits before opening another project with independent history and draft identity', async () => {
    await useProjectStore.getState().initialize();
    useGraphStore.setState({ nodes: [project().snapshot.nodes[0], { ...project().snapshot.nodes[0], id: 'n2' }] });
    await useProjectStore.getState().open('beta');
    expect(projects.saveProject).toHaveBeenCalledWith('alpha', expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: 'n2' })]) }), 'rev-a');
    expect(vi.mocked(projects.saveProject).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(projects.openProject).mock.invocationCallOrder[0]);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('beta');
    expect(useUIStore.getState().createSessionId).toBe('project:beta:create');
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(execution.executeGraph).not.toHaveBeenCalled();
  });
  it('keeps the current canvas if the outgoing save fails', async () => {
    await useProjectStore.getState().initialize();
    useGraphStore.setState({ edges: [] });
    useUIStore.setState({ canvasViewport: { x: 900, y: 400, zoom: 2 } });
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new Error('Disk full'));
    await useProjectStore.getState().open('beta');
    expect(projects.openProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeProject?.id).toBe('alpha');
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    expect(useProjectStore.getState().error).toBe('Disk full');
  });
  it('creates a blank canvas without replaying a recipe or clearing the outgoing saved project', async () => {
    await useProjectStore.getState().initialize();
    await useProjectStore.getState().createProject();
    expect(projects.createProject).toHaveBeenCalledWith(undefined, 'rev-a');
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(useGraphStore.getState().runHistory).toEqual([]);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(execution.executeGraph).not.toHaveBeenCalled();
  });
  it('can return Home and resume the active canvas during a run, but rejects changing projects', async () => {
    await useProjectStore.getState().initialize();
    useGraphStore.setState({ isExecuting: true });
    await useProjectStore.getState().goHome();
    expect(useProjectStore.getState().screen).toBe('home');
    await useProjectStore.getState().open('beta');
    expect(projects.openProject).not.toHaveBeenCalled();
    await useProjectStore.getState().open('alpha');
    expect(useProjectStore.getState().screen).toBe('workspace');
  });
  it('autosaves changes made on Home and keeps an immutable copy of draft and graph', async () => {
    await useProjectStore.getState().initialize();
    unsubscribe = subscribeProjectAutosave();
    vi.useFakeTimers();
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data,
      params: { value: 'changed' }, keyStatus: 'missing', progress: 50 } }] });
    await vi.advanceTimersByTimeAsync(600);
    expect(projects.saveProject).toHaveBeenCalledWith('alpha', expect.objectContaining({ nodes: [expect.objectContaining({ data: expect.objectContaining({ params: { value: 'changed' } }) })] }), 'rev-a');
    const snapshot = captureProjectSnapshot();
    expect(snapshot.nodes[0].data.keyStatus).toBeUndefined();
    expect(snapshot.nodes[0].data.progress).toBeUndefined();
    snapshot.nodes[0].data.params.value = 'mutated copy';
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('changed');
    expect(useProjectStore.getState().saveStatus).toBe('saved');
  });
  it('migrates browser history once into the recovered project', async () => {
    const history = [{ id: 'old-run', trigger: 'graph', status: 'complete', startedAt: 1,
      snapshot: { nodes: [], edges: [] } }];
    window.localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, records: history }));
    vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha', workspaceRevision: 'rev-a', migratedProjectId: 'alpha' });
    await useProjectStore.getState().initialize();
    expect(projects.saveProject).toHaveBeenCalledWith('alpha', expect.objectContaining({ runHistory: history }), 'rev-a');
    expect(useGraphStore.getState().runHistory[0].id).toBe('old-run');
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
    expect(execution.executeGraph).not.toHaveBeenCalled();
    expect(useProjectStore.getState().screen).toBe('home');
  });
  it('opens a different project on Canvas when leaving Creator Studio', async () => {
    await useProjectStore.getState().initialize();
    useUIStore.setState({ viewMode: 'create' });
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('beta');
    expect(useUIStore.getState().viewMode).toBe('canvas');
  });
  it('turns persisted incomplete uploads into explicit interrupted drafts', async () => {
    const saved = project();
    saved.snapshot.createDraft = { revision: 'draft-a', modelId: 'nano-banana', prompt: 'Keep this draft',
      params: {}, refs: [], quantity: 1, uploads: [{ id: 'upload-a', name: 'ref.png', attempt: 'attempt-a', status: 'uploading' }] };
    vi.mocked(projects.getProject).mockResolvedValue(saved);
    await useProjectStore.getState().initialize();
    const draft = useCreateDraftStore.getState().drafts['project:alpha:create'];
    expect(draft.prompt).toBe('Keep this draft');
    expect(draft.uploads[0].status).toBe('error');
    expect(useGraphStore.getState().canSwitchProject()).toBe(true);
  });
  it('uses read-only recovery after a lost project-activation reply rather than creating twice', async () => {
    await useProjectStore.getState().initialize();
    vi.mocked(projects.createProject).mockRejectedValueOnce(new Error('Response lost after commit'));
    await useProjectStore.getState().createProject();
    expect(useProjectStore.getState().initialized).toBe(false);
    expect(useProjectStore.getState().screen).toBe('home');
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('alpha');
    vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project(), project('beta')],
      activeProjectId: 'beta', workspaceRevision: 'rev-b' });
    await useProjectStore.getState().retry();
    expect(projects.createProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(useProjectStore.getState().screen).toBe('home');
  });
  it('rejects bootstrap data if another window changes identity during loading', async () => {
    vi.mocked(execution.fetchCLIGraph).mockResolvedValueOnce({ nodes: [], edges: [], empty: true, workspaceRevision: 'rev-b' });
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().initialized).toBe(false);
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(getProjectContext()).toBeNull();
  });
  it('recovers dirty work durably before reloading a workspace changed in another tab', async () => {
    await useProjectStore.getState().initialize();
    let socketHandler!: (event: ExecutionEvent) => void;
    vi.spyOn(wsClient, 'subscribe').mockImplementation((handler) => { socketHandler = handler; return () => {}; });
    unsubscribe = subscribeProjectAutosave();
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data,
      params: { value: 'Unsaved alpha edits' } } }] });
    socketHandler({ type: 'graphSync', workspaceRevision: 'rev-b', nodes: [], edges: [], empty: true });
    expect(useProjectStore.getState().initialized).toBe(false);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('Unsaved alpha edits');
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(new Error('Recovery disk full'));
    await useProjectStore.getState().retry();
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('Unsaved alpha edits');
    expect(useProjectStore.getState().error).toBe('Recovery disk full');
    const firstRecovery = vi.mocked(projects.recoverProject).mock.calls[0];
    vi.mocked(projects.recoverProject).mockResolvedValueOnce(project('recovered-alpha'));
    vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project('beta'), project('recovered-alpha')],
      activeProjectId: 'beta', workspaceRevision: 'rev-b' });
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.recoverProject).mock.calls[1]).toEqual(firstRecovery);
    expect(firstRecovery[0]).toBe('alpha');
    expect(firstRecovery[1].nodes[0].data.params.value).toBe('Unsaved alpha edits');
    expect(vi.mocked(projects.recoverProject).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(projects.listProjects).mock.invocationCallOrder.at(-1)!);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('beta');
    expect(useProjectStore.getState().screen).toBe('home');
  });
});
