/**
 * Q118 (Justin, 2026-10-23, option a, verbatim): "Let Load graph open bigger
 * .nebula files (up to the 512 MiB it already allows for a bundle) as a new
 * project. A project over 16 MiB still can't be saved, so the canvas says
 * so, and you remove what you don't need until it saves. GM writes that
 * state's lines."
 *
 * The project store's "saving paused" state. GM - Design's lines, verbatim:
 * the notice on entering, "Saving paused. This project is {size} MB, over
 * the 16 MB limit." with "See what's large"; after Load graph, "Opened
 * {filename}. It's {size} MB, over the save limit." with the same
 * button; on leaving it, "Saving again. This project is {size} MB.", the
 * header back to "Saved" and the panel closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { setViewing: () => {},
  connect: vi.fn(), disconnect: vi.fn(),
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
vi.mock('../src/lib/paramsOutdated', async (original) => ({
  ...await original<typeof import('../src/lib/paramsOutdated')>(), reloadPage: vi.fn(),
}));
vi.mock('../src/lib/projects', async (original) => ({
  ...await original<typeof import('../src/lib/projects')>(),
  listProjects: vi.fn(), getProject: vi.fn(), saveProject: vi.fn(), recoverProject: vi.fn(), openProject: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock('../src/lib/graphFileShared', async (original) => ({
  ...await original<typeof import('../src/lib/graphFileShared')>(), saveEditsToFile: vi.fn(),
}));

import { captureProjectSnapshot, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from '../src/store/projectStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';
import { setProjectContext } from '../src/lib/projectContext';
import { BrowserStringLimitError, saveEditsToFile } from '../src/lib/graphFileShared';
import * as projects from '../src/lib/projects';
import * as execution from '../src/lib/api';
import { PROJECT_SAVE_LIMIT_BYTES, displaySize, projectSizeBytes } from '../src/lib/projectSize';
import type { ProjectList, SavedProject } from '../src/lib/projects';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const TOO_LARGE = 'These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them.';
const initial = useProjectStore.getState();
/** Over the limit with room to spare, and well under it. */
const BIG = 'x'.repeat(PROJECT_SAVE_LIMIT_BYTES + 200_000);

type Paused = ReturnType<typeof useProjectStore.getState> & {
  savePaused?: { bytes: number } | null;
  sizeNotice?: { id: number; text: string; action: boolean } | null;
  sizePanelOpen?: boolean;
  openSizePanel?: () => void;
  noteLoadedGraph?: (fileName: string) => void;
  unsavedEdits?: { reason: string } | null;
  downloadUnsavedEdits?: () => Promise<void>;
};
const state = () => useProjectStore.getState() as Paused;

function project(id = 'alpha', value = id): SavedProject {
  return {
    id, name: id === 'alpha' ? 'Glass campaign' : id, createdAt: '2026-10-09T10:00:00Z',
    updatedAt: '2026-10-09T10:00:00Z', lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
    snapshot: { nodes: [{ id: 'n1', type: 'model-node', position: { x: 10, y: 20 },
      data: { definitionId: 'text-input', label: 'Brief', params: { value }, state: 'idle', outputs: {} } }],
    edges: [], runHistory: [], viewport: null, createSessionId: null },
  };
}
const summary = (id: string) => { const { snapshot: _s, ...rest } = project(id); void _s; return rest; };
function listing(overrides: Partial<ProjectList> = {}): ProjectList {
  return { projects: [summary('alpha'), summary('beta')], trash: [], activeProjectId: 'alpha',
    workspaceRevision: 'rev-a', paramsVersion: GRAPH_PARAMS_VERSION, ...overrides };
}
function editCanvas(value: string): void {
  const [node] = useGraphStore.getState().nodes;
  useGraphStore.setState({ nodes: [{ ...node, data: { ...node.data, params: { value } } }] });
}
function emit(event: Record<string, unknown>): void {
  for (const handler of [...socket.handlers]) handler(event as unknown as ExecutionEvent);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const unloadPrompts = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const measured = () => projectSizeBytes(captureProjectSnapshot());
const pausedLine = (bytes: number) => `Saving paused. This project is ${displaySize(bytes)} MB, over the 16 MB limit.`;

let unsubscribe: (() => void) | null = null;
beforeEach(async () => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  window.sessionStorage.clear();
  setProjectContext(null);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isImportingGraph: false,
    providerRecoveries: [], providerStartAmbiguities: [], createLaunchingIds: [], uncertainWorldLabsRunId: null });
  useProjectStore.setState(initial, true);
  useUIStore.setState({ viewMode: 'canvas', createSessionId: null, canvasViewport: null });
  useCreateDraftStore.setState({ drafts: {} });
  vi.spyOn(execution, 'fetchCLIGraph').mockResolvedValue({ nodes: [], edges: [], empty: true });
  vi.mocked(projects.listProjects).mockResolvedValue(listing());
  vi.mocked(projects.getProject).mockImplementation(async (id) => project(id));
  vi.mocked(projects.saveProject).mockImplementation(async (id, snapshot) => ({ ...project(id), snapshot }));
  vi.mocked(projects.openProject).mockResolvedValue({ project: project('beta'), workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION });
  vi.mocked(saveEditsToFile).mockResolvedValue({ name: 'Glass campaign - unsaved edits.nebula', reopens: true });
  await useProjectStore.getState().initialize();
  useProjectStore.setState({ screen: 'workspace' });
  unsubscribe = subscribeProjectAutosave();
});
afterEach(async () => {
  vi.restoreAllMocks();
  unsubscribe?.(); unsubscribe = null;
  await tick();
  setProjectContext(null);
});

