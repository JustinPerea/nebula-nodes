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
  /** A failure as heading + reason (a Studio's two-line notice; the toast shows it as one line). */
  const [error, setError] = useState<FailureCopy | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const remove = useCallback(async (asset: DeletedAsset): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await (kind === 'moodboard' ? deleteMoodboard(asset.id)
        : kind === 'style' ? deletePreset(asset.id) : deleteCharacter(asset.id));
      setLastDeleted(asset);
      return true;
    } catch (err) {
      setError(failureCopy(err, { heading: `Couldn't delete the ${NOUN[kind]}.` }));
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
      setError(failureCopy(err, { heading: `Couldn't restore the ${NOUN[kind]}.` }));
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
