import { DEFAULT_ANCHOR } from '../../types/video';
import type { SpatialTransform } from '../../types/video';

export function transformOriginFromAnchor(anchor: SpatialTransform['anchor'] = DEFAULT_ANCHOR): string {
  const [x, y] = anchor ?? DEFAULT_ANCHOR;
  return `${x * 100}% ${y * 100}%`;
}