describe('entering the paused state', () => {
  it('an autosave over the limit sends nothing: the header says so and one notice offers what\'s large', async () => {
    editCanvas(BIG);
    // Debounced like autosave: nothing is measured or sent before it fires.
    expect(state().saveStatus).toBe('unsaved');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await tick();
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(state().saveStatus).toBe('paused');
    expect(state().savePaused).toEqual({ bytes: measured() });
    expect(state().dirty).toBe(true);
    expect(state().sizeNotice).toMatchObject({ text: pausedLine(measured()), action: true });
    expect(state().error).toBeNull();
    expect(state().saveError).toBeNull();
  });

  it('while paused, each change is measured again, nothing is sent and no second notice comes', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    const notice = state().sizeNotice;
    editCanvas(`${BIG}more`);
    await useProjectStore.getState().flush();
    await useProjectStore.getState().flush();
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(state().savePaused).toEqual({ bytes: measured() });
    expect(state().sizeNotice?.id).toBe(notice?.id);
    expect(state().saveStatus).toBe('paused');
  });

  it("the backend's own 413 for the size pauses too, from its measure", async () => {
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError(
      'Project snapshot exceeds the 16 MiB limit', 413,
      { heading: "Couldn't save the project.", overSaveLimit: true, sizeBytes: PROJECT_SAVE_LIMIT_BYTES + 5 } as never));
    editCanvas('small, but the server counted it over');
    await useProjectStore.getState().flush();
    expect(state().saveStatus).toBe('paused');
    expect(state().savePaused).toEqual({ bytes: PROJECT_SAVE_LIMIT_BYTES + 5 });
    expect(state().saveError).toBeNull();
    expect(state().error).toBeNull();
    expect(state().unsavedEdits ?? null).toBeNull();
  });

  it('Load graph over the limit: its own line names the file, then the same paused state', async () => {
    editCanvas(BIG);
    state().noteLoadedGraph!('Big campaign.nebula');
    expect(state().saveStatus).toBe('paused');
    expect(state().sizeNotice).toMatchObject({
      text: `Opened Big campaign.nebula. It's ${displaySize(measured())} MB, over the save limit.`, action: true });
    const notice = state().sizeNotice;
    await useProjectStore.getState().flush();
    expect(state().sizeNotice).toBe(notice);
    expect(projects.saveProject).not.toHaveBeenCalled();
  });

  it("a file over the limit opened as a new project (Q120): GM's line says so", async () => {
    editCanvas(BIG);
    (state().noteLoadedGraph as (fileName: string, asNewProject?: boolean) => void)('Big campaign.nebula', true);
    expect(state().saveStatus).toBe('paused');
    // The header shows the name (from the file) and the size, so the line
    // doesn't repeat them and fits on one line beside its button (GM).
    expect(state().sizeNotice?.text).toBe("Opened as a new project. It's over the save limit.");
  });

  it("a Load graph whose own sync lands first and fires an autosave shows only the Load graph line (live check)", async () => {
    useGraphStore.setState({ isImportingGraph: true });
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    expect(state().saveStatus).toBe('paused');
    expect(state().sizeNotice ?? null).toBeNull();
    useGraphStore.setState({ isImportingGraph: false });
    state().noteLoadedGraph!('Big campaign.nebula');
    expect(state().sizeNotice?.text).toBe(`Opened Big campaign.nebula. It's ${displaySize(measured())} MB, over the save limit.`);
    expect(projects.saveProject).not.toHaveBeenCalled();
  });

  it('a project stored over the limit opens paused, with nothing unsaved to ask about', async () => {
    unsubscribe?.(); unsubscribe = null;
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id, BIG));
    await useProjectStore.getState().initialize();
    unsubscribe = subscribeProjectAutosave();
    expect(state().saveStatus).toBe('paused');
    expect(state().dirty).toBe(false);
    expect(state().sizeNotice?.text).toBe(pausedLine(measured()));
    expect(unloadPrompts()).toBe(false);
  });
});

