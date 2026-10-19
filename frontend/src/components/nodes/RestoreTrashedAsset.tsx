import { useState } from 'react';
import { restoreTrashed } from '../../lib/trash';
import { useStoredAssetsStore, type StoredAssetKind } from '../../store/storedAssetsStore';
import '../../styles/asset-trash.css';

/** Restore button for a Moodboard or Character card whose asset is in
 * Recently deleted. Agents may restore too; this is the person's way. */
export function RestoreTrashedAsset({ kind, id, className }: { kind: StoredAssetKind; id: string; className: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={`${className} nodrag`}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          restoreTrashed(kind, id)
            .then(() => useStoredAssetsStore.getState().refresh(kind, id))
            .catch((err) => setError(err instanceof Error ? err.message : 'Restore failed.'))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      {error && <div className={`${className}-error`} role="alert">{error}</div>}
    </>
  );
}
