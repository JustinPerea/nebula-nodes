import { useCallback, useState } from 'react';
import { deleteCharacter, deleteMoodboard } from '../lib/api';
import { deletePreset } from '../lib/createPresets';
import { restoreTrashed } from '../lib/trash';
import type { AssetScope } from '../store/uiStore';
import { failureCopy, type FailureCopy } from '../lib/errorCopy';

const NOUN = { moodboard: 'board', character: 'character', style: 'style' } as const;

export interface DeletedAsset {
  id: string;
  name: string;
  scope: AssetScope;
}

/**
 * Delete a board or character from its Studio (a Style from the Assets
 * panel), with Undo.
 *
 * The delete moves it to Recently deleted (backend services/asset_trash.py);
 * Undo restores it with the same id. `refreshKey` changes after each delete
 * or undo so the Studio's Recently deleted list and library rail reload.
 */
export function useAssetDelete(kind: 'moodboard' | 'character' | 'style') {
  const [lastDeleted, setLastDeleted] = useState<DeletedAsset | null>(null);
  const [busy, setBusy] = useState(false);
  /** Failures as heading + reason, kept apart (error copy round 3b): a
   * delete's shows in the Studio's notice; Undo's own shows in the toast,
   * beside the Undo that redoes it. The toast's Undo restores the asset
   * deleted last, so a later delete's failure must not sit beside it. */
  const [deleteError, setDeleteError] = useState<FailureCopy | null>(null);
  const [undoError, setUndoError] = useState<FailureCopy | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const remove = useCallback(async (asset: DeletedAsset): Promise<boolean> => {
    setBusy(true);
    setDeleteError(null);
    try {
      await (kind === 'moodboard' ? deleteMoodboard(asset.id)
        : kind === 'style' ? deletePreset(asset.id) : deleteCharacter(asset.id));
      setLastDeleted(asset);
      setUndoError(null);
      return true;
    } catch (err) {
      setDeleteError(failureCopy(err, { heading: `Couldn't delete the ${NOUN[kind]}.` }));
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
    setUndoError(null);
    try {
      await restoreTrashed(kind, asset.id);
      setLastDeleted(null);
      return asset;
    } catch (err) {
      setUndoError(failureCopy(err, { heading: `Couldn't restore the ${NOUN[kind]}.` }));
      return null;
    } finally {
      setBusy(false);
      setRefreshKey((value) => value + 1);
    }
  }, [kind, lastDeleted]);

  const dismiss = useCallback(() => { setLastDeleted(null); setUndoError(null); }, []);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  return { lastDeleted, busy, deleteError, undoError, refreshKey, remove, undo, dismiss, refresh };
}
