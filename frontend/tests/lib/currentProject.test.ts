import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

import {
  NO_PROJECT_OPEN, currentProject, getCurrentProject, resolveProjectId,
} from '../../src/lib/currentProject';
import { useProjectStore } from '../../src/store/projectStore';
import { setOpenProject } from '../../src/test/projectState';

beforeEach(() => {
  fetchMock.mockReset();
  setOpenProject(['pA', 'Shoot A'], [['pB', 'Shoot B']]);
});

describe('the current project is the open canvas project', () => {
  it('reads projectStore, with no request', async () => {
    await expect(getCurrentProject()).resolves.toEqual({ id: 'pA', name: 'Shoot A' });
    await expect(resolveProjectId()).resolves.toBe('pA');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a switch (the person, or an agent the tab follows) at once', async () => {
    setOpenProject(['pB', 'Shoot B'], [['pA', 'Shoot A']]);
    expect(currentProject()).toEqual({ id: 'pB', name: 'Shoot B' });
    await expect(resolveProjectId()).resolves.toBe('pB');
    // A rename shows too.
    useProjectStore.setState((state) => ({ activeProject: state.activeProject && { ...state.activeProject, name: 'B, renamed' } }));
    expect(currentProject()?.name).toBe('B, renamed');
  });

  it('with no project open (Home on a fresh install, or the open one deleted) it says so instead of guessing', async () => {
    setOpenProject(null);
    expect(currentProject()).toBeNull();
    await expect(getCurrentProject()).rejects.toThrow(NO_PROJECT_OPEN);
    await expect(resolveProjectId()).rejects.toThrow(NO_PROJECT_OPEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stopped tab (another window took over) has no current project', () => {
    useProjectStore.setState({ initialized: false });
    expect(currentProject()).toBeNull();
  });

  it('uses an explicit project id as given', async () => {
    setOpenProject(null);
    await expect(resolveProjectId('explicit-project')).resolves.toBe('explicit-project');
  });
});
