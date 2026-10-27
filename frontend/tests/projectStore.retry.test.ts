/**
 * Error copy round 3b (GM - Design): Projects' "Try again" redoes the
 * failed action, never a different one. GM, round 3: "make Retry redo the
 * failed action, never a different one. If that's more than a small change,
 * hide Retry for those failures instead. A Retry that does something else is
 * a defect." The store keeps what failed (`errorRetry`), and
 * projectRetryOffer says what the screen offers: 'redo' (Try again redoes the
 * failure, so the reason is GM's short line), 'reload' (Try again reloads the
 * saved projects, as the line says, with the full reason) or 'none' (no Try
 * again; the full reason).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as projectStore from '../src/store/projectStore';
import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { getProjectContext, setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';
import type { SavedProject, TrashedProject } from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { ConnectionLostError } from '../src/lib/errorCopy';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { WORLD_LABS_NEEDS_CHECK } from '../src/lib/worldLabsWaiting';

vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(),
  openProject: vi.fn(), createProject: vi.fn(), renameProject: vi.fn(), recoverProject: vi.fn(),
  deleteProject: vi.fn(), restoreProject: vi.fn(), purgeTrashedProject: vi.fn(), emptyProjectTrash: vi.fn(),
  pinProjectCover: vi.fn(),
}));

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
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
const trashed = (id: string): TrashedProject => ({ ...summary(id), deletedAt: '2026-10-10T10:00:00Z', purgeAt: '2026-11-09T10:00:00Z' });
const unavailable = (heading: string) => new projects.ProjectRequestError("Nebula didn't respond. Try again.", 503, { heading });
const refused = (heading: string, reason: string, status = 409) => new projects.ProjectRequestError(reason, status, { heading });
// The backend's refusal of an open over an unconfirmed World Labs run (GM, round 13 of PR #114).
const WORLD_LABS_OPEN = 'A World Labs run needs your check first. Use the notice at the top of the screen.';

function listing(overrides: Partial<projects.ProjectList> = {}): projects.ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
// Before round 3b Projects offered Try again (with the short line) beside
// every failure; that is what an older store without the offer reads as.
const offer = () => typeof projectStore.projectRetryOffer === 'function'
  ? projectStore.projectRetryOffer(useProjectStore.getState()) : 'redo';

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetProjectStoreForTests();
  setProjectContext(null);
  window.localStorage.clear();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], providerRecoveries: [], providerStartAmbiguities: [],
    isExecuting: false, isImportingGraph: false, createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(projects.renameProject).mockImplementation(async (id, name) => ({ ...project(id), name }));
  await useProjectStore.getState().initialize();
});
afterEach(() => {
  setProjectContext(null);
});

describe('Projects: Try again redoes the failed action', () => {
  it('a listing that failed at startup: Try again lists again (redo)', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    vi.mocked(projects.listProjects).mockRejectedValueOnce(unavailable("Couldn't load your projects."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe("Couldn't load your projects. Nebula didn't respond. Try again.");
    expect(offer()).toBe('redo');
    await useProjectStore.getState().retry();
    expect(useProjectStore.getState()).toMatchObject({ error: null, initialized: true });
  });

  it('an open answered 503: Try again opens that project, not just the list', async () => {
    vi.mocked(projects.openProject).mockRejectedValueOnce(unavailable("Couldn't open the project."));
    await useProjectStore.getState().open('beta');
    expect(useProjectStore.getState().screen).toBe('home');
    expect(useProjectStore.getState().error).toBe("Couldn't open the project. Nebula didn't respond. Try again.");
    expect(offer()).toBe('redo');
    await useProjectStore.getState().retry();
    // It read the saved projects first (the first open may have landed), then opened beta.
    expect(projects.openProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(projects.openProject).mock.calls[1]).toEqual(['beta', 'rev-a']);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', error: null });
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
  });

  it('an open whose reply was lost after it landed: Try again shows that project without opening it twice', async () => {
    vi.mocked(projects.openProject).mockRejectedValueOnce(new ConnectionLostError(new TypeError('Failed to fetch'), { heading: "Couldn't open the project." }));
    await useProjectStore.getState().open('beta');
    expect(offer()).toBe('redo');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
    await useProjectStore.getState().retry();
    expect(projects.openProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', error: null });
    expect(useProjectStore.getState().activeProject?.id).toBe('beta');
    expect(getProjectContext()).toEqual({ id: 'beta', revision: 'rev-b' });
  });

  it('an open the backend refused (World Labs state, a 404) shows the full line and no Try again', async () => {
    vi.mocked(projects.openProject).mockRejectedValueOnce(refused("Couldn't open the project.", WORLD_LABS_OPEN));
    await useProjectStore.getState().open('beta');
    expect(useProjectStore.getState().error).toBe(`Couldn't open the project. ${WORLD_LABS_OPEN}`);
    expect(offer()).toBe('none');
    vi.mocked(projects.openProject).mockRejectedValueOnce(refused("Couldn't open the project.",
      "That project isn't there anymore. Reload to get the latest projects.", 404));
    await useProjectStore.getState().open('beta');
    expect(offer()).toBe('none');
  });

  it('a create whose reply was lost: Try again reloads the saved projects, as its line says, and never creates twice', async () => {
    vi.mocked(projects.createProject).mockRejectedValueOnce(unavailable("Couldn't create the project."));
    await useProjectStore.getState().createProject('Fresh');
    // Round 3c (GM): "Couldn't confirm…" with the same object, then the mapped reason line.
    expect(useProjectStore.getState().error).toBe("Couldn't confirm the project change. Nebula didn't respond. Try again checks your saved projects; it won't make the change twice.");
    expect(offer()).toBe('reload');
    await useProjectStore.getState().retry();
    expect(projects.createProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('a create stopped by a failed save before it was sent: Try again creates it', async () => {
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data, params: { value: 'edited' } } }] });
    vi.mocked(projects.saveProject).mockRejectedValueOnce(unavailable("Couldn't save the project."));
    vi.mocked(projects.createProject).mockResolvedValue({ project: project('fresh'), workspaceRevision: 'rev-f', paramsVersion: GRAPH_PARAMS_VERSION });
    await useProjectStore.getState().createProject('Fresh');
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(offer()).toBe('redo');
    await useProjectStore.getState().retry();
    expect(projects.createProject).toHaveBeenCalledWith('Fresh', 'rev-a');
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', error: null });
  });

  it('a rename that failed: Try again renames again with the same name', async () => {
    vi.mocked(projects.renameProject).mockRejectedValueOnce(unavailable("Couldn't rename the project."));
    await useProjectStore.getState().rename('beta', 'Bravo');
    expect(offer()).toBe('redo');
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.renameProject).mock.calls).toEqual([['beta', 'Bravo'], ['beta', 'Bravo']]);
    expect(useProjectStore.getState().error).toBeNull();
    expect(useProjectStore.getState().projects.find((item) => item.id === 'beta')?.name).toBe('Bravo');
  });

  it('a rename the backend refused shows the full line and no Try again', async () => {
    vi.mocked(projects.renameProject).mockRejectedValueOnce(refused("Couldn't rename the project.", 'Name the project first.', 422));
    await useProjectStore.getState().rename('beta', '   ');
    expect(offer()).toBe('none');
  });

  it('a delete that failed: Try again deletes it again while it is still listed', async () => {
    vi.mocked(projects.deleteProject).mockRejectedValueOnce(unavailable("Couldn't delete the project."));
    await useProjectStore.getState().remove('beta');
    expect(offer()).toBe('redo');
    vi.mocked(projects.deleteProject).mockResolvedValueOnce({ deletedProjectId: 'beta', trashedProject: trashed('beta'),
      activeProjectId: 'alpha', workspaceRevision: 'rev-a' });
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.deleteProject).mock.calls).toEqual([['beta', 'rev-a'], ['beta', 'rev-a']]);
    expect(useProjectStore.getState().projects.map((item) => item.id)).toEqual(['alpha']);
    expect(useProjectStore.getState().lastDeleted).toEqual({ id: 'beta', name: 'beta' });
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('a delete whose reply was lost after it landed: Try again finds it already deleted and sends nothing', async () => {
    vi.mocked(projects.deleteProject).mockRejectedValueOnce(unavailable("Couldn't delete the project."));
    await useProjectStore.getState().remove('beta');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ projects: [summary('alpha')], trash: [trashed('beta')] }));
    await useProjectStore.getState().retry();
    expect(projects.deleteProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projects.map((item) => item.id)).toEqual(['alpha']);
    expect(useProjectStore.getState().trash.map((item) => item.id)).toEqual(['beta']);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('deleting the open project with no reply: Try again reloads the saved projects (the full line), never a second delete', async () => {
    vi.mocked(projects.deleteProject).mockRejectedValueOnce(unavailable("Couldn't delete the project."));
    await useProjectStore.getState().remove('alpha');
    expect(useProjectStore.getState().error).toBe("Couldn't confirm the project was deleted. Nebula didn't respond. Try again checks your saved projects; it won't make the change twice.");
    expect(offer()).toBe('reload');
    await useProjectStore.getState().retry();
    expect(projects.deleteProject).toHaveBeenCalledTimes(1);
  });

  it('a restore that failed: Try again restores it again; one that is gone shows no Try again', async () => {
    useProjectStore.setState({ trash: [trashed('gamma')] });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ trash: [trashed('gamma')] }));
    vi.mocked(projects.restoreProject).mockRejectedValueOnce(unavailable("Couldn't restore the project."));
    await useProjectStore.getState().restore('gamma');
    expect(offer()).toBe('redo');
    vi.mocked(projects.restoreProject).mockResolvedValueOnce(summary('gamma'));
    await useProjectStore.getState().retry();
    expect(projects.restoreProject).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().projects.map((item) => item.id)).toContain('gamma');

    useProjectStore.setState({ trash: [trashed('delta')] });
    vi.mocked(projects.restoreProject).mockRejectedValueOnce(refused("Couldn't restore the project.",
      "That project isn't in Recently deleted anymore. Reload to get the latest list.", 404));
    await useProjectStore.getState().restore('delta');
    expect(offer()).toBe('none');
  });

  it('delete for good and empty Recently deleted: Try again redoes them on what is still there', async () => {
    useProjectStore.setState({ trash: [trashed('gamma'), trashed('delta')] });
    vi.mocked(projects.purgeTrashedProject).mockRejectedValueOnce(unavailable("Couldn't delete the project for good."));
    await useProjectStore.getState().purge('gamma');
    expect(offer()).toBe('redo');
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ trash: [trashed('gamma'), trashed('delta')] }));
    vi.mocked(projects.purgeTrashedProject).mockResolvedValueOnce([trashed('delta')]);
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.purgeTrashedProject).mock.calls).toEqual([['gamma'], ['gamma']]);
    expect(useProjectStore.getState().trash.map((item) => item.id)).toEqual(['delta']);

    useProjectStore.setState({ trash: [trashed('delta'), trashed('epsilon')] });
    vi.mocked(projects.emptyProjectTrash).mockRejectedValueOnce(unavailable("Couldn't empty Recently deleted."));
    await useProjectStore.getState().emptyTrash();
    expect(offer()).toBe('redo');
    // An agent deleted another project meanwhile: it stays (only what the person saw goes).
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ trash: [trashed('zeta'), trashed('delta'), trashed('epsilon')] }));
    vi.mocked(projects.emptyProjectTrash).mockResolvedValueOnce([trashed('zeta')]);
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.emptyProjectTrash).mock.calls.at(-1)).toEqual([['delta', 'epsilon']]);
    expect(useProjectStore.getState().trash.map((item) => item.id)).toEqual(['zeta']);
  });

  it('a cover pin that failed: Try again pins it again', async () => {
    vi.mocked(projects.pinProjectCover).mockRejectedValueOnce(unavailable("Couldn't set the cover."));
    await useProjectStore.getState().pinCover('beta', '/api/outputs/a.png');
    expect(offer()).toBe('redo');
    vi.mocked(projects.pinProjectCover).mockResolvedValueOnce(summary('beta'));
    await useProjectStore.getState().retry();
    expect(vi.mocked(projects.pinProjectCover).mock.calls).toEqual([['beta', '/api/outputs/a.png'], ['beta', '/api/outputs/a.png']]);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it('an autosave that failed: Try again saves (no listing), and a later rename failure does not change what the save Retry does', async () => {
    await useProjectStore.getState().open('alpha'); // already loaded: to the canvas
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data, params: { value: 'edited' } } }] });
    vi.mocked(projects.saveProject).mockRejectedValueOnce(unavailable("Couldn't save the project."));
    await useProjectStore.getState().flush().catch(() => {});
    expect(useProjectStore.getState().saveStatus).toBe('error');
    expect(offer()).toBe('redo');
    vi.mocked(projects.listProjects).mockClear();
    await useProjectStore.getState().retry();
    expect(projects.saveProject).toHaveBeenCalledTimes(2);
    expect(projects.listProjects).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ saveStatus: 'saved', error: null });

    // The canvas's "Save failed · Retry" saves even when the error shown is another action's.
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data, params: { value: 'edited again' } } }] });
    vi.mocked(projects.saveProject).mockRejectedValueOnce(unavailable("Couldn't save the project."));
    await useProjectStore.getState().flush().catch(() => {});
    vi.mocked(projects.pinProjectCover).mockRejectedValueOnce(unavailable("Couldn't set the cover."));
    await useProjectStore.getState().pinCover('beta', null);
    expect(useProjectStore.getState()).toMatchObject({ saveStatus: 'error', saveError: "Couldn't save the project. Nebula didn't respond. Try again." });
    await useProjectStore.getState().retrySave();
    expect(projects.pinProjectCover).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().saveStatus).toBe('saved');
  });

  it('a params-version stop that asks for a reload or a rebuild offers no Try again', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    setProjectContext(null);
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ paramsVersion: GRAPH_PARAMS_VERSION - 1 }));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toMatch(/Restart the backend, then reload/);
    expect(offer()).toBe('none');
  });
});

// Round 3b review: a refusal for good at startup still leaves a way out, and a
// World Labs hold on the canvas is refused in the browser with GM's line and
// no Try again (redoing it fails the same local check until the person unlocks).
describe('Projects: review fixes', () => {
  const ambiguity = { runId: 'run-wl', nodeId: 'n-wl', kind: 'worldlabs-environment' as const,
    message: 'held', durable: true };
  const holdLine = (heading: string) => `${heading} ${WORLD_LABS_NEEDS_CHECK}`;
  it("the Projects screen's own check says GM's round 13 line, word for word", () => {
    expect(holdLine("Couldn't open the project.")).toBe(
      "Couldn't open the project. A World Labs run needs your check first. Use the notice at the top of the screen.");
  });

  it('a startup load refused for good (the active project went away): Try again reloads, with the whole line, and recovers', async () => {
    useProjectStore.setState(initial, true);
    resetProjectStoreForTests();
    vi.mocked(projects.getProject).mockRejectedValueOnce(refused("Couldn't load the project.",
      "That project isn't there anymore. Reload to get the latest projects.", 404));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState()).toMatchObject({ initialized: false,
      error: "Couldn't load the project. That project isn't there anymore. Reload to get the latest projects." });
    expect(offer()).toBe('reload');
    await useProjectStore.getState().retry();
    expect(projects.listProjects).toHaveBeenCalledTimes(3);
    expect(useProjectStore.getState()).toMatchObject({ error: null, initialized: true });
  });

  it('opening another project while a node holds an unconfirmed World Labs start: GM\'s line, no Try again, no request', async () => {
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity] });
    await useProjectStore.getState().open('beta');
    expect(useProjectStore.getState()).toMatchObject({ error: holdLine("Couldn't open the project."), errorRetry: null });
    expect(offer()).toBe('none');
    expect(projects.openProject).not.toHaveBeenCalled();
  });

  it('the same for an unconfirmed World Labs run, and for a new project', async () => {
    useGraphStore.setState({ uncertainWorldLabsRunId: 'run-wl' });
    await useProjectStore.getState().open('beta');
    expect(useProjectStore.getState()).toMatchObject({ error: holdLine("Couldn't open the project."), errorRetry: null });
    await useProjectStore.getState().createProject('New');
    expect(useProjectStore.getState()).toMatchObject({ error: holdLine("Couldn't create the project."), errorRetry: null });
    expect(projects.openProject).not.toHaveBeenCalled();
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it('deleting the open project while a node holds World Labs state: GM\'s line, no Try again, no request', async () => {
    useGraphStore.setState({ providerStartAmbiguities: [ambiguity] });
    await useProjectStore.getState().remove('alpha');
    expect(useProjectStore.getState()).toMatchObject({ error: holdLine("Couldn't delete the project."), errorRetry: null });
    expect(offer()).toBe('none');
    expect(projects.deleteProject).not.toHaveBeenCalled();
  });

  it('a run that is only going keeps the busy line with Try again (it can succeed once the run ends)', async () => {
    useGraphStore.setState({ isExecuting: true });
    await useProjectStore.getState().open('beta');
    // Round 3c (GM): "A run is still going. Let it finish or stop it, then try again."
    expect(useProjectStore.getState().error).toBe("Couldn't open the project. A run is still going. Let it finish or stop it.");
    expect(offer()).toBe('redo');
    useGraphStore.setState({ isExecuting: false });
    await useProjectStore.getState().retry();
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', error: null });
  });
});

// Error copy round 3c (GM - Design), the Projects screen's older lines:
// ""Could not confirm…" → "Couldn't confirm…" with the same object, then the
// mapped reason line." and ""Finish or stop the current run…" → "A run is
// still going. Let it finish or stop it, then try again."" Every variant.
describe('round 3c: the older Projects lines', () => {
  const STILL_GOING = 'A run is still going. Let it finish or stop it.';

  it('a lost create reply with no connection: the connection line after the heading', async () => {
    vi.mocked(projects.createProject).mockRejectedValueOnce(new ConnectionLostError(new TypeError('Failed to fetch'),
      { heading: "Couldn't create the project." }));
    await useProjectStore.getState().createProject('Fresh');
    expect(useProjectStore.getState().error).toBe("Couldn't confirm the project change. Nebula's server isn't answering. Make sure it's running. Try again checks your saved projects; it won't make the change twice.");
    expect(offer()).toBe('reload');
  });

  it('New project while a run is going', async () => {
    useGraphStore.setState({ isExecuting: true });
    await useProjectStore.getState().createProject('New');
    expect(useProjectStore.getState().error).toBe(`Couldn't create the project. ${STILL_GOING}`);
    expect(offer()).toBe('redo');
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it('deleting the open project while a run is going', async () => {
    useGraphStore.setState({ isExecuting: true });
    await useProjectStore.getState().remove('alpha');
    expect(useProjectStore.getState().error).toBe(`Couldn't delete the project. ${STILL_GOING}`);
    expect(offer()).toBe('redo');
    expect(projects.deleteProject).not.toHaveBeenCalled();
  });

  it('a canvas that turned busy while the switch was saving, and one that refuses the load', async () => {
    const original = useGraphStore.getState().reserveGraphImport;
    useGraphStore.setState({ reserveGraphImport: () => false });
    try {
      await useProjectStore.getState().open('beta');
      expect(useProjectStore.getState().error).toBe(`Couldn't open the project. ${STILL_GOING}`);
    } finally { useGraphStore.setState({ reserveGraphImport: original }); }
    const load = useGraphStore.getState().loadProjectGraph;
    useGraphStore.setState({ loadProjectGraph: () => false });
    try {
      await useProjectStore.getState().open('beta');
      expect(useProjectStore.getState().error).toBe(`Couldn't open the project. ${STILL_GOING}`);
    } finally { useGraphStore.setState({ loadProjectGraph: load }); }
  });

  it('no line on the Projects screen still says "Could not" or "Finish or stop"', async () => {
    const source = await import('../src/store/projectStore.ts?raw').then((module) => module.default as string);
    expect(source).not.toMatch(/Could not confirm|Finish or stop|still busy\. Finish|became busy/);
    expect(source).not.toMatch(/\(\$\{(reason|error)/);
  });
});


describe('round 3c-2: the startup load never shows an error\'s own message', () => {
  beforeEach(() => { useProjectStore.setState(initial, true); resetProjectStoreForTests(); });

  it('a plain Error reads the heading and GM\'s general line', async () => {
    vi.mocked(projects.getProject).mockRejectedValueOnce(new Error('internal: snapshot.nodes is not iterable'));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error)
      .toBe("Couldn't load your projects. Try again, or reload the page if it keeps happening.");
    expect(offer()).not.toBe('none');
  });

  it('a project that changed while loading says so under the heading', async () => {
    vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValueOnce({ nodes: [], edges: [], empty: true,
      workspaceRevision: 'rev-other' });
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error)
      .toBe("Couldn't load your projects. The active project changed while loading.");
  });

  it("a request's own written line still reads as it did", async () => {
    vi.mocked(projects.getProject).mockRejectedValueOnce(unavailable("Couldn't load the project."));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe("Couldn't load the project. Nebula didn't respond. Try again.");
  });
});

describe("round 3e: every Projects action reads a plain Error through GM's mapping", () => {
  const GENERAL = "Try again, or reload if it keeps happening.";
  const RAW = 'internal: snapshot.nodes is not iterable at /Users/someone/state.json';

  it.each([
    ['rename', "Couldn't rename the project.", async () => {
      vi.mocked(projects.renameProject).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().rename('alpha', 'New name');
    }],
    ['restore', "Couldn't restore the project.", async () => {
      vi.mocked(projects.restoreProject).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().restore('alpha');
    }],
    ['purge', "Couldn't delete the project for good.", async () => {
      vi.mocked(projects.purgeTrashedProject).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().purge('alpha');
    }],
    ['emptyTrash', "Couldn't empty Recently deleted.", async () => {
      useProjectStore.setState({ trash: [trashed('gamma')] });
      vi.mocked(projects.emptyProjectTrash).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().emptyTrash();
    }],
    ['cover', "Couldn't set the cover.", async () => {
      vi.mocked(projects.pinProjectCover).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().pinCover('alpha', '/api/outputs/a.png');
    }],
    ['delete', "Couldn't delete the project.", async () => {
      vi.mocked(projects.deleteProject).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().remove('beta');
    }],
    ['open', "Couldn't open the project.", async () => {
      vi.mocked(projects.openProject).mockRejectedValueOnce(new Error(RAW));
      await useProjectStore.getState().open('beta');
    }],
  ])('%s: the heading and the general line, Try again kept', async (action, heading, run) => {
    await run();
    const state = useProjectStore.getState();
    expect(state.error).toBe(`${heading} ${GENERAL}`);
    expect(state.error).not.toContain('iterable');
    // An open that may have landed keeps 3b's Try again: read the list, then open it.
    expect(state.errorRetry).toMatchObject(action === 'open' ? { action: 'load', reopen: 'beta' } : { action });
    expect(offer()).toBe('redo');
  });

  it("a failed save says the save's heading, never the error's own words", async () => {
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new Error(RAW));
    useGraphStore.setState({ nodes: [{ id: 'n9', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Text', params: { value: 'changed' }, state: 'idle', outputs: {} } }] });
    await useProjectStore.getState().flush().catch(() => {});
    const state = useProjectStore.getState();
    expect(state.saveError).toBe(`Couldn't save the project. ${GENERAL}`);
    expect(state.error).toBe(`Couldn't save the project. ${GENERAL}`);
    expect(state.errorRetry?.action).toBe('save');
  });

  it('Try again still redoes the rename that failed', async () => {
    vi.mocked(projects.renameProject).mockRejectedValueOnce(new Error(RAW));
    await useProjectStore.getState().rename('alpha', 'New name');
    await useProjectStore.getState().retry();
    expect(projects.renameProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(projects.renameProject).mock.calls[1]).toEqual(['alpha', 'New name']);
    expect(useProjectStore.getState().error).toBeNull();
  });

  it("a request's own written line still reads as it did", async () => {
    vi.mocked(projects.renameProject).mockRejectedValueOnce(unavailable("Couldn't rename the project."));
    await useProjectStore.getState().rename('alpha', 'New name');
    expect(useProjectStore.getState().error).toBe("Couldn't rename the project. Nebula didn't respond. Try again.");
  });
});

// Round 15 of PR #114: offline is read-only, and an autosave is held, not
// failed. Nothing is sent, the header keeps "Unsaved changes" (no "Save
// failed · Retry", no toast), and the save goes by itself once Nebula answers.
describe('Projects: an autosave while offline', () => {
  it('is held (not sent, not an error) and saves on reconnect', async () => {
    const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
    resetBackendConnectionForTests();
    await useProjectStore.getState().open('alpha');
    vi.mocked(projects.saveProject).mockClear();
    noteBackendConnection('offline');
    useGraphStore.setState({ nodes: [{ ...project().snapshot.nodes[0], data: { ...project().snapshot.nodes[0].data, params: { value: 'edited before the drop' } } }] });
    await useProjectStore.getState().flush();
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ dirty: true, saveStatus: 'unsaved', saveError: null, error: null });
    noteBackendConnection('online');
    await vi.waitFor(() => expect(useProjectStore.getState().saveStatus).toBe('saved'));
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
    resetBackendConnectionForTests();
  });
});
