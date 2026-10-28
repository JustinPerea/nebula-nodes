import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 8 of PR #199 (GM's rule (a), GM's answer 1 to review 8, GM r9):
// the person's Agent log row when an agent's write saved the canvas first;
// no toast for a canvas the restore notice names (`alsoFiled` too); the
// "Another canvas…" toast; and the held canvases' notice closed with ×,
// alone or with the restore notice it was merged into.

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  listProjects: vi.fn(),
  dismissCatalogRestore: vi.fn(() => Promise.resolve({ dismissed: true })),
  dismissCanvasHeldUnreadable: vi.fn(() => Promise.resolve({ dismissed: true })),
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
const restore = (id: string, extra: Record<string, unknown> = {}) => ({
  id, at: '2026-10-28T10:00:00Z', kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0,
  notAddedBack: [], notAddedBackCount: 0, recoveredCanvas: { id: 'c1', name: 'Recovered canvas' }, ...extra,
});

beforeEach(() => {
  resetProjectStoreForTests();
  useAgentLogStore.getState().clear();
  vi.mocked(api.dismissCatalogRestore).mockClear();
  vi.mocked(api.dismissCanvasHeldUnreadable).mockClear();
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

describe("GM's rule (a): the person's Agent log row, the agent's own", () => {
  it.each([
    [{ action: 'changed', copy: true }, 'Codex changed a copy of the canvas you had open. The original was saved as its own project, “Recovered canvas”.'],
    [{ action: 'cleared' }, 'Codex cleared the canvas. The one you had open was saved as its own project, “Recovered canvas”.'],
    [{ action: 'replaced' }, 'Codex replaced the canvas. The one you had open was saved as its own project, “Recovered canvas”.'],
  ])('%o', (held, message) => {
    send({ type: 'projectsChanged', change: 'canvasHeld', projectId: null,
      canvasHeld: { ...held, savedAs: 'Recovered canvas', agent: 'Codex', agentId: 'ext:codex', color: '#5B9DFF' } });
    const [entry] = useAgentLogStore.getState().entries;
    expect(entry).toMatchObject({ source: 'agent', agent: { id: 'ext:codex', name: 'Codex' }, message });
  });

  it('"An agent" when unknown, as Nebula\'s row', () => {
    send({ type: 'projectsChanged', change: 'canvasHeld', projectId: null,
      canvasHeld: { action: 'changed', copy: true, savedAs: 'Recovered canvas', agent: null } });
    const [entry] = useAgentLogStore.getState().entries;
    expect(entry.source).toBe('system');
    expect(entry.message).toBe('An agent changed a copy of the canvas you had open. The original was saved as its own project, “Recovered canvas”.');
  });
});

describe("GM's answer 1 to review 8: the saved line shows once", () => {
  it('no toast for a canvas the notice names in alsoFiled', async () => {
    const state = await listed({ catalogRestore: restore('r-a', { alsoFiled: [{ id: 'c2', name: 'Recovered canvas 2' }] }),
      canvasSaved: { id: 'c2', name: 'Recovered canvas 2', at: '2026-10-28T10:00:00Z', another: true } }, 'r2');
    expect(state.catalogRestore?.alsoFiled?.[0]?.id).toBe('c2');
    expect(state.canvasSaved).toBeNull();
  });

  it('a later filing on its own carries `another` for "Another canvas…"', async () => {
    const state = await listed({ canvasSaved: { id: 'c3', name: 'Recovered canvas 3', at: '2026-10-28T10:00:00Z', another: true } }, 'r3');
    expect(state.canvasSaved).toEqual({ id: 'c3', name: 'Recovered canvas 3', another: true });
  });
});

describe('GM r9: the held canvases\' notice closes with ×', () => {
  const note = { count: 1, kept: ['x.damaged-20261028T100000Z-00000000'], at: '2026-10-28T10:00:00+00:00' };

  it('alone: × hides it, tells the backend once, and a later listing of the same note keeps it closed', async () => {
    await listed({ canvasHeldUnreadable: note }, 'r4');
    expect(useProjectStore.getState().canvasHeldUnreadable).toEqual({ count: 1, at: note.at });
    useProjectStore.getState().dismissCanvasHeldUnreadable();
    expect(useProjectStore.getState().canvasHeldUnreadable).toBeNull();
    expect(api.dismissCanvasHeldUnreadable).toHaveBeenCalledWith(note.at);
    const again = await listed({ canvasHeldUnreadable: note }, 'r5');
    expect(again.canvasHeldUnreadable).toBeNull();
    // A new loss is a new note: it shows.
    const newer = await listed({ canvasHeldUnreadable: { ...note, at: '2026-10-28T11:00:00+00:00' } }, 'r6');
    expect(newer.canvasHeldUnreadable).toEqual({ count: 1, at: '2026-10-28T11:00:00+00:00' });
  });

  it('merged: the restore notice\'s × closes both', async () => {
    await listed({ catalogRestore: restore('r-m'), canvasHeldUnreadable: note }, 'r7');
    useProjectStore.getState().dismissCatalogRestore();
    expect(useProjectStore.getState().catalogRestore).toBeNull();
    expect(useProjectStore.getState().canvasHeldUnreadable).toBeNull();
    expect(api.dismissCatalogRestore).toHaveBeenCalledWith('r-m');
    expect(api.dismissCanvasHeldUnreadable).toHaveBeenCalledWith(note.at);
  });
});
