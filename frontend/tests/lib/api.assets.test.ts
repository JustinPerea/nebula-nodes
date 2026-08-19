import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
  rewriteBackendAssetUrls: (value: unknown) => value,
}));
vi.mock('../../src/lib/currentProject', () => ({ resolveProjectId: async (id?: string) => id ?? 'nebula_nodes' }));

import { fetchCharacters, fetchMoodboards } from '../../src/lib/api';

beforeEach(() => fetchMock.mockReset());

describe('project-scoped asset clients', () => {
  it('lists Characters with the current project id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    await fetchCharacters('project');
    expect(fetchMock).toHaveBeenCalledWith('/api/characters?scope=project&projectId=nebula_nodes');
  });

  it('lists Moodboards with the current project id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    await fetchMoodboards('project');
    expect(fetchMock).toHaveBeenCalledWith('/api/moodboards?scope=project&projectId=nebula_nodes');
  });
});
