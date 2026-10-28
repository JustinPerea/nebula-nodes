import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A freshly opened or followed project reads as saved until someone changes
// it. The canvas places its own first camera when it mounts (React Flow's
// starting view on an empty canvas, or its fit of a project saved without a
// view); that camera isn't an edit (PR #102 follow-up, 2026-10-20).

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/personSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/personSession')>()),
  // The person's own tab: its camera is part of what it saves.
  holdsPersonCredential: vi.fn(() => true),
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  openProject: vi.fn(),
  recoverProject: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCLIGraph: vi.fn(),
}));

import * as api from '../lib/projects';
import { fetchCLIGraph } from '../lib/api';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import type { ProjectSwitch } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSnapshot, ProjectSummary, SavedProject } from '../lib/projects';

const saveProject = vi.mocked(api.saveProject);
const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const loop = summary('p1', 'Loop');
const summer = summary('p3', 'Summer shoot');
const node = (prompt: string) => ({
  id: 'n1', type: 'model', position: { x: 0, y: 0 },
  data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt }, outputs: {} },
});
/** Saved with no view: a new project, or one an agent filled with no canvas open. */
const noView = (nodes: unknown[] = []): ProjectSnapshot => ({
  nodes: nodes as never, edges: [], runHistory: [], viewport: null, createSessionId: null,
});
const saved = (project: ProjectSummary, snapshot: ProjectSnapshot): SavedProject => ({ ...project, snapshot });

/** What Canvas does on mount for a project saved without a view. */
const canvasPlacesFirstCamera = () => useUIStore.getState().setCanvasViewport(
  { x: -288.25, y: -457.03, zoom: 1.42 }, { initial: true });
const expectSaved = () => expect(useProjectStore.getState()).toMatchObject({ dirty: false, saveStatus: 'saved', error: null });
const afterAutosave = () => new Promise((resolve) => setTimeout(resolve, 700));

