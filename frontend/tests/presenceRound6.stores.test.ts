import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

// PR #204 round 6, GM r7 (2): a load screen refused only because this tab isn't connected as the
// person says so in the "because" form, shows no Try again (the promote does the retry), and
// loads again on the promote through retryOnPromote. Any other failure keeps its Try again.
// Harness from paramsVersionReload.test.ts.
const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(),
  subscribe: vi.fn((handler) => { socket.handlers.push(handler); return () => {
    socket.handlers = socket.handlers.filter((item) => item !== handler);
  }; }),
  // The project coordinator runs ahead of other handlers (wsClient.subscribeFirst).
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
import { reportParamsOutdated } from '../src/lib/paramsOutdated';
import * as session from '../src/lib/personSession';
import { pendingPromoteRetries } from '../src/lib/clearsOnPromote';
import { PERSON_REQUIRED_CODE } from '../src/lib/errorCopy';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import type { SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const NEXT = GRAPH_PARAMS_VERSION + 1;
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
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
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
  vi.useRealTimers();
  await flush();
  setProjectContext(null);
  session.notePersonPromoted();
});

const SWITCH = { type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
  projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'alpha',
    previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' } } };

describe('GM r7 (2): the load screens retry on the promote', () => {
  it('a switch refused by the gate: the because line, no Try again, and the load runs again on the promote', async () => {
    session.reportPersonRequired();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(gate("Couldn't load your projects."));
    emit(SWITCH);
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(BECAUSE('switch projects')));
    expect(projectRetryOffer(useProjectStore.getState())).toBe('none');
    expect(useProjectStore.getState().screen).toBe('home');
    expect(pendingPromoteRetries()).toBeGreaterThan(0);
    const calls = vi.mocked(projects.listProjects).mock.calls.length;
    session.notePersonPromoted();
    await vi.waitFor(() => expect(vi.mocked(projects.listProjects).mock.calls.length).toBeGreaterThan(calls));
    await vi.waitFor(() => expect(useProjectStore.getState()).toMatchObject({ error: null, initialized: true }));
  });

  it('a switch that failed for another reason keeps its own line and its Try again', async () => {
    vi.mocked(projects.listProjects).mockRejectedValueOnce(
      new projects.ProjectRequestError("Nebula didn't respond. Try again.", 503, { heading: "Couldn't load your projects." }));
    emit(SWITCH);
    await vi.waitFor(() => expect(useProjectStore.getState().error).toContain("couldn't follow it"));
    expect(projectRetryOffer(useProjectStore.getState())).not.toBe('none');
  });

  it('the first load refused by the gate: "load your work", no Try again, loaded on the promote', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    session.reportPersonRequired();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(gate("Couldn't load your projects."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe(BECAUSE('load your work'));
    expect(projectRetryOffer(useProjectStore.getState())).toBe('none');
    session.notePersonPromoted();
    await vi.waitFor(() => expect(useProjectStore.getState()).toMatchObject({ error: null, initialized: true }));
  });

  it('the recovered copy of an update\'s reload refused by the gate: the verb fits, no Try again, sent again on the promote', async () => {
    const [node] = useGraphStore.getState().nodes;
    useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value: 'Unsaved edit' } } }] });
    session.reportPersonRequired();
    vi.mocked(projects.recoverProject).mockRejectedValueOnce(gate("Couldn't recover the project."));
    reportParamsOutdated(NEXT);
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(BECAUSE('save your unsaved edits')));
    expect(projectRetryOffer(useProjectStore.getState())).toBe('none');
    const sent = vi.mocked(projects.recoverProject).mock.calls.length;
    session.notePersonPromoted();
    await vi.waitFor(() => expect(vi.mocked(projects.recoverProject).mock.calls.length).toBeGreaterThan(sent));
  });

  // Review 5 NIT-3 (round 7): by the screen's state, not its line.
  it('a screen that loaded another way is not loaded again on the promote', async () => {
    session.reportPersonRequired();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(gate("Couldn't load your projects."));
    emit(SWITCH);
    await vi.waitFor(() => expect(useProjectStore.getState().error).toBe(BECAUSE('switch projects')));
    useProjectStore.setState({ error: 'Something else.', initialized: true });
    const calls = vi.mocked(projects.listProjects).mock.calls.length;
    session.notePersonPromoted();
    await flush();
    expect(vi.mocked(projects.listProjects).mock.calls.length).toBe(calls);
  });
});
