import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 10 of PR #199. Review 10, HIGH-2 and GM r13, 1: protection ends
// only on the person's own open of the project or their first own edit
// there; a tab that followed an agent's switch never says `viewing` for it.
// GM r12, 1: the edits a restore stopped are kept in the tab with [Save as a
// project], which saves them under the "(recovered)" name, and the saved
// toast names the project.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/personSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/personSession')>()),
  holdsPersonCredential: vi.fn(() => false),
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
import { PERSONS_CANVAS_SAVED_UNSAVED, projectRetryOffer, RESTORED_LIST_UNSAVED, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSnapshot, ProjectSummary, SavedProject } from '../lib/projects';

const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-28T00:00:00Z', lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null,
});
const copy = summary('pc', 'Recovered canvas copy');
const original = summary('po', 'Recovered canvas');
const empty: ProjectSnapshot = { nodes: [], edges: [], runHistory: [], viewport: null, createSessionId: null };
const saved = (project: ProjectSummary, snapshot: ProjectSnapshot = empty): SavedProject => ({ ...project, snapshot });
const setViewing = vi.mocked(wsClient.setViewing);
const notePersonAct = vi.mocked(wsClient.notePersonAct);

function setPrompt(prompt: string): void {
  useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt }, outputs: {} } }] as never });
}

function socket() {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  return handler;
}

/** Codex opens the original over HTTP; the tab on Projects home follows. */
const codexOpensOriginal: ProjectSwitch = {
  actor: { kind: 'agent', name: 'Codex', color: '#0af' },
  projectId: 'po', projectName: 'Recovered canvas', previousProjectId: 'pc', previousProjectName: 'Recovered canvas copy',
  previousRevision: 'r1', created: false,
};

let unsubscribe: () => void = () => {};

beforeEach(async () => {
  resetProjectStoreForTests();
  setViewing.mockClear();
  notePersonAct.mockClear();
  vi.mocked(api.saveProject).mockReset().mockImplementation(async (id, snapshot) => saved(id === 'po' ? original : copy, snapshot));
  vi.mocked(api.listProjects).mockReset().mockResolvedValue({ projects: [original, copy], trash: [], activeProjectId: 'po',
    workspaceRevision: 'r2', paramsVersion: GRAPH_PARAMS_VERSION } as never);
  vi.mocked(api.getProject).mockReset().mockResolvedValue(saved(original));
  vi.mocked(api.openProject).mockReset();
  vi.mocked(api.recoverProject).mockReset();
  vi.mocked(fetchCLIGraph).mockResolvedValue({ nodes: [], edges: [], empty: true, workspaceRevision: 'r2' } as never);
  setProjectContext({ id: 'pc', revision: 'r1' });
  setPrompt('a');
  // The tab sits on Projects home, the agent's copy still loaded from before.
  useProjectStore.setState({ screen: 'home', initialized: true, busy: false, activeProject: copy, workspaceRevision: 'r1',
    dirty: false, saveStatus: 'saved', error: null, errorRetry: null, switchNotice: null, editsRecoveredAs: null });
  await useProjectStore.getState().flush();
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => unsubscribe());

async function follow(): Promise<void> {
  socket()({ type: 'graphSync', workspaceRevision: 'r2', activeProjectId: 'po', graphReplaced: true,
    paramsVersion: GRAPH_PARAMS_VERSION, projectSwitch: codexOpensOriginal } as never);
  await vi.waitFor(() => expect(useProjectStore.getState().switchNotice).not.toBeNull());
  expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'po' } });
}

