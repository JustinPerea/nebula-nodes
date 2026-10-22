import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { AssetProposalKind } from './assetProposals';
import { requestReview } from '../store/assetProposalReviewRequest';
import { openWorkspace } from './goToCanvas';
import { refuseWhileCommonsUnsaved } from './commonsUnsaved';

/**
 * Review on an asset proposal's Update (Justin's Q92 a): take the person to
 * where they accept or reject it. A cover on the Projects screen at that
 * project's card, Send notes in Moodboard Studio on that board, a Commons
 * curation on that reference's detail. The strip there brings itself into
 * view (AssetProposalStrip takes the request). Only the Updates corner, a
 * deferred chunk, imports this.
 */
export async function reviewAssetProposal(op: Record<string, unknown>): Promise<void> {
  const kind = op.target as AssetProposalKind;
  const targetId = typeof op.targetId === 'string' ? op.targetId : '';
  if (!targetId || (kind !== 'project' && kind !== 'moodboard' && kind !== 'commons')) {
    throw new Error("This update's proposal can't be opened from here.");
  }
  // Every Review but a Commons ask leaves the screen it starts on: not while
  // the Commons holds unsaved labels unless the person chose to leave (the
  // corner asks first, commons-leave). A Commons ask opens in the Commons,
  // another of its sections, where unsaved labels keep.
  if (kind !== 'commons') refuseWhileCommonsUnsaved();
  const ui = useUIStore.getState();
  if (kind === 'commons' && !ui.commonsEnabled) {
    throw new Error('Turn on the Commons in Settings to review this proposal.');
  }
  requestReview({ kind, targetId });
  if (kind === 'project') {
    await useProjectStore.getState().goHome();
    return;
  }
  // The corner shows on Projects too (Q107 a): the Studio and the Commons
  // live in the open project's workspace, so open it first.
  await openWorkspace();
  if (kind === 'moodboard') {
    // The Studio reads the board's own project and fixes the scope itself.
    useUIStore.getState().enterMoodboardEditor(targetId);
  } else {
    useUIStore.getState().enterCommons();
  }
}
