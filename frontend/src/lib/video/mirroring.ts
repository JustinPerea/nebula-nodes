import type { TrackComponentType, VideoGraphManifest } from '../../types/video';

/** Maps a TrackItem.componentType to the canvas node definitionId that
 *  feeds it. Phase 2.1.b covers TextNode, SVGInput (via text-input),
 *  ImageAssetNode, and VideoAssetNode. IsometricBlock + LottieNode are
 *  deferred to Phase 2.2 and return null. */
export function componentTypeToCanvasDefId(
  componentType: TrackComponentType,
): string | null {
  switch (componentType) {
    case 'TextNode':
    case 'SVGInput':
      return 'text-input';
    case 'ImageAssetNode':
      return 'image-input';
    case 'VideoAssetNode':
      return 'video-input';
    case 'IsometricBlock':
    case 'LottieNode':
      return null;
  }
}

/** Removes all TrackItems whose sourceNodeId matches the deleted canvas node.
 *  Returns a new manifest reference only when something changed; otherwise
 *  returns the original (cheap no-op for the common case). */
export function pruneTrackItemsForDeletedNode(
  manifest: VideoGraphManifest,
  deletedNodeId: string,
): { changed: boolean; manifest: VideoGraphManifest } {
  const next = manifest.timeline.filter((item) => item.sourceNodeId !== deletedNodeId);
  if (next.length === manifest.timeline.length) {
    return { changed: false, manifest };
  }
  return {
    changed: true,
    manifest: { ...manifest, timeline: next },
  };
}
