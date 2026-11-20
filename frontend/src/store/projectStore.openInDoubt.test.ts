import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Design: an open the tab stopped waiting for (20 s) is in doubt, not failed. If the server
// commits it later and the person started nothing newer, the tab follows it as if the answer had
// come in time; a newer open or create wins, is sent once more after a stale refusal, and the
// late commit only keeps the tab in step. Nothing ends with no project while the server has one
// open, and nothing ends in 409s with no button.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  openProject: vi.fn(),
  createProject: vi.fn(),
  recoverProject: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  fetchCLIGraph: vi.fn(),
}));

import * as api from '../lib/projects';
import { fetchCLIGraph } from '../lib/api';
import { OPEN_TIMEOUT_MS, openTimedOutLine } from '../lib/errorCopy';
import { getProjectContext, setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { TAB_ID } from '../lib/tabId';
import type { ProjectSnapshot, ProjectSummary, SavedProject } from '../lib/projects';
import { useGraphStore } from './graphStore';
import { useUIStore } from './uiStore';
import { core, projectRetryOffer, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import { workspaceSync } from './projectFlows';

const listProjects = vi.mocked(api.listProjects);
const openProject = vi.mocked(api.openProject);
const createProject = vi.mocked(api.createProject);
const getProject = vi.mocked(api.getProject);
const saveProject = vi.mocked(api.saveProject);
const graph = vi.mocked(fetchCLIGraph);

const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const alpha = summary('p1', 'Alpha');
const beta = summary('p2', 'Beta');
const gamma = summary('p3', 'Gamma');
const empty: ProjectSnapshot = { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null };
const saved = (project: ProjectSummary): SavedProject => ({ ...project, snapshot: empty });
const activation = (project: ProjectSummary, revision: string) =>
  ({ project: saved(project), workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION }) as never;
/** What the server has now: its open project and revision (a listing, a project read, the live graph). */
const server = (active: ProjectSummary | null, revision: string) => {
  listProjects.mockResolvedValue({ projects: [alpha, beta, gamma], trash: [], activeProjectId: active?.id ?? null,
    workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION } as never);
  if (active) getProject.mockResolvedValue(saved(active));
  graph.mockResolvedValue({ nodes: [], edges: [], empty: true, workspaceRevision: revision } as never);
};
/** The graph sync of the person's open of `project` landing at `revision` (no switch notice: the
 * person's open of another project carries none). */
const committed = (project: ProjectSummary, revision: string, more: object = {}) => ({
  type: 'graphSync', nodes: [], edges: [], empty: true, graphReplaced: true, activeProjectId: project.id,
  workspaceRevision: revision, paramsVersion: GRAPH_PARAMS_VERSION, ...more,
}) as never;
const stale = () => new api.ProjectRequestError('This project view is out of date. Reload projects before saving or switching.', 409);
const state = () => useProjectStore.getState();
const settle = () => vi.advanceTimersByTimeAsync(0);
const hang = () => new Promise<never>(() => {});

/** Alpha loaded and saved at r1, on its canvas. */
async function alphaLoaded() {
  setProjectContext({ id: 'p1', revision: 'r1' });
  useProjectStore.setState({ initialized: true, loading: false, screen: 'workspace', activeProject: alpha,
    projects: [alpha, beta, gamma], workspaceRevision: 'r1', dirty: false, saveStatus: 'saved' });
  await state().flush();
  saveProject.mockClear();
}
/** Projects listed at r1, nothing open. */
function nothingOpen() {
  setProjectContext(null);
  useProjectStore.setState({ initialized: true, loading: false, screen: 'home', activeProject: null,
    projects: [alpha, beta, gamma], workspaceRevision: 'r1' });
}
/** Open Beta, and no answer for 20 s. */
async function betaTimesOut() {
  openProject.mockImplementationOnce(hang);
  void state().open('p2');
  await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
  expect(state().error).toBe(openTimedOutLine('Beta'));
  expect(state().busy).toBe(false);
}

let unsubscribe: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of [listProjects, openProject, createProject, getProject, saveProject, graph]) mock.mockReset();
  saveProject.mockImplementation(async (id, snapshot) => ({ ...saved(id === 'p1' ? alpha : id === 'p2' ? beta : gamma), snapshot }));
  resetProjectStoreForTests();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
  useProjectStore.setState({ busy: false, error: null, errorRetry: null, switchNotice: null, unsavedEdits: null });
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  unsubscribe();
  vi.useRealTimers();
});

