import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }));
import { fetchPresets, createPreset, deletePreset } from '../../src/lib/createPresets';

beforeEach(() => fetchMock.mockReset());

describe('createPresets client', () => {
  it('fetchPresets GETs with scope', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ id: 'p1', name: 'A' }] });
    const out = await fetchPresets('global');
    expect(out).toEqual([{ id: 'p1', name: 'A' }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/presets?scope=global');
  });

  it('createPreset POSTs the body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'p2' }) });
    const out = await createPreset({ name: 'B', category: 'Style', prompt: 'x', params: {}, modelId: 'nano-banana', refImages: [], scope: 'project' });
    expect(out.id).toBe('p2');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/presets');
    expect((init as { method: string }).method).toBe('POST');
  });

  it('deletePreset DELETEs by id and throws on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(deletePreset('nope')).rejects.toThrow();
  });
});