describe('leaving it', () => {
  it('trimmed to the limit or under: a normal save, "Saving again", "Saved", and the panel closes', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    state().openSizePanel!();
    expect(state().sizePanelOpen).toBe(true);
    editCanvas('trimmed');
    await useProjectStore.getState().flush();
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(projects.saveProject).mock.calls[0][1].nodes[0].data.params).toEqual({ value: 'trimmed' });
    expect(state().saveStatus).toBe('saved');
    expect(state().savePaused ?? null).toBeNull();
    expect(state().sizePanelOpen).toBe(false);
    expect(state().sizeNotice).toMatchObject({ text: `Saving again. This project is ${displaySize(measured())} MB.`, action: false });
  });
});

describe('a save that fails while resuming (review)', () => {
  it('trimmed, but the save fails for another reason: "Save failed", never "Saving paused", and the save that lands still says "Saving again"', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    state().openSizePanel!();
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError(
      'Internal Server Error', 500, { heading: "Couldn't save the project." } as never));
    editCanvas('trimmed');
    await expect(useProjectStore.getState().flush()).rejects.toThrow();
    expect(state().saveStatus).toBe('error');
    expect(state().savePaused ?? null).toBeNull();
    expect(state().sizePanelOpen).toBe(false);
    // The paused notice's "See what's large" would open nothing now: it goes.
    expect(state().sizeNotice ?? null).toBeNull();
    // The next edit reads as any edit after a failed save: not "Saving paused".
    editCanvas('trimmed, then edited');
    expect(state().saveStatus).toBe('unsaved');
    useProjectStore.setState({ error: null, errorRetry: null });
    await useProjectStore.getState().flush();
    expect(state().saveStatus).toBe('saved');
    expect(state().sizeNotice).toMatchObject({ text: `Saving again. This project is ${displaySize(measured())} MB.`, action: false });
  });

  it('over the limit again after a failed save: paused again, with a fresh notice', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    const first = state().sizeNotice;
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError(
      'Internal Server Error', 500, { heading: "Couldn't save the project." } as never));
    editCanvas('trimmed');
    await expect(useProjectStore.getState().flush()).rejects.toThrow();
    editCanvas(`${BIG}again`);
    await useProjectStore.getState().flush();
    expect(state().saveStatus).toBe('paused');
    expect(state().savePaused).toEqual({ bytes: measured() });
    expect(state().sizeNotice?.id).not.toBe(first?.id);
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
  });

  it("Save failed's Retry on a project over the limit again goes back to paused by itself, sending nothing (GM, #182)", async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError(
      'Internal Server Error', 500, { heading: "Couldn't save the project." } as never));
    editCanvas('trimmed');
    await expect(useProjectStore.getState().flush()).rejects.toThrow();
    expect(state().saveStatus).toBe('error');
    editCanvas(`${BIG}back`);
    await useProjectStore.getState().retrySave();
    expect(state().saveStatus).toBe('paused');
    expect(state().savePaused).toEqual({ bytes: measured() });
    expect(projects.saveProject).toHaveBeenCalledTimes(1);
  });
});

