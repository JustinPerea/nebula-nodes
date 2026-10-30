import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

// PR #204 round 7: the load screens' verb fits what was refused (GM r9 2), and their retry on the
// promote reads the screen's state, not its line (review 5 NIT-3). Harness from
// presenceRound6.stores.test.ts.
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  subscribeFirst: vi.fn((handler) => { socket.handlers.unshift(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
} }));
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
  restoreProject: vi.fn(),
}));

import { projectRetryOffer, useProjectStore, resetProjectStoreForTests, subscribeProjectAutosave } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as session from '../src/lib/personSession';
import { clearsOnPromote } from '../src/lib/clearsOnPromote';
import { PERSON_REQUIRED_CODE } from '../src/lib/errorCopy';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const gate = (heading: string) => new projects.ProjectRequestError('Only the person can do this.', 403, { heading, code: PERSON_REQUIRED_CODE });
const BECAUSE = (what: string) => `Nebula couldn’t ${what} because this tab isn’t connected as you. Open the link Nebula printed when it started.`;
const initial = useProjectStore.getState();
function project(id = 'alpha'): SavedProject {
  return {
    id, name: id, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: id }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue({ projects: [project()], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.recoverProject).mockResolvedValue(project('recovered'));
  await useProjectStore.getState().initialize();
  unsubscribe = subscribeProjectAutosave();
  session.resetPersonSessionForTests();
});
afterEach(async () => {
  unsubscribe?.(); unsubscribe = null;
  await flush();
  setProjectContext(null);
  session.notePersonPromoted();
});

function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}

describe('GM r9 (2): every load screen\'s verb fits what was refused', () => {
  it('the first load refused while saving the recovered edits says "save your unsaved edits", as the update reload does', async () => {
    // Another window changed the workspace while this tab held unsaved edits: the next load
    // saves them as a recovered copy first (recoverPendingWork), and the gate refuses that.
    const [node] = useGraphStore.getState().nodes;
    useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value: 'Unsaved alpha edits' } } }] });
    emit({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, workspaceRevision: 'rev-b', nodes: [], edges: [], empty: true });
    expect(useProjectStore.getState().initialized).toBe(false);
    session.reportPersonRequired();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(gate("Couldn't recover the project."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe(BECAUSE('save your unsaved edits'));
    expect(projectRetryOffer(useProjectStore.getState())).toBe('none');
    // On the promote the same copy goes again.
    const sent = vi.mocked(projects.recoverProject).mock.calls.length;
    session.notePersonPromoted();
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject).mock.calls.length).toBeGreaterThan(sent));
  });

  it('an agent\'s switch whose recovered copy the gate refused says "save your unsaved edits"', async () => {
    const [node] = useGraphStore.getState().nodes;
    useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value: 'Unsaved alpha edits' } } }] });
    session.reportPersonRequired();
    // The handoff into the project left fails, its saved copy lacks the edits, and the gate
    // refuses the recovered copy.
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError('Changed.', 409, { heading: "Couldn't save the project." }));
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(gate("Couldn't recover the project."));
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'alpha',
        previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' } } });
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(BECAUSE('save your unsaved edits')));
    expect(projectRetryOffer(useProjectStore.getState())).toBe('none');
  });

  it('the first load refused at the load itself still says "load your work"', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    session.reportPersonRequired();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(gate("Couldn't load your projects."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe(BECAUSE('load your work'));
  });
});

describe('review 5 NIT-3: the load retry reads the screen, not its line', () => {
  it('another refusal\'s line took the screen\'s place and cleared first: the load still runs on the promote', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    session.reportPersonRequired();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(gate("Couldn't load your projects."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe(BECAUSE('load your work'));
    // Another person-gate line replaces it and registers its own clear, which the sweep runs first.
    useProjectStore.setState({ error: 'Another refusal.' });
    clearsOnPromote(() => useProjectStore.setState({ error: null }));
    const calls = vi.mocked(projects.listProjects).mock.calls.length;
    session.notePersonPromoted();
    await vi.waitFor(() => expect(vi.mocked(projects.listProjects).mock.calls.length).toBeGreaterThan(calls));
    await vi.waitFor(() => expect(useProjectStore.getState()).toMatchObject({ error: null, initialized: true }));
  });
});
