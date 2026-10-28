import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 4 of PR #199 (GM - Design r6, bug 3 and its addition; review 4,
// L-1): after a delete freed the slot the waiting canvas then took, Undo is
// refused by the project limit. The refusal takes the Undo toast's place
// with the project's real name and the limit, so a dead Undo is never left
// up; restoring it from Recently deleted while the list is full says the
// same line.

vi.mock('../lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  restoreProject: vi.fn(),
  listProjects: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { resetProjectStoreForTests, useProjectStore } from './projectStore';

const restoreProject = vi.mocked(api.restoreProject);
const listProjects = vi.mocked(api.listProjects);
const ALPHA = 'a'.repeat(32);
const alpha = { id: ALPHA, name: 'Alpha', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z',
  lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null, deletedAt: '2026-10-27T10:00:00Z',
  purgeAt: '2026-11-26T10:00:00Z' };
const limitRefusal = () => new api.ProjectRequestError('Project limit reached', 413,
  { heading: "Couldn't restore the project.", detail: 'Project limit reached', storageLimit: 'projects' });
const LINE = "Couldn't restore “Alpha”. You've reached the limit of 3 projects.";

beforeEach(() => {
  resetProjectStoreForTests();
  restoreProject.mockReset();
  listProjects.mockReset().mockResolvedValue({ projects: [], trash: [alpha], activeProjectId: null,
    workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION, projectLimit: 3 } as never);
  setProjectContext(null);
  useProjectStore.setState({
    screen: 'home', initialized: true, busy: false, activeProject: null, workspaceRevision: 'r1',
    projects: [], trash: [alpha], catalogRestore: null, dirty: false, saveStatus: 'saved', error: null,
    projectLimit: 3, lastDeleted: null,
  } as never);
});

describe('Undo refused past the project limit', () => {
  it('takes the Undo toast\'s place with the real name and limit, and leaves no banner', async () => {
    useProjectStore.setState({ lastDeleted: { id: ALPHA, name: 'Alpha' } });
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA, 'undo');
    const state = useProjectStore.getState();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha', refused: LINE });
    expect(state.error).toBeNull();
    expect(state.trash.map((entry) => entry.id)).toEqual([ALPHA]);
  });

  // GM r7 (fix round 5 of PR #199): from Recently deleted too it is the
  // neutral toast, never the banner (round 4 answered there with the banner).
  it('says the same line from Recently deleted while the list is still full, as the toast', async () => {
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA);
    const state = useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.errorRetry).toBeNull();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha', refused: LINE });
  });

  it('answers Restore in the list with the toast while a toast for it is up, never the banner', async () => {
    useProjectStore.setState({ lastDeleted: { id: ALPHA, name: 'Alpha', refused: LINE } });
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA);
    const state = useProjectStore.getState();
    expect(state.error).toBeNull();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha', refused: LINE });
  });

  it('names the limit the store holds', async () => {
    useProjectStore.setState({ projectLimit: 500 } as never);
    restoreProject.mockRejectedValueOnce(limitRefusal());
    await useProjectStore.getState().restore(ALPHA);
    expect(useProjectStore.getState().lastDeleted?.refused).toBe("Couldn't restore “Alpha”. You've reached the limit of 500 projects.");
  });

  it('keeps other refusals as they were', async () => {
    useProjectStore.setState({ lastDeleted: { id: ALPHA, name: 'Alpha' } });
    restoreProject.mockRejectedValueOnce(new api.ProjectRequestError('Project storage limit reached', 413,
      { heading: "Couldn't restore the project.", storageLimit: 'storage' }));
    await useProjectStore.getState().restore(ALPHA, 'undo');
    const state = useProjectStore.getState();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha' });
    expect(state.error).toMatch(/^Couldn't restore the project\./);
  });
});
