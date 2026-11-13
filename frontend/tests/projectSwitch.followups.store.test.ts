/**
 * Review 17 L1 (probes H1, H2): during an outage an agent makes a new project
 * and deletes the one the tab left. On reconnect the held save into the
 * deleted project is refused (404) and the project can't be read. Whether
 * work was really lost is judged against what the tab last saved for that
 * project: view state alone (a pan) is not work, so it makes no recovered
 * copy. And the toast never offers "Back to" a project that is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(), setViewing: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
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
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { ProjectList, ProjectSnapshot, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const initial = useProjectStore.getState();
const textNode = (id: string, value: string) => ({ id, type: 'model-node', position: { x: 10, y: 20 },
  data: { definitionId: 'text-input', label: 'Text', params: { value }, state: 'idle' as const, outputs: {} } });

function project(id: string, name: string, nodes = [textNode('n1', id)]): SavedProject {
  return {
    id, name, createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z',
    lastOpenedAt: null, nodeCount: nodes.length, edgeCount: 0, thumbnail: null,
    snapshot: { nodes, edges: [], runHistory: [], viewport: null, createSessionId: null } as unknown as ProjectSnapshot,
  };
}
const summary = (item: SavedProject) => { const { snapshot: _s, ...rest } = item; void _s; return rest; };
const NAMES: Record<string, string> = { A: 'Agent A', E: 'Agent E' };
let saved: Record<string, SavedProject> = {};
function listing(active: string, revision: string): ProjectList {
  return { projects: Object.values(saved).map(summary), trash: [], activeProjectId: active,
    workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION };
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => useProjectStore.getState();
const gone = () => new projects.ProjectRequestError('Project not found.', 404, { heading: "Couldn't save the project." } as never);

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.getProject).mockImplementation(async (id) => saved[id]);
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...saved[id], snapshot }));
  vi.mocked(projects.recoverProject).mockResolvedValue({ project: project('R', 'Agent A (recovered)') } as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
});

/** On A, the tab holds something; offline, an agent makes E and deletes A. */
async function newProjectThenDeleteTheOneLeft(hold: () => void): Promise<void> {
  saved = { A: project('A', NAMES.A) };
  vi.mocked(projects.listProjects).mockResolvedValue(listing('A', 'rev-A'));
  await state().initialize();
  unsubscribe = subscribeProjectAutosave();
  hold();
  noteBackendConnection('offline');
  saved.E = project('E', NAMES.E, []);
  emit({ type: 'graphSync', workspaceRevision: 'rev-E', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [],
    empty: true, graphReplaced: true, projectSwitch: { projectId: 'E', projectName: NAMES.E, previousProjectId: 'A',
      previousProjectName: NAMES.A, previousRevision: 'rev-A', created: true, actor: { kind: 'agent', name: 'Codex' } } });
  delete saved.A;
  emit({ type: 'projectsChanged', change: 'deleted', projectId: 'A' });
  await flush();
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => {
    if (id === 'A') throw gone();
    return { ...saved[id], snapshot };
  });
  vi.mocked(projects.getProject).mockImplementation(async (id) => { if (!saved[id]) throw gone(); return saved[id]; });
  vi.mocked(projects.listProjects).mockResolvedValue(listing('E', 'rev-E'));
  noteBackendConnection('online');
  await vi.waitFor(() => expect(state().switchNotice).not.toBeNull());
  await vi.waitFor(() => expect(state().busy).toBe(false));
}

describe('L1: the project the tab left was deleted while Nebula was offline', () => {
  it('H1, only the view moved: no recovered copy, and no way back to the deleted project', async () => {
    await newProjectThenDeleteTheOneLeft(() => {
      useUIStore.setState({ canvasViewport: { x: -300, y: -200, zoom: 1.7 } } as never);
    });
    expect(projects.recoverProject).not.toHaveBeenCalled();
    expect(state().switchNotice).toMatchObject({ projectName: 'Agent E', created: true, keptCopy: false,
      previousProjectId: null, previousProjectName: null });
    expect(state().activeProject?.id).toBe('E');
  });

  it('H2, a node moved (real held work): one recovered copy, still no way back to the deleted project', async () => {
    await newProjectThenDeleteTheOneLeft(() => {
      const [first] = useGraphStore.getState().nodes;
      useGraphStore.setState({ nodes: [{ ...first, position: { x: 99, y: 99 } }] });
    });
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(state().switchNotice).toMatchObject({ projectName: 'Agent E', keptCopy: true,
      previousProjectId: null, previousProjectName: null });
  });

  it('a way back to a project that still exists is kept', async () => {
    saved = { A: project('A', NAMES.A) };
    vi.mocked(projects.listProjects).mockResolvedValue(listing('A', 'rev-A'));
    await state().initialize();
    unsubscribe = subscribeProjectAutosave();
    noteBackendConnection('offline');
    saved.E = project('E', NAMES.E, []);
    emit({ type: 'graphSync', workspaceRevision: 'rev-E', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [],
      empty: true, graphReplaced: true, projectSwitch: { projectId: 'E', projectName: NAMES.E, previousProjectId: 'A',
        previousProjectName: NAMES.A, previousRevision: 'rev-A', created: true, actor: { kind: 'agent', name: 'Codex' } } });
    await flush();
    vi.mocked(projects.listProjects).mockResolvedValue(listing('E', 'rev-E'));
    noteBackendConnection('online');
    await vi.waitFor(() => expect(state().switchNotice).not.toBeNull());
    expect(state().switchNotice).toMatchObject({ previousProjectId: 'A', previousProjectName: 'Agent A' });
  });

  it('"Back to" a project deleted after the toast came up drops the way back, with no error', async () => {
    saved = { E: project('E', NAMES.E, []) };
    vi.mocked(projects.listProjects).mockResolvedValue(listing('E', 'rev-E'));
    await state().initialize();
    useProjectStore.setState({ switchNotice: { actorName: 'Codex', created: true, projectName: 'Agent E',
      previousProjectId: 'A', previousProjectName: 'Agent A', keptCopy: false } });
    vi.mocked(projects.openProject).mockRejectedValue(gone());
    await state().switchBack();
    expect(state().switchNotice).toBeNull();
    expect(state().error).toBeNull();
  });
});
