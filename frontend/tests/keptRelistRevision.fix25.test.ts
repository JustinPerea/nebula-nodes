/**
 * PR #199 round 25: the kept canvas's [Choose a project to delete] deletes
 * with the store's workspace revision. While a canvas is kept its project is
 * gone from the list, so the relist must still refresh that revision (it was
 * left stale: every Delete answered "This project view is out of date", found
 * in the live harness).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as flows from '../src/store/projectFlows';
import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { setProjectContext } from '../src/lib/projectContext';
import * as projects from '../src/lib/projects';

vi.mock('../src/lib/projects', async (original) => ({ ...await original<typeof import('../src/lib/projects')>(), listProjects: vi.fn() }));

const initial = useProjectStore.getState();
const listed = (workspaceRevision: string) => ({ projects: [], trash: [], workspaceRevision, paramsVersion: 1 }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectStoreForTests();
  setProjectContext(null);
  useProjectStore.setState(initial, true);
});

describe('relist while a canvas is kept', () => {
  it('refreshes the workspace revision even though the lost project is still the open one', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listed('rev-new'));
    useProjectStore.setState({ workspaceRevision: 'rev-old', activeProject: { id: 'gone', name: 'Gone' } as never,
      keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: null } as never });
    await flows.relistProjects();
    expect(useProjectStore.getState().workspaceRevision).toBe('rev-new');
  });
  it('still leaves an open project\'s revision to its own saves', async () => {
    vi.mocked(projects.listProjects).mockResolvedValue(listed('rev-new'));
    setProjectContext({ projectId: 'open', revision: 'x' } as never);
    useProjectStore.setState({ workspaceRevision: 'rev-old', activeProject: { id: 'open', name: 'Open' } as never, keptEdits: null });
    await flows.relistProjects();
    expect(useProjectStore.getState().workspaceRevision).toBe('rev-old');
  });
});
