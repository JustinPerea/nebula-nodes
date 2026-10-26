import { useAssetProposalsStore, type ReviewRequest } from './assetProposalsStore';
import type { AssetProposalKind } from '../lib/assetProposals';

/**
 * Review on an asset proposal's Update (Q92 a) asks the strip for that
 * target to come into view (lib/assetProposalReview.ts navigates there).
 * The request lives in the eager store (`review`); these two helpers live
 * here so only the deferred chunks that use them carry them.
 */

/** A request older than this is stale (the strip never came: it closed meanwhile). */
const REVIEW_TTL_MS = 10_000;

/** Ask the strip for this target to come into view when it shows. */
export function requestReview({ kind, targetId }: { kind: AssetProposalKind; targetId: string }): void {
  const review: ReviewRequest = { kind, targetId, at: Date.now() };
  useAssetProposalsStore.setState({ review });
  // The strip never came (the proposal closed meanwhile): drop the request so
  // nothing can act on it later, e.g. the Commons reopening that reference.
  setTimeout(() => {
    if (useAssetProposalsStore.getState().review === review) useAssetProposalsStore.setState({ review: null });
  }, REVIEW_TTL_MS);
}

const opened = new WeakSet<ReviewRequest>();

/**
 * A screen that opens the target itself (the Commons opens that reference's
 * detail) acts on each request once: true the first time, false after, even
 * when the screen mounts again while the request is still held.
 */
export function openOnce(review: ReviewRequest): boolean {
  if (opened.has(review)) return false;
  opened.add(review);
  return true;
}

/** The strip for this target takes the request: true once (while fresh), then it is gone. */
export function takeReview(kind: AssetProposalKind, targetId: string): boolean {
  const { review } = useAssetProposalsStore.getState();
  if (!review || review.kind !== kind || review.targetId !== targetId) return false;
  useAssetProposalsStore.setState({ review: null });
  return Date.now() - review.at <= REVIEW_TTL_MS;
}
