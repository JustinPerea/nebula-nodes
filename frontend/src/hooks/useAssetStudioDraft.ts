import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { assetStudioDraftKey, emptyAssetStudioEntry, useAssetStudioDraftStore,
  resolveAssetStudioDraftKey, type AssetStudioDraftEntry, type AssetStudioKind } from '../store/assetStudioDraftStore';
import { getCurrentProject } from '../lib/currentProject';

export function useAssetStudioDraft<D>(kind: AssetStudioKind, scope: string, id: string | null,
  createEmpty: () => D) {
  const projectId = useAssetStudioDraftStore((state) => state.projectId);
  const [verifiedTarget, setVerifiedTarget] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const target = JSON.stringify([scope, id]);
  const projectReady = scope !== 'project' || verifiedTarget === target;
  useEffect(() => {
    if (scope !== 'project') return;
    let cancelled = false;
    void getCurrentProject().then((project) => {
      if (cancelled) return;
      useAssetStudioDraftStore.getState().setProjectId(project.id);
      setProjectError(null); setVerifiedTarget(target);
    }).catch((err) => { if (!cancelled) setProjectError(err instanceof Error ? err.message : 'Failed to resolve project.'); });
    return () => { cancelled = true; };
  }, [target, scope]);
  const requestedKey = assetStudioDraftKey(kind, scope, id, projectId);
  const key = useAssetStudioDraftStore((state) => resolveAssetStudioDraftKey(state, requestedKey));
  const fallback = useMemo(() => emptyAssetStudioEntry(createEmpty()), [createEmpty]);
  const stored = useAssetStudioDraftStore((state) => state.entries[key]) as AssetStudioDraftEntry<D> | undefined;
  const entry = stored ?? fallback;
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
  const verifyProject = useCallback(async () => {
    if (scope !== 'project') return true;
    try {
      const project = await getCurrentProject();
      useAssetStudioDraftStore.getState().setProjectId(project.id);
      setProjectError(null); setVerifiedTarget(target);
      return projectReady && project.id === projectId;
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Failed to resolve project.');
      return false;
    }
  }, [scope, projectId, projectReady, target]);
  return { ...entry, loaded: projectReady && entry.loaded, loadError: scope === 'project' ? projectError ?? entry.loadError : entry.loadError,
    key, projectId, projectReady, verifyProject, setDraft, patch, initialize };
}
