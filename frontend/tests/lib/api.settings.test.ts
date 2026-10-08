import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  rewriteBackendAssetUrls: vi.fn((value: unknown) => value),
}));

import { deleteSettingsApiKey } from '../../src/lib/api';

describe('browser provider key removal API', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('sends a provider-scoped DELETE with no credential or other settings payload', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'removed' }) });
    await expect(deleteSettingsApiKey('OPENAI_API_KEY')).resolves.toEqual({ status: 'removed' });
    expect(apiFetchMock).toHaveBeenCalledExactlyOnceWith('/api/settings/api-keys/OPENAI_API_KEY', { method: 'DELETE' });
  });

  it('escapes provider path segments and rejects an unsuccessful deletion', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 400 });
    await expect(deleteSettingsApiKey('unknown/provider')).rejects.toThrow('Remove API key failed: 400');
    expect(apiFetchMock).toHaveBeenCalledExactlyOnceWith('/api/settings/api-keys/unknown%2Fprovider', { method: 'DELETE' });
  });
});