describe('nothing is lost without asking', () => {
  it('leaving the tab while paused asks with the browser prompt; once it saves again, it doesn\'t', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    expect(unloadPrompts()).toBe(true);
    editCanvas('trimmed');
    await useProjectStore.getState().flush();
    expect(unloadPrompts()).toBe(false);
  });

  it("an agent's switch while paused: the edits are held for the download screen, and never sent", async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
        previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' }, created: false } });
    await tick(); await tick();
    expect(projects.saveProject).not.toHaveBeenCalled();
    expect(projects.recoverProject).not.toHaveBeenCalled();
    // The backend's switch kept its live canvas (the nodes, wires and
    // settings) in the project it left: the confirm says so (review). GM,
    // 2026-10-24: the screen names the agent and the project it opens.
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign',
      agentOpening: { agent: 'Claude', projectName: 'beta' } });
    // A download that couldn't be written keeps the line.
    vi.mocked(saveEditsToFile).mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, downloadFailed: true, keptIn: 'Glass campaign',
      agentOpening: { agent: 'Claude', projectName: 'beta' } });
  });

  it("an unnamed script's switch while paused: the same screen, with no opening line", async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
        previousRevision: 'rev-a', created: false } });
    await tick(); await tick();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign' });
  });

  it('the person opening another project while paused: the same screen, then the open finishes after the choice', async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    await useProjectStore.getState().open('beta');
    expect(projects.openProject).not.toHaveBeenCalled();
    expect(projects.recoverProject).not.toHaveBeenCalled();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign' });
    // A download that couldn't be written keeps the screen as it was.
    vi.mocked(saveEditsToFile).mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().downloadUnsavedEdits!();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, downloadFailed: true, keptIn: 'Glass campaign' });
    await state().downloadUnsavedEdits!();
    expect(saveEditsToFile).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveEditsToFile).mock.calls[1][0].nodes[0].data.params).toEqual({ value: BIG });
    expect(projects.openProject).toHaveBeenCalledTimes(1);
    expect(state().activeProject?.id).toBe('beta');
  });

  it("a download past the browser's string cap says it's too big to download (GM batch, 2026-10-25)", async () => {
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    await useProjectStore.getState().open('beta');
    vi.mocked(saveEditsToFile).mockRejectedValueOnce(new BrowserStringLimitError());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().downloadUnsavedEdits!();
    // Not the disk line: GM's "Couldn't download your edits. It's too big to download in a browser."
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, downloadTooBig: true, keptIn: 'Glass campaign' });
    expect(projects.openProject).not.toHaveBeenCalled();
  });

  it('switching while paused with nothing unsaved just switches', async () => {
    unsubscribe?.(); unsubscribe = null;
    resetProjectStoreForTests();
    useProjectStore.setState(initial, true);
    vi.mocked(projects.getProject).mockImplementation(async (id) => project(id, BIG));
    await useProjectStore.getState().initialize();
    unsubscribe = subscribeProjectAutosave();
    await useProjectStore.getState().open('beta');
    expect(projects.openProject).toHaveBeenCalledTimes(1);
    expect(state().unsavedEdits ?? null).toBeNull();
  });
});

describe("#178's recovery copy and the open project's own save", () => {
  it("the open project's own autosave refused for its size pauses; a stale tab's copy refused for its size still gets the download screen", async () => {
    vi.mocked(projects.saveProject).mockRejectedValueOnce(new projects.ProjectRequestError(
      'Project snapshot exceeds the 16 MiB limit', 413,
      { heading: "Couldn't save the project.", overSaveLimit: true, sizeBytes: PROJECT_SAVE_LIMIT_BYTES + 9 } as never));
    editCanvas('the open project');
    await useProjectStore.getState().flush();
    expect(state().saveStatus).toBe('paused');
    expect(state().unsavedEdits ?? null).toBeNull();

    // Another window took the project: the copy of this (no longer open)
    // project is a recovered copy, and its refusal is #178's screen.
    editCanvas('another edit');
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true });
    vi.mocked(projects.recoverProject).mockRejectedValue(new projects.ProjectRequestError(
      'Project snapshot exceeds the 16 MiB limit', 413,
      { heading: "Couldn't recover the project.", overSaveLimit: true, sizeBytes: PROJECT_SAVE_LIMIT_BYTES + 9 } as never));
    await useProjectStore.getState().retry();
    expect(projects.recoverProject).toHaveBeenCalledTimes(1);
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE });
  });
});

