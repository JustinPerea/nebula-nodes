import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 7 of PR #199 (GM r8 and GM's answers to review 7): the saved
// line shows once (a filing the restore notice says gets no toast), a
// canvas is named once, and a canvas saved over the save limit is marked
// for its own line. The person's own clear and load refusals read GM's
// lines, the load naming its file.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  listProjects: vi.fn(),
}));

import * as api from '../lib/projects';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useAgentLogStore } from './agentLogStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';

const listProjects = vi.mocked(api.listProjects);

const send = (event: Record<string, unknown>) => {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  handler(event as never);
};

const base = { projects: [], trash: [], activeProjectId: null, paramsVersion: GRAPH_PARAMS_VERSION, projectLimit: 3 };
const restore = (id: string, canvas: { id: string; name: string; overSaveLimit?: boolean }) => ({
  id, at: '2026-10-28T10:00:00Z', kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0,
  notAddedBack: [], notAddedBackCount: 0, recoveredCanvas: canvas,
});

beforeEach(() => {
  resetProjectStoreForTests();
  useAgentLogStore.getState().clear();
  listProjects.mockReset().mockResolvedValue({ ...base, workspaceRevision: 'r1' } as never);
  useProjectStore.setState({ screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [], dirty: false, saveStatus: 'saved', error: null, projectLimit: 3, canvasSaved: null } as never);
  subscribeProjectAutosave();
});

async function listed(extra: Record<string, unknown>, revision: string) {
  listProjects.mockResolvedValueOnce({ ...base, workspaceRevision: revision, ...extra } as never);
  send({ type: 'projectsChanged', change: 'deleted', projectId: 'x' });
  await vi.waitFor(() => expect(useProjectStore.getState().workspaceRevision).toBe(revision));
  return useProjectStore.getState();
}

describe('GM r8 (a): the saved line shows once', () => {
  it('no toast for a filing the restore notice says as it renders', async () => {
    const state = await listed({ catalogRestore: restore('r-a', { id: 'c1', name: 'Recovered canvas' }),
      canvasSaved: { id: 'c1', name: 'Recovered canvas', at: '2026-10-28T10:00:00Z' } }, 'r2');
    expect(state.catalogRestore?.recoveredCanvas?.id).toBe('c1');
    expect(state.canvasSaved).toBeNull();
  });

  it('a later filing the notice does not say gets its toast, naming only that canvas', async () => {
    const state = await listed({ catalogRestore: restore('r-b', { id: 'c1', name: 'Recovered canvas' }),
      canvasSaved: { id: 'c2', name: 'Recovered canvas 2', at: '2026-10-28T10:00:00Z',
        filed: [{ id: 'c1', name: 'Recovered canvas' }, { id: 'c2', name: 'Recovered canvas 2' }] } }, 'r3');
    expect(state.canvasSaved).toEqual({ id: 'c2', name: 'Recovered canvas 2' });
  });

  it('with no notice on screen, the toast names every canvas filed, each once, marking the one over the limit', async () => {
    const state = await listed({ canvasSaved: { id: 'c3', name: 'B', at: '2026-10-28T10:00:00Z', filed: [
      { id: 'c4', name: 'A' }, { id: 'c4', name: 'A' }, { id: 'c3', name: 'B', overSaveLimit: true }] } }, 'r4');
    expect(state.canvasSaved).toEqual({ id: 'c3', name: 'B', overSaveLimit: true,
      filed: [{ id: 'c4', name: 'A' }, { id: 'c3', name: 'B', overSaveLimit: true }] });
  });

  it('a single canvas saved over the limit keeps its mark', async () => {
    const state = await listed({ canvasSaved: { id: 'c5', name: 'Big', at: '2026-10-28T10:00:00Z', overSaveLimit: true } }, 'r5');
    expect(state.canvasSaved).toEqual({ id: 'c5', name: 'Big', overSaveLimit: true });
  });

  it("carries the waiting canvases' real delete count", async () => {
    const state = await listed({ canvasNotFiled: { reason: 'projects', projectLimit: 3, canvases: [{ name: 'A' }, { name: 'B' }],
      deletes: 2 } }, 'r6');
    expect(state.canvasNotFiled?.deletes).toBe(2);
  });
});

