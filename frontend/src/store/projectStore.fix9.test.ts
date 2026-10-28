import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 9 of PR #199. GM r11, 2: the person's tab says which project its
// canvas shows (the backend ends the protection of a project filed from the
// person's waiting canvas once their tab is on it). GM r11, 5: a tab whose
// revision moved because Nebula restored its project list goes to Projects
// home with no "another window" line, or says the restore where it can't
// move on by itself. GM r11, 4: an agent's copy stays the agent's in the
// listing's notices.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/personSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/personSession')>()),
  holdsPersonCredential: vi.fn(() => false),
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  recoverProject: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { RESTORED_LIST_RELOAD, RESTORED_LIST_UNSAVED, resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSnapshot, SavedProject } from '../lib/projects';

const saveProject = vi.mocked(api.saveProject);
const listProjects = vi.mocked(api.listProjects);
const summary = { id: 'p1', name: 'Delta', createdAt: '', updatedAt: '2026-10-28T00:00:00Z', lastOpenedAt: null,
  nodeCount: 1, edgeCount: 0, thumbnail: null };
const saved = (snapshot: ProjectSnapshot): SavedProject => ({ ...summary, snapshot });
const send = (event: Record<string, unknown>) => {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  handler(event as never);
};
const sync = (revision: string, catalogRestore?: string) => send({ type: 'graphSync', workspaceRevision: revision,
  paramsVersion: GRAPH_PARAMS_VERSION, ...(catalogRestore ? { catalogRestore } : {}) });

function setPrompt(prompt: string): void {
  useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { definitionId: 'gemini-chat', label: 'Chat', params: { prompt }, outputs: {} } }] as never });
}

let unsubscribe: () => void = () => {};
beforeEach(async () => {
  resetProjectStoreForTests();
  vi.mocked(wsClient.setViewing).mockClear();
  saveProject.mockReset().mockImplementation(async (_id, snapshot) => saved(snapshot));
  listProjects.mockReset().mockResolvedValue({ projects: [summary], trash: [], activeProjectId: null, workspaceRevision: 'r2',
    paramsVersion: GRAPH_PARAMS_VERSION } as never);
  setProjectContext({ id: 'p1', revision: 'r1' });
  setPrompt('a');
  useProjectStore.setState({ screen: 'workspace', initialized: true, busy: false, activeProject: summary, dirty: false,
    saveStatus: 'saved', error: null });
  await useProjectStore.getState().flush();
  unsubscribe = subscribeProjectAutosave();
});
afterEach(() => unsubscribe());

describe('GM r11, 2: the tab says which project its canvas shows', () => {
  it('the open project on the canvas, null on Projects home', () => {
    expect(vi.mocked(wsClient.setViewing)).toHaveBeenLastCalledWith('p1');
    useProjectStore.setState({ screen: 'home' });
    expect(vi.mocked(wsClient.setViewing)).toHaveBeenLastCalledWith(null);
    useProjectStore.setState({ screen: 'workspace' });
    expect(vi.mocked(wsClient.setViewing)).toHaveBeenLastCalledWith('p1');
  });
});

describe('GM r11, 5: after a restore, no "another window" line', () => {
  it('a tab with everything saved goes to Projects home with no line', async () => {
    sync('r1', 'restore-old');
    sync('r2', 'restore-new');
    const state = useProjectStore.getState();
    expect(state.screen).toBe('home');
    expect(state.error).toBeNull();
    expect(state.activeProject).toBeNull();
    await vi.waitFor(() => expect(listProjects).toHaveBeenCalled());
  });

  it('the first restore a tab sees after it loaded counts too', () => {
    sync('r1');
    sync('r2', 'restore-new');
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', error: null });
  });

  it("a tab that can't move on by itself says the restore", () => {
    sync('r1');
    const real = useGraphStore.getState().canSwitchProject;
    useGraphStore.setState({ canSwitchProject: () => false });
    try {
      sync('r2', 'restore-new');
    } finally {
      useGraphStore.setState({ canSwitchProject: real });
    }
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', error: RESTORED_LIST_RELOAD });
    expect(RESTORED_LIST_RELOAD).toBe('Nebula restored its project list. Reload projects to continue.');
  });

  it('edits not saved yet: the restore and the recovered copy', () => {
    sync('r1');
    setPrompt('b');
    sync('r2', 'restore-new');
    expect(useProjectStore.getState()).toMatchObject({ screen: 'home', dirty: true, error: RESTORED_LIST_UNSAVED });
  });

  it('a real other window keeps its line', () => {
    sync('r1', 'restore-old');
    sync('r2', 'restore-old');
    expect(useProjectStore.getState().error).toBe('The active project changed in another window. Reload projects to continue.');
  });
});

describe("GM r11, 4: an agent's copy stays the agent's", () => {
  it('in the waiting canvases and the toast, deduped against agentCopies', async () => {
    unsubscribe();
    resetProjectStoreForTests();
    setProjectContext(null);
    useProjectStore.setState({ screen: 'home', activeProject: null, initialized: true, workspaceRevision: 'r1' });
    unsubscribe = subscribeProjectAutosave();
    const restore = { id: 'r-a', at: '2026-10-28T10:00:00Z', kind: 'restored', source: 'catalog.json.bak', addedBack: [],
      addedBackCount: 0, notAddedBack: [], notAddedBackCount: 0, recoveredCanvas: { id: 'c1', name: 'Recovered canvas' },
      agentCopies: [{ id: 'c2', name: 'Recovered canvas copy', agentCopy: { agent: 'Codex' } }] };
    listProjects.mockResolvedValueOnce({ projects: [], trash: [], activeProjectId: null, workspaceRevision: 'r9',
      paramsVersion: GRAPH_PARAMS_VERSION, catalogRestore: restore,
      canvasSaved: { id: 'c2', name: 'Recovered canvas copy', agentCopy: { agent: 'Codex' } },
      canvasNotFiled: { reason: 'projects', projectLimit: 500, canvases: [{ name: null, agentCopy: { agent: 'Codex' } }] } } as never);
    send({ type: 'projectsChanged', change: 'deleted', projectId: 'x' });
    await vi.waitFor(() => expect(useProjectStore.getState().workspaceRevision).toBe('r9'));
    const state = useProjectStore.getState();
    expect(state.canvasSaved).toBeNull();
    expect(state.canvasNotFiled?.canvases).toEqual([{ name: null, agentCopy: { agent: 'Codex' } }]);
  });
});