describe('the timed-out open lands later, and nothing newer started', () => {
  it('with Alpha loaded: the tab opens Beta, its canvas shows, the line goes, and the next open sends the new revision (finding 1)', async () => {
    await alphaLoaded();
    await betaTimesOut();
    expect(state().screen).toBe('home');
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
    await settle();
    expect(state()).toMatchObject({ screen: 'workspace', error: null, errorRetry: null, busy: false, initialized: true });
    expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r2' });
    expect(core.personOpenedId).toBe('p2');
    expect(state().switchNotice).toBeNull();

    openProject.mockResolvedValueOnce(activation(gamma, 'r3'));
    await state().open('p3');
    expect(openProject).toHaveBeenLastCalledWith('p3', 'r2');
    expect(state().activeProject?.id).toBe('p3');
    expect(state().error).toBeNull();
  });

  it('with Alpha loaded and edits not saved yet: they go to Alpha (the handoff) before the tab opens Beta', async () => {
    await alphaLoaded();
    await betaTimesOut();
    // The person went back to Alpha's canvas (no request) and typed.
    state().open('p1');
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt: 'kept' }, outputs: {} } }] as never });
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
    await settle();
    expect(saveProject).toHaveBeenCalledTimes(1);
    const [id, snapshot, revision] = saveProject.mock.calls[0];
    expect([id, revision, snapshot.nodes[0]?.data.params.prompt]).toEqual(['p1', 'r1', 'kept']);
    expect(state().screen).toBe('workspace');
  });

  it('with nothing open: the tab opens Beta instead of staying on Projects with no project (finding 3)', async () => {
    nothingOpen();
    await betaTimesOut();
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
    await settle();
    expect(state()).toMatchObject({ screen: 'workspace', error: null, busy: false });
    expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r2' });
  });

  it('a commit seen while the open still waited is followed at the timeout', async () => {
    nothingOpen();
    openProject.mockImplementationOnce(hang);
    void state().open('p2');
    await vi.advanceTimersByTimeAsync(5_000);
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
    expect(state()).toMatchObject({ screen: 'workspace', error: null });
  });

  it('a commit the tab never heard of: the next action reads the revision first, with a project loaded too', async () => {
    await alphaLoaded();
    await betaTimesOut();
    server(beta, 'r2');
    createProject.mockResolvedValueOnce(activation(summary('p4', 'New'), 'r3'));
    await state().createProject('New');
    expect(listProjects.mock.invocationCallOrder[0]).toBeLessThan(createProject.mock.invocationCallOrder[0]);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith('New', 'r2');
    expect(state().activeProject?.id).toBe('p4');
  });
});

