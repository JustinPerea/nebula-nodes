import { useCallback, useState } from 'react';
import { moveStoredAsset } from '../lib/api';
import { currentProject } from '../lib/currentProject';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore,
  type AssetStudioKind } from '../store/assetStudioDraftStore';
import type { AssetScope } from '../store/uiStore';

export interface StudioMoveRequest {
  /** The saved asset's id. */
  id: string;
  /** The Studio's draft key now (useAssetStudioDraft `key`). */
  key: string;
  /** A canvas project id, or null for Global. */
  target: string | null;
  /** Saves edits made since the last autosave; resolves once it settles. */
  persist: () => Promise<unknown>;
  /** Whether the draft can be saved at all (name, enough images or views). */
  canSave: boolean;
  /** Still the Studio the person is looking at, with this draft? */
  isCurrent: () => boolean;
  /** Is the Studio still open on this asset (the UI only; the draft may have moved key)? */
  isOpen: () => boolean;
  /** Open the moved asset in its new scope (enterMoodboardEditor / enterCharacterEditor). */
  open: (id: string, scope: AssetScope) => void;
}

/**
 * Move from a Studio (Move to Global / Move to <project>).
 *
 * Unsaved edits are saved first, as Delete does, and a failed save stops the
 * move, so what moves is what the person sees. While the move is in flight it
 * holds the draft's save slot (`beginSave`), so an autosave can't send the old
 * `projectId` mid-move; edits typed meanwhile stay in the draft and save after.
 * Then the draft's `projectId` changes and the draft moves to the key its new
 * scope has (`copyTo`, as on create), and the Studio opens the asset there, so
 * the rail switches to its new tab.
 */
export function useStudioAssetMove(kind: AssetStudioKind) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after each move so the rail lists again even when its tab stays.
  const [moves, setMoves] = useState(0);

  const move = useCallback(async (request: StudioMoveRequest): Promise<boolean> => {
    const { id, key, target, persist, canSave, isCurrent, isOpen, open } = request;
    if (!isCurrent()) return false;
    setBusy(true);
    setError(null);
    try {
      const store = useAssetStudioDraftStore.getState();
      if (store.entries[resolveAssetStudioDraftKey(store, key)]?.dirty && canSave) {
        await persist();
        const after = useAssetStudioDraftStore.getState();
        // The save failed (its error shows): don't move what the person can't see saved.
        if (after.entries[resolveAssetStudioDraftKey(after, key)]?.dirty || !isCurrent()) return false;
      }
      const source = resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key);
      const attempt = useAssetStudioDraftStore.getState().beginSave(source);
      if (!attempt) {
        setError('Still saving. Try Move again in a moment.');
        return false;
      }
      // Where the draft is now: the move's own storedAssetChanged can land
      // before its answer and re-home the draft (assetStudioDraftStore rehome).
      const here = () => resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), source);
      const release = () => {
        const latest = useAssetStudioDraftStore.getState();
        const entry = latest.entries[here()];
        if (entry?.pendingSaveId === attempt.id) {
          latest.patch(here(), { pendingSaveId: null, saveState: entry.dirty ? 'draft' : 'saved' });
        }
      };
      let result;
      try {
        result = await moveStoredAsset(kind, id, target);
      } catch (err) {
        release();
        setError(err instanceof Error ? err.message : 'Move failed.');
        return false;
      }
      const latest = useAssetStudioDraftStore.getState();
      const moved = here();
      const entry = latest.entries[moved];
      if (entry) {
        // Only the scope changes; edits typed during the move are kept (and
        // finishSave marks them unsaved, so they save to the new place).
        const draft = entry.draft as Record<string, unknown>;
        latest.patch(moved, { draft: { ...draft, projectId: result.to ?? undefined } });
        latest.finishSave(moved, attempt.id, attempt.revision, id, entry.thumbnail);
      }
      const scope: AssetScope = result.to ? 'project' : 'global';
      const destination = assetStudioDraftKey(kind, scope, id, currentProject()?.id ?? null);
      useAssetStudioDraftStore.getState().copyTo(moved, destination);
      setMoves((value) => value + 1);
      if (isOpen()) open(id, scope);
      return true;
    } finally {
      setBusy(false);
    }
  }, [kind]);

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, moves, move, clearError };
}
