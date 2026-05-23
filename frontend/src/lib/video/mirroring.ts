import type { TrackComponentType, VideoGraphManifest } from '../../types/video';

/** Maps a TrackItem.componentType to the canvas node definitionId that
 *  feeds it. Phase 2.1.b covers TextNode, SVGInput (via text-input),
 *  ImageAssetNode, and VideoAssetNode. Phase 2.2 adds stubs for
 *  IsometricBlock (text-input) and LottieNode (image-input) — the
 *  block config and the Lottie URL live in TrackItem.props, so the
 *  spawned source node carries no meaningful state. */
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
      return 'text-input';
    case 'LottieNode':
      return 'image-input';
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