describe('a newer open or create started since', () => {
  it('Alpha loaded: Beta lands while Gamma’s open is on its way; Gamma is refused as stale, goes once more, and wins (finding 2)', async () => {
    await alphaLoaded();
    await betaTimesOut();
    server(null, 'r1');
    let refuse: (error: unknown) => void = () => {};
    openProject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    openProject.mockResolvedValueOnce(activation(gamma, 'r3'));
    const opening = state().open('p3');
    await settle();
    expect(openProject).toHaveBeenLastCalledWith('p3', 'r1');
    // Beta commits while Gamma's open is under way: its sync comes while the tab is busy.
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    refuse(stale());
    await opening;
    await settle();
    expect(openProject.mock.calls.map((call) => call.slice(0, 2))).toEqual([['p2', 'r1'], ['p3', 'r1'], ['p3', 'r2']]);
    expect(state()).toMatchObject({ screen: 'workspace', error: null, busy: false });
    expect(state().activeProject?.id).toBe('p3');
    // Beta's sync, kept until Gamma finished, changes nothing.
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().activeProject?.id).toBe('p3');
    expect(getProjectContext()).toEqual({ id: 'p3', revision: 'r3' });
    expect(state().screen).toBe('workspace');

    openProject.mockResolvedValueOnce(activation(alpha, 'r4'));
    await state().open('p1');
    expect(openProject).toHaveBeenLastCalledWith('p1', 'r3');
    expect(state().error).toBeNull();
  });

  it('nothing open: New project is refused as stale after Beta landed, goes once more, and wins', async () => {
    nothingOpen();
    await betaTimesOut();
    server(null, 'r1');
    let refuse: (error: unknown) => void = () => {};
    createProject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    createProject.mockResolvedValueOnce(activation(summary('p4', 'New'), 'r3'));
    const creating = state().createProject('New');
    await settle();
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    refuse(stale());
    await creating;
    await vi.advanceTimersByTimeAsync(1000);
    expect(createProject.mock.calls.map((call) => call.slice(0, 2))).toEqual([['New', 'r1'], ['New', 'r2']]);
    expect(state().activeProject?.id).toBe('p4');
    expect(state()).toMatchObject({ screen: 'workspace', error: null });
  });

  it('refused again: its line with Try again (which reads first), and the tab keeps in step with what the server opened', async () => {
    await alphaLoaded();
    await betaTimesOut();
    server(null, 'r1');
    let refuse: (error: unknown) => void = () => {};
    openProject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    openProject.mockRejectedValueOnce(stale());
    const opening = state().open('p3');
    await settle();
    server(beta, 'r2');
    workspaceSync(committed(beta, 'r2'));
    refuse(stale());
    await opening;
    expect(openProject).toHaveBeenCalledTimes(3);
    const line = state().error;
    expect(line).not.toBeNull();
    expect(line).not.toBe(openTimedOutLine('Beta'));
    expect(state().errorRetry).toEqual({ action: 'load', reopen: 'p3' });
    expect(projectRetryOffer(state())).toBe('redo');
    // Beta's kept sync: followed quietly, the line stays, and the tab stays on Projects.
    await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
    await settle();
    expect(state()).toMatchObject({ screen: 'home', error: line, busy: false, switchNotice: null });
    expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r2' });

    // Try again reads the projects, then opens Gamma with the revision it read.
    listProjects.mockClear();
    openProject.mockResolvedValueOnce(activation(gamma, 'r3'));
    await state().retry();
    await settle();
    expect(listProjects).toHaveBeenCalled();
    expect(listProjects.mock.invocationCallOrder[0]).toBeLessThan(openProject.mock.invocationCallOrder.at(-1)!);
    expect(openProject).toHaveBeenLastCalledWith('p3', 'r2');
    expect(state().activeProject?.id).toBe('p3');
    expect(state().error).toBeNull();
  });

  it('a refusal while the revision hasn’t moved is not sent again', async () => {
    await alphaLoaded();
    await betaTimesOut();
    server(null, 'r1');
    openProject.mockRejectedValueOnce(stale());
    await state().open('p3');
    expect(openProject).toHaveBeenCalledTimes(2);
    expect(state().error).not.toBeNull();
  });

  it('the stills: Alpha timed out, Beta opened, then Alpha’s late commit arrives on Projects; Beta stays the open project (finding 4)', async () => {
    nothingOpen();
    openProject.mockImplementationOnce(hang);
    void state().open('p1');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    expect(state().error).toBe(openTimedOutLine('Alpha'));
    // The hang lifted: Alpha committed (r2) before Open Beta read the projects; its sync is late.
    server(alpha, 'r2');
    openProject.mockResolvedValueOnce(activation(beta, 'r3'));
    await state().open('p2');
    expect(openProject).toHaveBeenLastCalledWith('p2', 'r2');
    expect(state().activeProject?.id).toBe('p2');
    useProjectStore.setState({ screen: 'home' });
    workspaceSync(committed(alpha, 'r2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(state().activeProject?.id).toBe('p2');
    expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r3' });
    expect(state().screen).toBe('home');
    expect(state().error).toBeNull();
  });

  it('an open in doubt is settled once the server moved on without it', async () => {
    nothingOpen();
    await betaTimesOut();
    // Something else opened Gamma (r2): Beta, sent with r1, can't land any more.
    workspaceSync(committed(gamma, 'r2'));
    expect(core.opensInDoubt).toEqual([]);
  });
});

describe('a commit held for a Studio field in progress', () => {
  it('keeps its doubt while an agent’s edit syncs in, then the blur follows it as the person’s own open, with no conflict line', async () => {
    await alphaLoaded();
    await betaTimesOut();
    // Back to Alpha's card (no request), typing in a Studio field, edits not saved yet.
    await state().open('p1');
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt: 'kept' }, outputs: {} } }] as never });
    useUIStore.setState({ viewMode: 'moodboard' as never });
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();
    try {
      server(beta, 'r2');
      workspaceSync(committed(beta, 'r2'));
      // An agent's edit to Beta, at the revision Beta's commit made.
      workspaceSync({ type: 'graphSync', nodes: [], edges: [], empty: true, activeProjectId: 'p2', workspaceRevision: 'r2',
        paramsVersion: GRAPH_PARAMS_VERSION } as never);
      await settle();
      expect(core.opensInDoubt.map((doubt) => doubt.id)).toEqual(['p2']);
      expect(state()).toMatchObject({ error: null, unsavedEdits: null, busy: false });
      expect(state().activeProject?.id).toBe('p1');

      field.blur();
      await vi.waitFor(() => expect(state().activeProject?.id).toBe('p2'));
      await settle();
      expect(state()).toMatchObject({ screen: 'workspace', error: null, errorRetry: null, unsavedEdits: null, busy: false, switchNotice: null });
      expect(getProjectContext()).toEqual({ id: 'p2', revision: 'r2' });
      expect(core.personOpenedId).toBe('p2');
      expect(core.opensInDoubt).toEqual([]);
      // The follow's handoff: Alpha's typing went to Alpha.
      expect(saveProject).toHaveBeenCalledTimes(1);
      const [id, snapshot, revision] = saveProject.mock.calls[0];
      expect([id, revision, snapshot.nodes[0]?.data.params.prompt]).toEqual(['p1', 'r1', 'kept']);
    } finally {
      field.remove();
      useUIStore.setState({ viewMode: 'canvas' });
    }
  });
});

