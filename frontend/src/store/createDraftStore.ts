import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

export const CREATE_DRAFT_STORAGE_KEY = 'nebula:create:drafts:v1';

export interface CreateDraftReference {
  filePath: string;
  previewUrl: string;
}

export interface CreateDraftUpload {
  id: string;
  name: string;
  attempt: string;
  status: 'uploading' | 'error';
  error?: string;
}

export const INTERRUPTED_CREATE_UPLOAD_MESSAGE = 'Upload was interrupted. Attach this image again or remove it.';

/** Authoring state only. Run ownership and saved recipes stay in graphStore. */
export interface CreateDraft {
  /** Explicit reset invalidates delayed uploads and composer requests. */
  revision: string;
  modelId: string | null;
  prompt: string;
  params: Record<string, unknown>;
  refs: CreateDraftReference[];
  quantity: number;
  uploads: CreateDraftUpload[];
}

export type CreateDraftSeed = Omit<CreateDraft, 'revision' | 'uploads'> & { uploads?: CreateDraftUpload[] };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
type DraftPatch = Partial<Omit<CreateDraft, 'revision'>>;
type DraftChange = DraftPatch | ((current: CreateDraft) => DraftPatch);

export interface CreateDraftState {
  drafts: Record<string, CreateDraft>;
  /** Canvas selection is a seed, never an implicit replacement on reopening. */
  getOrCreateDraft: (sessionId: string, seed: CreateDraftSeed) => CreateDraft;
  updateDraft: (sessionId: string, change: DraftChange) => void;
  /** Keep the session/history identity; callers supply blank/default values. */
  resetDraft: (sessionId: string, defaults: CreateDraftSeed) => void;
}

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readDraft(value: unknown): CreateDraft | null {
  if (!isRecord(value)
    || typeof value.revision !== 'string' || !value.revision
    || (value.modelId !== null && typeof value.modelId !== 'string')
    || typeof value.prompt !== 'string'
    || !isRecord(value.params)
    || !Array.isArray(value.refs)
    || !Array.isArray(value.uploads)
    || !Number.isInteger(value.quantity)
    || (value.quantity as number) < 1
    || (value.quantity as number) > 4) return null;

  const refs: CreateDraftReference[] = [];
  for (const ref of value.refs) {
    if (!isRecord(ref) || typeof ref.filePath !== 'string' || typeof ref.previewUrl !== 'string') return null;
    refs.push({ filePath: ref.filePath, previewUrl: ref.previewUrl });
  }

  const uploads: CreateDraftUpload[] = [];
  for (const upload of value.uploads) {
    if (!isRecord(upload)
      || typeof upload.id !== 'string' || !upload.id
      || typeof upload.name !== 'string'
      || typeof upload.attempt !== 'string' || !upload.attempt
      || (upload.status !== 'uploading' && upload.status !== 'error')
      || (upload.error !== undefined && typeof upload.error !== 'string')) return null;
    uploads.push({
      id: upload.id,
      name: upload.name,
      attempt: upload.attempt,
      // File/controller objects belong to this page lifetime, so a persisted
      // pending upload needs explicit recovery after reload instead of a spinner.
      status: 'error',
      ...(upload.status === 'uploading'
        ? { error: INTERRUPTED_CREATE_UPLOAD_MESSAGE }
        : typeof upload.error === 'string' ? { error: upload.error } : {}),
    });
  }

  return {
    revision: value.revision,
    modelId: value.modelId as string | null,
    prompt: value.prompt,
    params: value.params,
    refs,
    quantity: value.quantity as number,
    uploads,
  };
}

function loadDrafts(storage: DraftStorage | null): Record<string, CreateDraft> {
  try {
    const raw = storage?.getItem(CREATE_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || saved.version !== 1 || !isRecord(saved.drafts)) return {};
    return Object.fromEntries(Object.entries(saved.drafts).flatMap(([sessionId, value]) => {
      const draft = readDraft(value);
      return sessionId.trim() && draft ? [[sessionId, draft]] : [];
    }));
  } catch {
    return {};
  }
}

function cloneDraft(draft: CreateDraft): CreateDraft {
  // Selection/style data can share nested objects with immutable run recipes.
  // Never let later draft edits mutate the source that supplied those values.
  return structuredClone(draft);
}

function newDraft(seed: CreateDraftSeed): CreateDraft {
  return { ...seed, revision: uuidv4(), uploads: seed.uploads ?? [] };
}

function persistedDraft(draft: CreateDraft): CreateDraft {
  // Keep File/controller/preview metadata owned by the upload coordinator out
  // of storage even if a caller passes an object with extra runtime fields.
  return {
    revision: draft.revision,
    modelId: draft.modelId,
    prompt: draft.prompt,
    params: draft.params,
    refs: draft.refs.map(({ filePath, previewUrl }) => ({ filePath, previewUrl })),
    quantity: draft.quantity,
    uploads: draft.uploads.map(({ id, name, attempt, status, error }) => ({
      id, name, attempt, status, ...(error !== undefined ? { error } : {}),
    })),
  };
}

/** Storage injection keeps reload/failure tests away from the user's state. */
export function createCreateDraftStore(storage: DraftStorage | null = browserStorage()) {
  return create<CreateDraftState>((set, get) => {
    const save = (sessionId: string, draft: CreateDraft) => {
      if (!sessionId.trim()) throw new Error('A Create session is required to save a draft.');
      const drafts = { ...get().drafts, [sessionId]: cloneDraft(draft) };
      set({ drafts });
      try {
        const persisted = Object.fromEntries(Object.entries(drafts).map(([id, value]) => [id, persistedDraft(value)]));
        storage?.setItem(CREATE_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts: persisted }));
      } catch {
        // Quota/private-browsing errors must not discard in-memory edits.
      }
    };

    return {
      drafts: loadDrafts(storage),
      getOrCreateDraft: (sessionId, seed) => {
        if (!Object.hasOwn(get().drafts, sessionId)) save(sessionId, newDraft(seed));
        return get().drafts[sessionId];
      },
      updateDraft: (sessionId, change) => {
        if (!Object.hasOwn(get().drafts, sessionId)) return;
        const revision = get().drafts[sessionId].revision;
        const current = cloneDraft(get().drafts[sessionId]);
        const patch = typeof change === 'function' ? change(current) : change;
        save(sessionId, { ...current, ...patch, revision });
      },
      resetDraft: (sessionId, defaults) => save(sessionId, newDraft(defaults)),
    };
  });
}

export const useCreateDraftStore = createCreateDraftStore();
