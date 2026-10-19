import { useCallback, useState } from 'react';
import { deleteCharacter, deleteMoodboard } from '../lib/api';
import { restoreTrashed } from '../lib/trash';
import type { AssetScope } from '../store/uiStore';

export interface DeletedAsset {
  id: string;
  name: string;
  scope: AssetScope;
}

/**
 * Delete a board or character from its Studio, with Undo.
 *
 * The delete moves it to Recently deleted (backend services/asset_trash.py);
 * Undo restores it with the same id. `refreshKey` changes after each delete
 * or undo so the Studio's Recently deleted list and library rail reload.
 */
export function useAssetDelete(kind: 'moodboard' | 'character') {
  const [lastDeleted, setLastDeleted] = useState<DeletedAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const remove = useCallback(async (asset: DeletedAsset): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await (kind === 'moodboard' ? deleteMoodboard(asset.id) : deleteCharacter(asset.id));
      setLastDeleted(asset);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
      return false;
    } finally {
      setBusy(false);
      setRefreshKey((value) => value + 1);
    }
  }, [kind]);

  const undo = useCallback(async (): Promise<DeletedAsset | null> => {
    const asset = lastDeleted;
    if (!asset) return null;
    setBusy(true);
    setError(null);
    try {
      await restoreTrashed(kind, asset.id);
      setLastDeleted(null);
      return asset;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Undo failed.');
      return null;
    } finally {
      setBusy(false);
      setRefreshKey((value) => value + 1);
    }
  }, [kind, lastDeleted]);

  const dismiss = useCallback(() => { setLastDeleted(null); setError(null); }, []);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return { lastDeleted, busy, error, refreshKey, remove, undo, dismiss, refresh };
}
