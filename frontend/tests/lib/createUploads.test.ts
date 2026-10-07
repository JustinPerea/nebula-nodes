import { vi, describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

const fetchMock = vi.fn();
vi.mock('../../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
  backendAssetUrlSync: (u: string) => u,
}));
import { attachCreateReferences, canRetryCreateReference, clearCreateReferenceUploads,
  removeCreateReferenceUpload, retryCreateReference, uploadReference } from '../../src/lib/createUploads';
import { CREATE_DRAFT_STORAGE_KEY, useCreateDraftStore } from '../../src/store/createDraftStore';

const session = 'upload-test';
const defaults = { modelId: 'nano-banana', prompt: 'Initial prompt', params: {}, refs: [], quantity: 1 };
const image = (name = 'x.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const response = (filePath = '/abs/x.png') => ({ ok: true, json: async () => ({ filePath, url: `/api/outputs/${filePath.split('/').pop()}` }) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const draft = () => useCreateDraftStore.getState().drafts[session];

beforeEach(() => {
  clearCreateReferenceUploads(session);
  useCreateDraftStore.setState({ drafts: {} });
  localStorage.removeItem(CREATE_DRAFT_STORAGE_KEY);
  useCreateDraftStore.getState().getOrCreateDraft(session, defaults);
  fetchMock.mockReset();
});

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
    fetchMock.mockResolvedValue({ ok: false, status: 415, json: async () => ({ detail: 'Image data could not be decoded.' }) });
    await expect(uploadReference(image())).rejects.toThrow('Image data could not be decoded.');
  });

  it('rejects unsupported or oversized references before any network request', async () => {
    await expect(uploadReference(new File(['document'], 'x.txt', { type: 'text/plain' }))).rejects.toThrow('Use a PNG');
    await expect(uploadReference(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))).rejects.toThrow('20 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a successful response without a usable image reference', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ filePath: null, url: '' }) });
    await expect(uploadReference(image())).rejects.toThrow('no image reference');
  });
});

describe('Create reference ownership', () => {
  it('authors every pending chip before requests and preserves edits during out-of-order completion', async () => {
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementationOnce(() => {
      expect(draft().uploads).toHaveLength(2);
      return first.promise;
    }).mockReturnValueOnce(second.promise);
    attachCreateReferences(session, [image('first.png'), image('second.png')]);
    expect(draft().uploads.map((item) => item.status)).toEqual(['uploading', 'uploading']);
    useCreateDraftStore.getState().updateDraft(session, { prompt: 'Edited while uploading', quantity: 4, params: { aspect_ratio: '16:9' } });
    second.resolve(response('/abs/second.png'));
    await waitFor(() => expect(draft().refs).toHaveLength(1));
    first.resolve(response('/abs/first.png'));
    await waitFor(() => expect(draft().uploads).toHaveLength(0));
    expect(draft()).toMatchObject({ prompt: 'Edited while uploading', quantity: 4, params: { aspect_ratio: '16:9' } });
    expect(draft().refs.map((ref) => ref.filePath)).toEqual(['/abs/second.png', '/abs/first.png']);
  });

  it('keeps failures actionable and retries the same chip without duplicating references', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ detail: 'Upload unavailable' }) });
    attachCreateReferences(session, [image()]);
    await waitFor(() => expect(draft().uploads[0].status).toBe('error'));
    const failed = draft().uploads[0];
    expect(failed.error).toBe('Upload unavailable');
    expect(canRetryCreateReference(session, failed.id)).toBe(true);
    fetchMock.mockResolvedValueOnce(response());
    retryCreateReference(session, failed.id);
    expect(draft().uploads[0]).toMatchObject({ id: failed.id, status: 'uploading' });
    expect(draft().uploads[0].attempt).not.toBe(failed.attempt);
    await waitFor(() => expect(draft().uploads).toHaveLength(0));
    expect(draft().refs).toHaveLength(1);
    expect(canRetryCreateReference(session, failed.id)).toBe(false);
  });

  it('replaces a restored interrupted file by explicit attach again', async () => {
    useCreateDraftStore.getState().updateDraft(session, { uploads: [{ id: 'restored', name: 'old.png', attempt: 'old', status: 'error', error: 'Interrupted' }] });
    expect(canRetryCreateReference(session, 'restored')).toBe(false);
    retryCreateReference(session, 'restored');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response('/abs/replacement.png'));
    retryCreateReference(session, 'restored', image('replacement.png'));
    expect(draft().uploads[0].name).toBe('replacement.png');
    await waitFor(() => expect(draft().refs[0].filePath).toBe('/abs/replacement.png'));
  });

  it.each(['remove', 'reset'] as const)('ignores a late upload after %s even when fetch ignores abort', async (action) => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    attachCreateReferences(session, [image()]);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    if (action === 'remove') removeCreateReferenceUpload(session, draft().uploads[0].id);
    else {
      clearCreateReferenceUploads(session);
      useCreateDraftStore.getState().resetDraft(session, { ...defaults, prompt: 'New draft' });
    }
    expect(signal.aborted).toBe(true);
    pending.resolve(response());
    await waitFor(() => expect(draft().uploads).toHaveLength(0));
    // Drain response JSON + store continuation, then ensure it did not reattach.
    await Promise.resolve(); await Promise.resolve();
    expect(draft().refs).toEqual([]);
    expect(draft().prompt).toBe(action === 'reset' ? 'New draft' : defaults.prompt);
  });

  it('deduplicates matching paths from concurrent uploads', async () => {
    fetchMock.mockResolvedValue(response());
    attachCreateReferences(session, [image('one.png'), image('two.png')]);
    await waitFor(() => expect(draft().uploads).toHaveLength(0));
    expect(draft().refs).toHaveLength(1);
  });
});
