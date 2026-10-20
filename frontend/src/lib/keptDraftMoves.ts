import { wsClient } from './wsClient';
import { fetchCharacter, fetchMoodboard } from './api';
import { useAssetStudioDraftStore, type AssetStudioKind } from '../store/assetStudioDraftStore';

// Listen from the first Studio mount, not on import: drafts are kept only
// after a Studio opened, and importing the store shouldn't open a handler.
let listening = false;

/** The saved assets that drafts are kept for: each kind and id once. A draft
 *  for a new asset (no `savedId`) has nowhere to follow. */
function keptAssets(): Array<{ kind: AssetStudioKind; id: string }> {
  const seen = new Map<string, { kind: AssetStudioKind; id: string }>();
  for (const [key, entry] of Object.entries(useAssetStudioDraftStore.getState().entries)) {
    let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts) || (parts[0] !== 'moodboard' && parts[0] !== 'character')) continue;
    const id = entry?.savedId;
    if (!id || parts[parts.length - 1] !== id) continue;
    seen.set(`${parts[0]}:${id}`, { kind: parts[0], id });
  }
  return [...seen.values()];
}

/** Back after the socket was down: a move made meanwhile wasn't said to this
 *  tab, so each kept draft reads where its asset lives now and follows it. An
 *  asset that's gone, or that can't be read now, leaves its draft as it is
 *  (the Studio says so when it opens it). */
async function rehomeKeptDrafts(): Promise<void> {
  await Promise.all(keptAssets().map(async ({ kind, id }) => {
    const asset = await (kind === 'moodboard' ? fetchMoodboard(id) : fetchCharacter(id)).catch(() => null);
    if (asset) useAssetStudioDraftStore.getState().rehome(kind, id, asset.projectId ?? null);
  }));
}

/**
 * Keep session drafts in step with moves made anywhere (another tab, the
 * CLI, an agent): a move's `storedAssetChanged` carries the asset's new
 * `projectId`, and every draft kept for it follows (assetStudioDraftStore
 * `rehome`). A Studio's own Move does this itself before the event lands.
 * When the socket comes back after it was closed (`socketReconnected`), every
 * kept draft reads its asset again, since a move made meanwhile isn't
 * replayed.
 */
export function followAssetMoves(): void {
  if (listening) return;
  listening = true;
  wsClient.subscribe((event) => {
    if (event.type === 'socketReconnected') {
      void rehomeKeptDrafts();
      return;
    }
    if (event.type !== 'storedAssetChanged' || event.deleted || !('projectId' in event)) return;
    useAssetStudioDraftStore.getState().rehome(event.kind, event.id, event.projectId ?? null);
  });
}