const agentSwitch = (previous: { id: string; name: string } | null, previousRevision: string): ProjectSwitch => ({
  actor: { kind: 'agent', name: 'Claude Code', color: '#f80' },
  projectId: 'p3', projectName: 'Summer shoot', previousProjectId: previous?.id ?? null,
  previousProjectName: previous?.name ?? null, previousRevision, created: true,
});
function socket() {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  return handler;
}
function backendHas(snapshot: ProjectSnapshot, revision = 'r2') {
  vi.mocked(api.listProjects).mockResolvedValue({
    projects: [summer, loop], trash: [], activeProjectId: 'p3', workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION,
  } as never);
  vi.mocked(api.getProject).mockResolvedValue(saved(summer, snapshot));
  vi.mocked(api.openProject).mockResolvedValue({ project: saved(summer, snapshot), workspaceRevision: revision,
    paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(fetchCLIGraph).mockResolvedValue({ nodes: [], edges: [], empty: true, workspaceRevision: revision } as never);
}

let unsubscribe: () => void = () => {};

beforeEach(async () => {
  resetProjectStoreForTests();
  saveProject.mockReset();
  saveProject.mockImplementation(async (id, snapshot) => saved(id === 'p1' ? loop : summer, snapshot));
  // Loop is open and saved, with the view the person left it at.
  setProjectContext({ id: 'p1', revision: 'r1' });
  useGraphStore.setState({ nodes: [node('a')] as never, edges: [], runHistory: [] });
  useUIStore.setState({ canvasViewport: { x: 5, y: 5, zoom: 1 }, viewMode: 'canvas' });
  useProjectStore.setState({
    screen: 'workspace', initialized: true, busy: false, activeProject: loop, workspaceRevision: 'r1',
    dirty: false, saveStatus: 'saved', error: null, switchNotice: null,
  });
  await useProjectStore.getState().flush();
  saveProject.mockClear();
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => unsubscribe());

describe('a project that opens reads as saved until someone changes it', () => {
  it('opened from Projects', async () => {
    backendHas(noView());
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'p3' } });
    canvasPlacesFirstCamera();
    expectSaved();
    await afterAutosave();
    expect(saveProject).not.toHaveBeenCalled();
    expectSaved();
  });

  it('opened from Projects with nodes, fitted by the canvas', async () => {
    backendHas(noView([node('fit me')]));
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    canvasPlacesFirstCamera();
    expectSaved();
  });

  it('an agent’s new_project followed from Projects with nothing open', async () => {
    setProjectContext(null);
    useProjectStore.setState({ screen: 'home', activeProject: null, workspaceRevision: 'r1' });
    backendHas(noView());
    socket()({ type: 'graphSync', workspaceRevision: 'r2', activeProjectId: 'p3', graphReplaced: true,
      paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: agentSwitch(null, 'r1') } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(useProjectStore.getState().screen).toBe('workspace');
    canvasPlacesFirstCamera();
    expectSaved();
    await afterAutosave();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('an agent’s switch followed from Projects with a project still loaded', async () => {
    useProjectStore.setState({ screen: 'home' });
    backendHas(noView());
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: agentSwitch(loop, 'r1') } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    canvasPlacesFirstCamera();
    expectSaved();
  });

  it('an agent’s switch followed from the canvas (or from a studio, where the canvas mounts again)', async () => {
    useUIStore.setState({ viewMode: 'moodboard' as never });
    backendHas(noView());
    socket()({ type: 'graphSync', workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION,
      projectSwitch: agentSwitch(loop, 'r1') } as never);
    await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
    expect(useUIStore.getState().viewMode).toBe('canvas');
    canvasPlacesFirstCamera();
    expectSaved();
  });

  it('opened after a reload', async () => {
    setProjectContext(null);
    useProjectStore.setState({ initialized: false, activeProject: null, screen: 'home' });
    backendHas(noView([node('after reload')]));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().activeProject?.id).toBe('p3');
    await useProjectStore.getState().open('p3'); // Projects' card: the loaded project
    canvasPlacesFirstCamera();
    expectSaved();
  });

  it('a project whose params the backend upgraded on read opens as saved: the upgrade is what it holds', async () => {
    // The backend upgrades every read (and writes it at boot); the canvas
    // gets 64,000 and that is the project, not an edit of this tab's.
    backendHas(noView([{ id: 'n1', type: 'model', position: { x: 0, y: 0 }, data: { definitionId: 'claude-chat', label: 'Claude',
      params: { model: 'claude-opus-4-8', extended_thinking: true, max_tokens: 64000 }, outputs: {} } }]));
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    canvasPlacesFirstCamera();
    expectSaved();
  });
});

describe('a real change right after opening still saves', () => {
  it('the person pans or zooms', async () => {
    backendHas(noView());
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    canvasPlacesFirstCamera();
    useUIStore.getState().setCanvasViewport({ x: 40, y: 0, zoom: 1.42 });
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    expect(saveProject.mock.calls[0][1].viewport).toEqual({ x: 40, y: 0, zoom: 1.42 });
    await vi.waitFor(expectSaved);
  });

  it('an edit made before the canvas placed its camera saves, camera and all', async () => {
    backendHas(noView());
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    useGraphStore.setState({ nodes: [node('typed at once')] as never });
    canvasPlacesFirstCamera();
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    const [, snapshot] = saveProject.mock.calls[0];
    expect(snapshot.nodes[0]?.data.params.prompt).toBe('typed at once');
    expect(snapshot.viewport).toEqual({ x: -288.25, y: -457.03, zoom: 1.42 });
  });

  it('an edit right after opening', async () => {
    backendHas(noView());
    await useProjectStore.getState().goHome();
    await useProjectStore.getState().open('p3');
    canvasPlacesFirstCamera();
    useGraphStore.setState({ nodes: [node('first edit')] as never });
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved' });
    await vi.waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    // The camera the canvas placed goes with it, so reopening restores it.
    expect(saveProject.mock.calls[0][1].viewport).toEqual({ x: -288.25, y: -457.03, zoom: 1.42 });
  });
});
