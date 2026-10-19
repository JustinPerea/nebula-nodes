import { useCallback, useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { assetStudioDraftKey, emptyAssetStudioEntry, useAssetStudioDraftStore,
  resolveAssetStudioDraftKey, type AssetStudioDraftEntry, type AssetStudioKind } from '../store/assetStudioDraftStore';
import { NO_PROJECT_OPEN, currentProject, useCurrentProjectId } from '../lib/currentProject';
import { followAssetMoves } from '../lib/keptDraftMoves';

/**
 * One Studio's session draft. A project draft is keyed under the canvas
 * project open now (lib/currentProject), so switching projects moves the
 * Studio to that project's drafts at once; the previous project's draft waits
 * under its own key until that project is open again.
 */
export function useAssetStudioDraft<D>(kind: AssetStudioKind, scope: string, id: string | null,
  createEmpty: () => D) {
  const projectId = useCurrentProjectId();
  const projectReady = scope !== 'project' || projectId !== null;
  const projectError = scope === 'project' && projectId === null ? NO_PROJECT_OPEN : null;
  const requestedKey = assetStudioDraftKey(kind, scope, id, projectId);
  const key = useAssetStudioDraftStore((state) => resolveAssetStudioDraftKey(state, requestedKey));
  const fallback = useMemo(() => emptyAssetStudioEntry(createEmpty()), [createEmpty]);
  const stored = useAssetStudioDraftStore((state) => state.entries[key]) as AssetStudioDraftEntry<D> | undefined;
  const entry = stored ?? fallback;
  useEffect(() => { followAssetMoves(); }, []);
  useEffect(() => { if (projectReady) useAssetStudioDraftStore.getState().ensure(key, fallback); }, [key, fallback, projectReady]);
  const patch = useCallback((next: Partial<AssetStudioDraftEntry<D>>) => {
    const store = useAssetStudioDraftStore.getState();
    store.ensure(key, fallback);
    store.patch(key, next);
  }, [key, fallback]);
  const setDraft: Dispatch<SetStateAction<D>> = useCallback((next) => {
    const store = useAssetStudioDraftStore.getState();
    store.ensure(key, fallback);
    store.edit(key, (current) => typeof next === 'function'
      ? (next as (draft: D) => D)(current as D) : next);
  }, [key, fallback]);
  const initialize = useCallback((draft: D, savedId: string | null = null, thumbnail = '', loadError: string | null = null) => {
    patch({ draft, savedId, thumbnail, loadError, loaded: true, dirty: false,
      saveState: savedId ? 'saved' : 'draft', saveError: null });
  }, [patch]);
  /** True when this draft may be saved now: a project draft only while the
   * project it's keyed under is still the open one. A save that lost that
   * race (an agent switched projects mid-autosave) is dropped, not filed in
   * the newly open project; the draft stays under its own project. */
  const verifyProject = useCallback(async () => {
    if (scope !== 'project') return true;
    return projectId !== null && currentProject()?.id === projectId;
  }, [scope, projectId]);
  return { ...entry, loaded: projectReady && entry.loaded, loadError: projectError ?? entry.loadError,
    key, projectId, projectReady, verifyProject, setDraft, patch, initialize };
}