describe("review 10, HIGH-2: a tab that follows an agent's switch never ends the protection", () => {
  it('following Codex onto the original says no `viewing` for it, during the follow or after', async () => {
    // The person had opened the original themselves earlier in this tab.
    useProjectStore.setState({ activeProject: original });
    await useProjectStore.getState().open('po');
    expect(setViewing).toHaveBeenLastCalledWith('po');
    useProjectStore.setState({ screen: 'home', activeProject: copy });
    setViewing.mockClear();
    notePersonAct.mockClear();
    await follow();
    expect(setViewing.mock.calls.map(([id]) => id)).not.toContain('po');
    expect(setViewing).toHaveBeenLastCalledWith(null);
    expect(notePersonAct).not.toHaveBeenCalled();
  });

  it("the followed tab plus the person's own edit ends it: one `personInput`, said once", async () => {
    await follow();
    useGraphStore.getState().beginUndoStep();
    useGraphStore.getState().beginUndoStep();
    expect(notePersonAct.mock.calls).toEqual([['personInput', 'po']]);
  });

  it("an agent's edit or a sync arriving is never the person's input", async () => {
    await follow();
    // What a graphSync does: the graph store's state replaced, no step taken.
    setPrompt('from-codex');
    useGraphStore.setState({ edges: [] });
    expect(notePersonAct).not.toHaveBeenCalled();
  });

  it("the person's own open of the project already loaded is said (`personOpen`) and then `viewing`", async () => {
    await follow();
    useProjectStore.setState({ screen: 'home' });
    await useProjectStore.getState().open('po');
    expect(notePersonAct).toHaveBeenCalledWith('personOpen', 'po');
    expect(setViewing).toHaveBeenLastCalledWith('po');
    expect(api.openProject).not.toHaveBeenCalled();
  });

  it("the person's open through Nebula says `viewing` for the project it opened", async () => {
    vi.mocked(api.openProject).mockResolvedValue({ project: saved(original), workspaceRevision: 'r3', canvasRevision: '1',
      paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await useProjectStore.getState().open('po');
    expect(useProjectStore.getState()).toMatchObject({ screen: 'workspace', activeProject: { id: 'po' } });
    expect(setViewing).toHaveBeenLastCalledWith('po');
  });
});

describe("a followed tab when the agent's next write closes the person's project (HIGH-2 follow-up)", () => {
  /** Codex clears: Nebula saves the canvas into the original, closes it and
   * clears a new canvas with no project. The sync says which project closed. */
  function codexClears(savedId = 's1'): void {
    socket()({ type: 'graphSync', workspaceRevision: 'r3', activeProjectId: null, paramsVersion: GRAPH_PARAMS_VERSION,
      personsCanvasSaved: { id: savedId, projectId: 'po' } } as never);
  }

  it('goes to Projects home with no "another window" line', async () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await follow();
    codexClears();
    await vi.waitFor(() => expect(useProjectStore.getState().screen).toBe('home'));
    expect(useProjectStore.getState().error).toBeNull();
    expect(useProjectStore.getState().activeProject).toBeNull();
    // "Codex opened “Recovered canvas”" no longer holds.
    expect(useProjectStore.getState().switchNotice).toBeNull();
  });

  it('with edits not saved yet: the builder\'s line and [Save as a project]', async () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await follow();
    vi.mocked(api.saveProject).mockImplementation(() => new Promise(() => {}));
    setPrompt('typed-before-codex-cleared');
    codexClears();
    const state = useProjectStore.getState();
    expect(state).toMatchObject({ error: PERSONS_CANVAS_SAVED_UNSAVED, errorRetry: { action: 'saveRecovered' } });
    expect(projectRetryOffer(state)).toBe('save');
  });

  it('a sync that carries the same closed project again changes nothing', async () => {
    socket()({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION,
      personsCanvasSaved: { id: 's0', projectId: 'po' } } as never);
    await follow();
    // A later revision for another reason, with the old closed project: the usual line.
    socket()({ type: 'graphSync', workspaceRevision: 'r4', paramsVersion: GRAPH_PARAMS_VERSION,
      personsCanvasSaved: { id: 's0', projectId: 'po' } } as never);
    expect(useProjectStore.getState().error).toBe('The active project changed in another window. Reload projects to continue.');
  });
});

describe('GM r12, 1: the edits a restore stopped, kept in the tab, with [Save as a project]', () => {
  async function stoppedByARestore(): Promise<void> {
    useProjectStore.setState({ screen: 'workspace', activeProject: copy });
    socket()({ type: 'graphSync', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, catalogRestore: 'old' } as never);
    setPrompt('b'); // not saved yet
    socket()({ type: 'graphSync', workspaceRevision: 'r9', paramsVersion: GRAPH_PARAMS_VERSION, catalogRestore: 'new' } as never);
  }

  it("GM's line, verbatim, with the button; closing the tab gets the unload warning", async () => {
    await stoppedByARestore();
    const state = useProjectStore.getState();
    expect(RESTORED_LIST_UNSAVED).toBe("Nebula restored its project list before your latest edits were saved. They're kept in this tab.");
    expect(state).toMatchObject({ screen: 'home', dirty: true, error: RESTORED_LIST_UNSAVED, errorRetry: { action: 'saveRecovered' } });
    expect(projectRetryOffer(state)).toBe('save');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('the button saves them under the "(recovered)" name and the toast names that project', async () => {
    await stoppedByARestore();
    vi.mocked(api.recoverProject).mockResolvedValue({ id: 'pr', name: 'Recovered canvas copy (recovered)' } as never);
    vi.mocked(api.listProjects).mockResolvedValue({ projects: [original, copy], trash: [], activeProjectId: null,
      workspaceRevision: 'r9', paramsVersion: GRAPH_PARAMS_VERSION } as never);
    await useProjectStore.getState().retry();
    const [source, snapshot] = vi.mocked(api.recoverProject).mock.calls[0];
    expect(source).toBe('pc');
    expect(snapshot.nodes[0]?.data.params.prompt).toBe('b');
    expect(useProjectStore.getState()).toMatchObject({ error: null, dirty: false,
      editsRecoveredAs: { id: 'pr', name: 'Recovered canvas copy (recovered)' } });
  });
});
