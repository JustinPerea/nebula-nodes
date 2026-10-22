import { create } from 'zustand';
import type { FailureCopy } from '../lib/errorCopy';

export type AssetStudioKind = 'character' | 'moodboard';
export type AssetStudioSaveState = 'draft' | 'idle' | 'saving' | 'saved' | 'error';
export type StudioFailure = string | FailureCopy;
/** What the toolbar's Retry runs again for `saveError` (GM, error-copy round
 * 3: "Make Retry redo the failed action, never a different one."). */
export type StudioRetry = 'save' | 'analyze' | 'undo' | 'redo';

export interface AssetStudioDraftEntry<D = unknown> {
  draft: D;
  savedId: string | null;
  thumbnail: string;
  saveState: AssetStudioSaveState;
  /** A failure as the Studio shows it: a request's heading and reason
   * (two lines, components/failure/FailureLines), or a line of its own. */
  loadError: StudioFailure | null;
  saveError: StudioFailure | null;
  /** The action that failed with `saveError`, which the toolbar's Retry
   * runs again: a save, an analyze, or an undo or redo of `retryStep`. Null
   * for a line no button redoes (an upload, the brief, no project open):
   * then Retry is hidden and the line keeps GM's full reason; with a retry
   * it takes the short one (WRAP rule). Any other line patched in clears it. */
  retry?: StudioRetry | null;
  /** The undo step an undo or redo failed on: Retry runs only while it is
   * still the step that undo (or redo) would take. */
  retryStep?: string | null;
  loaded: boolean;
  dirty: boolean;
  revision: number;
  epoch: number;
  pendingSaveId: string | null;
  pendingAnalysisId: string | null;
}

/** A project draft is keyed under the canvas project it was started in
 * (lib/currentProject), so switching projects shows that project's drafts and
 * a draft is never saved into a project it wasn't made for. */
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
  ensure: (key: string, entry: AssetStudioDraftEntry) => void;
  patch: (key: string, patch: Partial<AssetStudioDraftEntry>) => void;
  edit: (key: string, update: (draft: unknown) => unknown) => void;
  reset: (key: string, draft: unknown) => void;
  beginSave: (key: string) => { id: string; revision: number; entry: AssetStudioDraftEntry } | null;
  finishSave: (key: string, id: string, revision: number, savedId: string, thumbnail: string) => boolean;
  /** A write failed. `retry` is what failed, for the toolbar's Retry: a save
   * (the default), or an undo or redo of `step`, sent as an edit. Only a
   * save leaves the draft dirty: an undo that didn't land changed nothing. */
  failSave: (key: string, id: string, message: StudioFailure,
    options?: { retry?: Extract<StudioRetry, 'save' | 'undo' | 'redo'>; step?: string }) => void;
  copyTo: (key: string, destination: string) => void;
  /** The asset moved (Global <-> a project): drafts kept for it take its new
   * `projectId` and the key of its new scope, so a later save never sends
   * the old one (a board's PUT refuses that) and unsaved edits come along. */
  rehome: (kind: AssetStudioKind, id: string, projectId: string | null) => void;
  beginAnalysis: (key: string) => { id: string; revision: number } | null;
  clearAnalysis: (key: string, id: string) => void;
}

/** Session continuity only: drafts are never serialized with graphs or credentials. */
export const useAssetStudioDraftStore = create<AssetStudioDraftState>((set, get) => ({
  entries: {},
  aliases: {},
  ensure: (key, entry) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    return state.entries[key] ? {} : { entries: { ...state.entries, [key]: entry } };
  }),
  patch: (key, patch) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    if (!state.entries[key]) return {};
    const next = { ...state.entries[key], ...patch };
    if ('saveError' in patch && !('retry' in patch)) { next.retry = null; next.retryStep = null; }
    return { entries: { ...state.entries, [key]: next } };
  }),
  edit: (key, update) => set((state) => {
    key = resolveAssetStudioDraftKey(state, key);
    const entry = state.entries[key];
    if (!entry) return {};
    return { entries: { ...state.entries, [key]: { ...entry, draft: update(entry.draft),
      revision: entry.revision + 1, dirty: true, saveError: null, retry: null, retryStep: null,
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
  failSave: (key, id, message, options = {}) => {
    key = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[key];
    if (entry?.pendingSaveId !== id) return;
    const retry = options.retry ?? 'save';
    get().patch(key, { pendingSaveId: null, dirty: retry === 'save' ? true : entry.dirty, saveState: 'error',
      saveError: message, retry, retryStep: retry === 'save' ? null : options.step ?? null });
  },
  copyTo: (key, destination) => {
    const source = resolveAssetStudioDraftKey(get(), key);
    const entry = get().entries[source];
    if (!entry || source === destination) return;
    set((state) => {
      const entries = { ...state.entries, [destination]: { ...entry } }; delete entries[source];
      // The destination holds the draft now, so it is no alias any more: an
      // asset moved there and back would otherwise leave the two keys
      // pointing at each other and the open Studio reading neither.
      const aliases = Object.fromEntries(Object.entries(state.aliases)
        .filter(([from]) => from !== destination)
        .map(([from, to]) => [from, to === source ? destination : to]));
      return { entries, aliases: { ...aliases, [source]: destination, [key]: destination } };
    });
  },
  rehome: (kind, id, projectId) => {
    for (const key of Object.keys(get().entries)) {
      let parts: unknown;
      try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts) || parts[0] !== kind || parts[parts.length - 1] !== id) continue;
      const entry = get().entries[key];
      const draft = (entry?.draft ?? null) as { projectId?: string | null } | null;
      if (!entry || !draft || (draft.projectId ?? null) === projectId) continue;
      get().patch(key, { draft: { ...draft, projectId: projectId ?? undefined } });
      // A project draft is keyed by the project open when it was made; the
      // likeliest one to open it next is the project it now lives in.
      const scope = projectId ? 'project' : 'global';
      if (parts[1] !== scope) get().copyTo(key, assetStudioDraftKey(kind, scope, id, projectId));
    }
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
