import { create } from 'zustand';

export type AssetStudioKind = 'character' | 'moodboard';
export type AssetStudioSaveState = 'draft' | 'idle' | 'saving' | 'saved' | 'error';

export interface AssetStudioDraftEntry<D = unknown> {
  draft: D;
  savedId: string | null;
  thumbnail: string;
  saveState: AssetStudioSaveState;
  loadError: string | null;
  saveError: string | null;
  loaded: boolean;
  dirty: boolean;
  revision: number;
  epoch: number;
  pendingSaveId: string | null;
  pendingAnalysisId: string | null;
}

export function assetStudioDraftKey(kind: AssetStudioKind, scope: string, id: string | null, projectId?: string | null): string {
  return JSON.stringify(scope === 'project' ? [kind, scope, projectId ?? 'pending', id ?? 'new']
    : [kind, scope, id ?? 'new']);
}

export function emptyAssetStudioEntry<D>(draft: D): AssetStudioDraftEntry<D> {
  return { draft, savedId: null, thumbnail: '', saveState: 'draft', loadError: null,
    saveError: null, loaded: false, dirty: false, revision: 0, epoch: 0,
    pendingSaveId: null, pendingAnalysisId: null };
}

export function resolveAssetStudioDraftKey(state: { aliases: Record<string, string> }, key: string): string {
  const seen = new Set<string>();
  while (state.aliases[key] && !seen.has(key)) { seen.add(key); key = state.aliases[key]; }
  return key;
}

interface AssetStudioDraftState {
  entries: Record<string, AssetStudioDraftEntry>;
  aliases: Record<string, string>;
  projectId: string | null;
  setProjectId: (id: string) => void;
  ensure: (key: string, entry: AssetStudioDraftEntry) => void;
  patch: (key: string, patch: Partial<AssetStudioDraftEntry>) => void;
  edit: (key: string, update: (draft: unknown) => unknown) => void;
  reset: (key: string, draft: unknown) => void;
  beginSave: (key: string) => { id: string; revision: number; entry: AssetStudioDraftEntry } | null;
  finishSave: (key: string, id: string, revision: number, savedId: string, thumbnail: string) => boolean;
  failSave: (key: string, id: string, message: string) => void;
  copyTo: (key: string, destination: string) => void;
  beginAnalysis: (key: string) => { id: string; revision: number } | null;
  clearAnalysis: (key: string, id: string) => void;
}

/** Session continuity only: drafts are never serialized with graphs or credentials. */
export const useAssetStudioDraftStore = create<AssetStudioDraftState>((set, get) => ({
  entries: {},
  aliases: {},
  projectId: null,
  setProjectId: (projectId) => set({ projectId }),
  ensure: (key, entry) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    return state.entries[key] ? {} : { entries: { ...state.entries, [key]: entry } };
  }),
  patch: (key, patch) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    return state.entries[key] ? { entries: { ...state.entries, [key]: { ...state.entries[key], ...patch } } } : {};
  }),
  edit: (key, update) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    const entry = state.entries[key];
    if (!entry) return {};
    return { entries: { ...state.entries, [key]: { ...entry, draft: update(entry.draft),
      revision: entry.revision + 1, dirty: true, saveError: null,
      saveState: entry.pendingSaveId ? 'saving' : 'draft' } } };
  }),
  reset: (key, draft) => set((state) => {
    const previous = state.entries[resolveAssetStudioDraftKey(state, key)];
    const aliases = { ...state.aliases }; delete aliases[key];
    return { aliases, entries: { ...state.entries, [key]: { ...emptyAssetStudioEntry(draft),
      revision: (previous?.revision ?? 0) + 1, epoch: (previous?.epoch ?? 0) + 1 } } };
  }),
  beginSave: (key) => {
    key = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[key];
    if (!entry || !entry.loaded || entry.pendingSaveId) return null;
    const id = crypto.randomUUID();
    get().patch(key, { pendingSaveId: id, saveState: 'saving', saveError: null });
    return { id, revision: entry.revision, entry };
  },
  finishSave: (key, id, revision, savedId, thumbnail) => {
    key = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[key];
    if (!entry || entry.pendingSaveId !== id) return false;
    const dirty = entry.revision !== revision;
    get().patch(key, { savedId, thumbnail, pendingSaveId: null, dirty,
      saveState: dirty ? 'draft' : 'saved', saveError: null });
    return true;
  },
  failSave: (key, id, message) => {
    key = resolveAssetStudioDraftKey(get(), key);
    if (get().entries[key]?.pendingSaveId !== id) return;
    get().patch(key, { pendingSaveId: null, dirty: true, saveState: 'error', saveError: message });
  },
  copyTo: (key, destination) => {
    const source = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[source];
    if (!entry || source === destination) return;
    set((state) => {
      const entries = { ...state.entries, [destination]: { ...entry } }; delete entries[source];
      return { entries, aliases: { ...state.aliases, [source]: destination, [key]: destination } };
    });
  },
  beginAnalysis: (key) => {
    key = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[key];
    if (!entry || !entry.loaded || entry.dirty || entry.pendingSaveId || entry.pendingAnalysisId) return null;
    const id = crypto.randomUUID();
    get().patch(key, { pendingAnalysisId: id, saveError: null });
    return { id, revision: entry.revision };
  },
  clearAnalysis: (key, id) => {
    key = resolveAssetStudioDraftKey(get(), key);
    if (get().entries[key]?.pendingAnalysisId === id) get().patch(key, { pendingAnalysisId: null });
  },
}));
