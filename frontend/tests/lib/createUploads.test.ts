import { vi, describe, it, expect, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
  backendAssetUrlSync: (u: string) => u,
}));
import { uploadReference } from '../../src/lib/createUploads';

beforeEach(() => fetchMock.mockReset());

describe('uploadReference', () => {
  it('POSTs the file and returns absolute filePath + preview url', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ filePath: '/abs/x.png', url: '/api/outputs/chat-uploads/x.png', filename: 'x.png' }) });
    const file = new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' });
    const result = await uploadReference(file);
    expect(result).toEqual({ filePath: '/abs/x.png', previewUrl: '/api/outputs/chat-uploads/x.png' });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/uploads');
    expect((init as { method: string }).method).toBe('POST');
    expect((init as { body: FormData }).body).toBeInstanceOf(FormData);
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 415 });
    await expect(uploadReference(new File([], 'x.txt'))).rejects.toThrow();
  });
});