describe('a reopen in place that times out (finding 5)', () => {
  const local = [{ id: 'local-1', type: 'model', position: { x: 0, y: 0 },
    data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt: 'a' }, outputs: {} } }] as never;

  it('plain: the timed-out line, the next action reads first, and a late commit is followed in place', async () => {
    await alphaLoaded();
    useGraphStore.setState({ nodes: local });
    await state().flush();
    saveProject.mockClear();
    useProjectStore.setState({ screen: 'home' });
    openProject.mockImplementationOnce(hang);
    void state().open('p1');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    expect(state().error).toBe(openTimedOutLine('Alpha'));
    expect(core.relistBeforeAction).toBe(true);
    expect(core.opensInDoubt.map((doubt) => doubt.id)).toEqual(['p1']);
    server(alpha, 'r2');
    workspaceSync(committed(alpha, 'r2', { projectSwitch: { actor: { kind: 'person', tab: TAB_ID }, projectId: 'p1', projectName: 'Alpha',
      previousProjectId: 'p1', previousProjectName: 'Alpha', previousRevision: 'r1' } }));
    await vi.waitFor(() => expect(getProjectContext()).toEqual({ id: 'p1', revision: 'r2' }));
    await settle();
    expect(state()).toMatchObject({ screen: 'workspace', error: null, busy: false });
  });

  it('refused again after the one resend: its line with Try again, and no quiet reopen goes out', async () => {
    await alphaLoaded();
    useGraphStore.setState({ nodes: local });
    await state().flush();
    saveProject.mockClear();
    await betaTimesOut();
    useProjectStore.setState({ screen: 'home' });
    // The read before the open sees r1; the read after the first refusal sees r2.
    server(null, 'r1');
    listProjects.mockResolvedValueOnce({ projects: [alpha, beta, gamma], trash: [], activeProjectId: null,
      workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    listProjects.mockResolvedValueOnce({ projects: [alpha, beta, gamma], trash: [], activeProjectId: null,
      workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    openProject.mockRejectedValueOnce(stale());
    openProject.mockRejectedValueOnce(stale());
    await state().open('p1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(openProject).toHaveBeenCalledTimes(3);
    expect(openProject).toHaveBeenLastCalledWith('p1', 'r2');
    expect(core.quietReopenOf).toBeNull();
    expect(state().error).not.toBeNull();
    expect(state().error).not.toBe(openTimedOutLine('Beta'));
    expect(state().errorRetry).toEqual({ action: 'load', reopen: 'p1' });
    expect(core.relistBeforeAction).toBe(true);
  });

  it('quiet (activate’s own second try): nothing is said, and the open is in doubt', async () => {
    await alphaLoaded();
    useGraphStore.setState({ nodes: local });
    await state().flush();
    core.quietReopenOf = 'p1';
    openProject.mockImplementationOnce(hang);
    void state().open('p1');
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    expect(state().error).toBeNull();
    expect(state().screen).toBe('workspace');
    expect(state().busy).toBe(false);
    expect(core.opensInDoubt.map((doubt) => doubt.id)).toEqual(['p1']);
  });
});
