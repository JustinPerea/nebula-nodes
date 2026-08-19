import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));

import { clearCurrentProjectCache, getCurrentProject, resolveProjectId } from '../../src/lib/currentProject';

beforeEach(() => {
  fetchMock.mockReset();
  clearCurrentProjectCache();
});

describe('current project client', () => {
  it('loads and caches the backend-owned project identity', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'nebula_nodes', name: 'Nebula Nodes' }) });

    await expect(getCurrentProject()).resolves.toEqual({ id: 'nebula_nodes', name: 'Nebula Nodes' });
    await expect(resolveProjectId()).resolves.toBe('nebula_nodes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/project');
  });

  it('uses an explicit project id without a discovery request', async () => {
    await expect(resolveProjectId('explicit-project')).resolves.toBe('explicit-project');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