/** Q120 (Justin, 2026-10-23, option a, verbatim): "Files over the limit open
 * as a new project named after the file. The open project is left as it was.
 * Files under the limit still replace the canvas, as today." */
describe('a file over the limit opens as a new project (Q120)', () => {
  const created = (): SavedProject => ({ ...project('gamma'), name: 'Big campaign',
    snapshot: { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null } });
  const createdActivation = () => ({ project: created(), workspaceRevision: 'rev-c', paramsVersion: GRAPH_PARAMS_VERSION });

  it('the load runs once the new project is open, and the project that was open is left as it was', async () => {
    vi.mocked(projects.createProject).mockResolvedValue(createdActivation());
    const seen: Array<string | undefined> = [];
    const then = vi.fn(async () => { seen.push(useProjectStore.getState().activeProject?.id); });
    await useProjectStore.getState().createProject('Big campaign', then);
    expect(projects.createProject).toHaveBeenCalledWith('Big campaign', 'rev-a');
    expect(then).toHaveBeenCalledOnce();
    expect(seen).toEqual(['gamma']);
    expect(state().screen).toBe('workspace');
    // Nothing was written to the project that was open: it had no edits.
    expect(projects.saveProject).not.toHaveBeenCalled();
  });

  it("a create that doesn't land loads nothing", async () => {
    vi.mocked(projects.createProject).mockRejectedValue(new projects.ProjectRequestError('Bad name', 400));
    const then = vi.fn(async () => {});
    await useProjectStore.getState().createProject('Big campaign', then);
    expect(then).not.toHaveBeenCalled();
    expect(state().activeProject?.id).toBe('alpha');
  });

  it("a create turned away keeps the load: Try again makes the project and loads the file", async () => {
    // A run still going turns the switch away, with Try again.
    useGraphStore.setState({ isExecuting: true });
    const then = vi.fn(async () => {});
    await useProjectStore.getState().createProject('Big campaign', then);
    expect(then).not.toHaveBeenCalled();
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(state().errorRetry).toMatchObject({ action: 'create', name: 'Big campaign' });
    useGraphStore.setState({ isExecuting: false });
    vi.mocked(projects.createProject).mockResolvedValueOnce(createdActivation());
    await useProjectStore.getState().retry();
    expect(then).toHaveBeenCalledOnce();
    expect(state().activeProject?.id).toBe('gamma');
  });

  it("an agent's switch while #178's screen waits keeps the person's new project and its load", async () => {
    vi.mocked(projects.createProject).mockResolvedValue(createdActivation());
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    const then = vi.fn(async () => {});
    await useProjectStore.getState().createProject('Big campaign', then);
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign' });
    emit({ type: 'graphSync', workspaceRevision: 'rev-b', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [], edges: [], empty: true,
      projectSwitch: { projectId: 'beta', projectName: 'beta', previousProjectId: 'alpha', previousProjectName: 'Glass campaign',
        previousRevision: 'rev-a', actor: { kind: 'agent', name: 'Claude' }, created: false } });
    await tick(); await tick();
    // The person's own create brought the screen up: no agent line.
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign' });
    vi.mocked(projects.listProjects).mockResolvedValue(listing({ activeProjectId: 'beta', workspaceRevision: 'rev-b' }));
    await state().downloadUnsavedEdits!();
    expect(projects.createProject).toHaveBeenCalledOnce();
    expect(then).toHaveBeenCalledOnce();
    expect(state().activeProject?.id).toBe('gamma');
  });

  it("the open project paused with unsaved edits: #178's screen first, then the new project and the load after the choice", async () => {
    vi.mocked(projects.createProject).mockResolvedValue(createdActivation());
    editCanvas(BIG);
    await useProjectStore.getState().flush();
    const then = vi.fn(async () => {});
    await useProjectStore.getState().createProject('Big campaign', then);
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(then).not.toHaveBeenCalled();
    expect(state().unsavedEdits).toEqual({ reason: TOO_LARGE, keptIn: 'Glass campaign' });
    await state().downloadUnsavedEdits!();
    expect(projects.createProject).toHaveBeenCalledOnce();
    expect(then).toHaveBeenCalledOnce();
    expect(state().activeProject?.id).toBe('gamma');
  });
});
