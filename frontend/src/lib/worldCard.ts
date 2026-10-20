import type { WorldValue } from '../types';
import { backendAssetUrlSync } from './backend';
import { isSafeWorldUrl } from './worldValue';

/** Helpers for the World node-card face (components/nodes/WorldPreviewFace.tsx),
 * shared by WorldPreview and its deferred-load fallback. */

export function safeWorldAsset(value: string | undefined): string | undefined {
  return isSafeWorldUrl(value) ? backendAssetUrlSync(value) : undefined;
}

export function worldThumbnail(world: WorldValue): string | undefined {
  return safeWorldAsset(world.assets.thumbnail ?? world.assets.panorama);
}

export function worldCaption(world: WorldValue): string {
  return world.caption || `${world.displayName}, generated with ${world.model}`;
}
