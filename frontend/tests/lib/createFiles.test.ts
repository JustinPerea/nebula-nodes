import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { revealInFinder, saveToFolder } from '../../src/lib/createFiles';

beforeEach(() => fetchMock.mockReset());

describe('revealInFinder', () => {
  it('POSTs /api/reveal with the url', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
    await revealInFinder('/api/outputs/run1/result.png');
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/reveal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ url: '/api/outputs/run1/result.png' });
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: 'not a local output path' }) });
    await expect(revealInFinder('https://example.com/evil.png')).rejects.toThrow('not a local output path');
  });
});

describe('saveToFolder', () => {
  it('POSTs /api/export with the url and returns savedPath', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', savedPath: '/Users/me/Downloads/result.png' }),
    });
    const result = await saveToFolder('/api/outputs/run1/result.png');
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/export');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ url: '/api/outputs/run1/result.png', filename: undefined });
    expect(result.savedPath).toBe('/Users/me/Downloads/result.png');
  });

  it('includes filename when provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', savedPath: '/Users/me/Downloads/custom.png' }),
    });
    await saveToFolder('/api/outputs/run1/result.png', 'custom.png');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ url: '/api/outputs/run1/result.png', filename: 'custom.png' });
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: 'not a local output path' }) });
    await expect(saveToFolder('https://example.com/evil.png')).rejects.toThrow('not a local output path');
  });
});
