import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An agent renames the project open on the canvas (MCP rename_project, or
// any other tab): the canvas header shows the new name at once, without a
// reload. The backend says so with projectsChanged `renamed` (2026-10-20).

vi.mock('../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));
vi.mock('../lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/projects')>()),
  saveProject: vi.fn(),
  listProjects: vi.fn(),
  openProject: vi.fn(),
  recoverProject: vi.fn(),
}));

import * as api from '../lib/projects';
import { setProjectContext } from '../lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { wsClient } from '../lib/wsClient';
import { useGraphStore } from './graphStore';
import { resetProjectStoreForTests, subscribeProjectAutosave, useProjectStore } from './projectStore';
import type { ProjectSummary } from '../lib/projects';

const listProjects = vi.mocked(api.listProjects);
const summary = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '', updatedAt: '2026-10-20T00:00:00Z', lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const listing = (projects: ProjectSummary[]) => ({
  projects, trash: [], activeProjectId: 'p1', workspaceRevision: 'r1', paramsVersion: GRAPH_PARAMS_VERSION,
}) as never;

function socket() {
  const handler = vi.mocked(wsClient.subscribeFirst).mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('not subscribed');
  return handler;
}
const changed = (change: string, projectId: string) => socket()({ type: 'projectsChanged', change, projectId } as never);

let unsubscribe: () => void = () => {};

beforeEach(() => {
  resetProjectStoreForTests();
  listProjects.mockReset();
  setProjectContext({ id: 'p1', revision: 'r1' });
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [] });
  useProjectStore.setState({
    screen: 'workspace', initialized: true, busy: false, activeProject: summary('p1', 'Old name'), workspaceRevision: 'r1',
    projects: [summary('p1', 'Old name'), summary('p2', 'Other')], trash: [], dirty: false, saveStatus: 'saved',
    error: null, switchNotice: null,
  });
  unsubscribe = subscribeProjectAutosave();
});

afterEach(() => {
  unsubscribe();
  setProjectContext(null);
});

describe('a rename of the open project made elsewhere', () => {
  it('shows on the canvas at once', async () => {
    listProjects.mockResolvedValue(listing([summary('p1', 'Renamed by Claude'), summary('p2', 'Other')]));
    changed('renamed', 'p1');
    await vi.waitFor(() => expect(useProjectStore.getState().activeProject?.name).toBe('Renamed by Claude'));
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projects.map((project) => project.name)).toEqual(['Renamed by Claude', 'Other']);
    expect(useProjectStore.getState().screen).toBe('workspace');
  });

  it("doesn't list again for the open project's own autosaves or another project's rename", async () => {
    changed('saved', 'p1');
    changed('renamed', 'p2');
    await Promise.resolve();
    expect(listProjects).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeProject?.name).toBe('Old name');
  });
});
