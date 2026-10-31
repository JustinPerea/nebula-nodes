import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fix round 12 of PR #199 (Justin, 2026-10-29): after a delete freed the
// slot the waiting canvas then took, Undo may pass the project limit, so it
// is never refused by it (rounds 4-11 refused it with GM r6's line in the
// Undo toast's place). Any other refusal still says so in the banner.

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
const logo = { ...alpha, id: 'b'.repeat(32), name: 'Logo', deletedAt: undefined, purgeAt: undefined };
const dunes = { ...alpha, id: 'c'.repeat(32), name: 'Dunes', deletedAt: undefined, purgeAt: undefined };
const delta = { ...alpha, id: 'd'.repeat(32), name: 'Delta (recovered)', deletedAt: undefined, purgeAt: undefined };

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

describe('Undo past the project limit (Justin, 2026-10-29)', () => {
  it('restores into a list already at its limit: the project is back, no toast or banner says the limit', async () => {
    // The delete freed the third slot and the waiting canvas took it.
    useProjectStore.setState({ projects: [logo, dunes, delta] as never, lastDeleted: { id: ALPHA, name: 'Alpha' } });
    restoreProject.mockResolvedValueOnce({ ...alpha, deletedAt: undefined, purgeAt: undefined } as never);
    await useProjectStore.getState().restore(ALPHA, 'undo');
    const state = useProjectStore.getState();
    expect(state.projects.map((project) => project.id)).toContain(ALPHA);
    expect(state.projects).toHaveLength(4);
    expect(state.trash).toEqual([]);
    expect(state.lastDeleted).toBeNull();
    expect(state.error).toBeNull();
  });

  it('an older backend\'s limit refusal is the banner, never a refusal toast', async () => {
    useProjectStore.setState({ lastDeleted: { id: ALPHA, name: 'Alpha' } });
    restoreProject.mockRejectedValueOnce(new api.ProjectRequestError('Project limit reached', 413,
      { heading: "Couldn't restore the project.", detail: 'Project limit reached', storageLimit: 'projects' }));
    await useProjectStore.getState().restore(ALPHA, 'undo');
    const state = useProjectStore.getState();
    expect(state.lastDeleted).toEqual({ id: ALPHA, name: 'Alpha' });
    expect(state.error).toMatch(/^Couldn't restore the project\./);
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
