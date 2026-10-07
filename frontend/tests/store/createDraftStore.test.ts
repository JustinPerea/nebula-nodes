import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_DRAFT_STORAGE_KEY,
  INTERRUPTED_CREATE_UPLOAD_MESSAGE,
  createCreateDraftStore,
  type CreateDraft,
  type CreateDraftSeed,
} from '../../src/store/createDraftStore';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
}

function draft(overrides: Partial<CreateDraftSeed> = {}): CreateDraftSeed {
  return { modelId: 'nano-banana', prompt: '', params: { aspect_ratio: '1:1' }, refs: [], quantity: 1, ...overrides };
}

function savedDraft(overrides: Partial<CreateDraft> = {}): CreateDraft {
  return { ...draft(), revision: 'saved-revision', uploads: [], ...overrides };
}

describe('Create session drafts', () => {
  it('resumes all unfinished fields without adopting a new Canvas selection', () => {
    const store = createCreateDraftStore(memoryStorage());
    store.getState().getOrCreateDraft('session', draft({ prompt: 'Selected Canvas prompt' }));
    const edited = draft({
      modelId: 'gpt-image-2-generate', prompt: 'My unfinished revision',
      params: { aspect_ratio: '3:2', nested: { strength: 0.4 } },
      refs: [{ filePath: '/api/uploads/reference.png', previewUrl: '/api/uploads/reference.png' }], quantity: 3,
    });
    store.getState().updateDraft('session', edited);

    // Create unmounts while viewing Canvas or History. Reopening offers a seed
    // from the newly selected node, but the existing draft remains authoritative.
    expect(store.getState().getOrCreateDraft('session', draft({ prompt: 'Another Canvas selection' }))).toMatchObject({ ...edited, uploads: [] });
  });

  it('survives an ordinary reload and preserves other session drafts', () => {
    const storage = memoryStorage();
    const first = createCreateDraftStore(storage);
    first.getState().getOrCreateDraft('first', draft({ prompt: 'First', quantity: 2 }));
    first.getState().getOrCreateDraft('second', draft({ prompt: 'Second', modelId: null }));
    first.getState().updateDraft('first', { refs: [{ filePath: '/api/outputs/one.png', previewUrl: '/api/outputs/one.png' }] });

    const reloaded = createCreateDraftStore(storage);
    expect(reloaded.getState().getOrCreateDraft('first', draft())).toEqual(first.getState().drafts.first);
    expect(reloaded.getState().getOrCreateDraft('second', draft())).toEqual(first.getState().drafts.second);
  });

  it('does not retain mutable references to a selected recipe or an update payload', () => {
    const store = createCreateDraftStore(null);
    const source = draft({ params: { palette: { color: '#123456' } }, refs: [{ filePath: '/api/outputs/original.png', previewUrl: '/api/outputs/original.png' }] });
    store.getState().getOrCreateDraft('session', source);
    const original = store.getState().drafts.session;
    store.getState().updateDraft('session', (current) => {
      (current.params.palette as { color: string }).color = '#abcdef';
      current.refs[0].filePath = '/api/outputs/new.png';
      return current;
    });
    expect(source.params).toEqual({ palette: { color: '#123456' } });
    expect(source.refs[0].filePath).toBe('/api/outputs/original.png');
    expect(original.params).toEqual(source.params);
    expect(original.refs).toEqual(source.refs);

    const params = { palette: { color: '#987654' } };
    store.getState().updateDraft('session', { params });
    params.palette.color = '#000000';
    expect(store.getState().drafts.session.params).toEqual({ palette: { color: '#987654' } });
  });

  it('explicitly resets only the composer without changing its history identity', () => {
    const storage = memoryStorage();
    const store = createCreateDraftStore(storage);
    store.getState().getOrCreateDraft('current-session', draft({ prompt: 'Unfinished', quantity: 4 }));
    const revision = store.getState().drafts['current-session'].revision;
    store.getState().updateDraft('current-session', { uploads: [{ id: 'upload', name: 'Reference.png', attempt: 'attempt-1', status: 'uploading' }] });
    store.getState().getOrCreateDraft('other-session', draft({ prompt: 'Other' }));
    store.getState().resetDraft('current-session', draft());

    expect(store.getState().drafts['current-session']).toMatchObject({ ...draft(), uploads: [] });
    expect(store.getState().drafts['current-session'].revision).not.toBe(revision);
    expect(store.getState().drafts['other-session'].prompt).toBe('Other');
    expect(createCreateDraftStore(storage).getState().drafts['current-session']).toEqual(store.getState().drafts['current-session']);
  });

  it('preserves upload progress across view visits and makes interrupted uploads actionable on reload', () => {
    const storage = memoryStorage();
    const store = createCreateDraftStore(storage);
    const uploads: CreateDraft['uploads'] = [
      { id: 'pending', name: 'Pending.png', attempt: 'attempt-1', status: 'uploading' },
      { id: 'failed', name: 'Failed.png', attempt: 'attempt-2', status: 'error', error: 'This image is too large.' },
    ];
    const created = store.getState().getOrCreateDraft('session', draft({ uploads }));
    expect(store.getState().getOrCreateDraft('session', draft()).uploads).toEqual(uploads);
    store.getState().updateDraft('session', { prompt: 'Edited while uploading' });
    expect(store.getState().drafts.session.revision).toBe(created.revision);

    const reloaded = createCreateDraftStore(storage).getState().drafts.session;
    expect(reloaded.prompt).toBe('Edited while uploading');
    expect(reloaded.revision).toBe(created.revision);
    expect(reloaded.uploads).toEqual([
      { ...uploads[0], status: 'error', error: INTERRUPTED_CREATE_UPLOAD_MESSAGE },
      uploads[1],
    ]);
  });

  it('persists only upload metadata and accepted reference fields, excluding extra runtime objects', () => {
    const storage = memoryStorage();
    const store = createCreateDraftStore(storage);
    const reference = { filePath: '/api/uploads/reference.png', previewUrl: '/api/uploads/reference.png', blobPreview: 'blob:temporary', file: { name: 'private-file.png' } };
    const upload = { id: 'pending', name: 'Pending.png', attempt: 'attempt', status: 'uploading' as const, file: { name: 'runtime-file.png' }, preview: 'blob:runtime' };
    store.getState().getOrCreateDraft('session', draft({ refs: [reference], uploads: [upload] }));
    const serialized = storage.getItem(CREATE_DRAFT_STORAGE_KEY)!;
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('runtime-file');
    expect(serialized).not.toContain('private-file');
    expect(createCreateDraftStore(storage).getState().drafts.session.refs).toEqual([{ filePath: reference.filePath, previewUrl: reference.previewUrl }]);
  });

  it('ignores malformed storage and future versions without crashing or importing invalid draft fields', () => {
    for (const serialized of ['invalid json', '[]', JSON.stringify({ version: 2, drafts: { session: savedDraft() } })]) {
      const storage = memoryStorage();
      storage.setItem(CREATE_DRAFT_STORAGE_KEY, serialized);
      expect(createCreateDraftStore(storage).getState().drafts).toEqual({});
    }

    const storage = memoryStorage();
    storage.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts: {
      valid: savedDraft({ prompt: 'Retained' }),
      badRefs: savedDraft({ refs: [{ filePath: 1, previewUrl: null }] } as unknown as Partial<CreateDraft>),
      badParams: { ...savedDraft(), params: [] },
      badQuantity: savedDraft({ quantity: 99 }),
      missingPrompt: { modelId: null, params: {}, refs: [], quantity: 1, uploads: [], revision: 'saved' },
      badUpload: { ...savedDraft(), uploads: [{ id: 'one', attempt: 1, status: 'uploading', name: 'Image.png' }] },
    } }));
    expect(createCreateDraftStore(storage).getState().drafts).toEqual({ valid: savedDraft({ prompt: 'Retained' }) });
  });

  it('retains edits in memory when storage access or writes fail', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('Storage disabled'); }),
      setItem: vi.fn(() => { throw new Error('Storage full'); }),
    };
    const store = createCreateDraftStore(storage);
    expect(() => store.getState().getOrCreateDraft('session', draft())).not.toThrow();
    expect(() => store.getState().updateDraft('session', { prompt: 'Still editable' })).not.toThrow();
    expect(store.getState().drafts.session.prompt).toBe('Still editable');
    expect(() => store.getState().resetDraft('session', draft())).not.toThrow();
    expect(store.getState().drafts.session.prompt).toBe('');
  });

  it('never sends a network request while creating, restoring, editing or resetting a draft', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected generation request'));
    try {
      const storage = memoryStorage();
      const store = createCreateDraftStore(storage);
      store.getState().getOrCreateDraft('session', draft({ prompt: 'Draft only' }));
      store.getState().updateDraft('session', { quantity: 2 });
      const reloaded = createCreateDraftStore(storage);
      reloaded.getState().getOrCreateDraft('session', draft());
      reloaded.getState().resetDraft('session', draft());
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
