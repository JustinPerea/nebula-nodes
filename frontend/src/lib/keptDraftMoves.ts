import { wsClient } from './wsClient';
import { useAssetStudioDraftStore } from '../store/assetStudioDraftStore';

// Listen from the first Studio mount, not on import: drafts are kept only
// after a Studio opened, and importing the store shouldn't open a handler.
let listening = false;

/**
 * Keep session drafts in step with moves made anywhere (another tab, the
 * CLI, an agent): a move's `storedAssetChanged` carries the asset's new
 * `projectId`, and every draft kept for it follows (assetStudioDraftStore
 * `rehome`). A Studio's own Move does this itself before the event lands.
 */
export function followAssetMoves(): void {
  if (listening) return;
  listening = true;
  wsClient.subscribe((event) => {
    if (event.type !== 'storedAssetChanged' || event.deleted || !('projectId' in event)) return;
    useAssetStudioDraftStore.getState().rehome(event.kind, event.id, event.projectId ?? null);
  });
}
