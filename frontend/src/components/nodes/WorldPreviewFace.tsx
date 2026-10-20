import { Box, Globe2 } from 'lucide-react';
import type { WorldValue } from '../../types';
import { worldCaption, worldThumbnail } from '../../lib/worldCard';

/**
 * The node-card face of a World output: thumbnail (or globe placeholder),
 * badge, name, caption and Explore. WorldPreview draws it inside its button,
 * and the deferred-load fallback (DeferredViewers.tsx) draws the very same
 * face while the viewer chunk is on its way, so nothing pops in or shifts
 * when it lands. Kept in the startup entry on purpose; it is small.
 */

export function WorldPreviewFace({ world }: { world: WorldValue }) {
  const thumbnail = worldThumbnail(world);
  return (
    <>
      {thumbnail ? (
        <img className="world-preview__thumbnail" src={thumbnail} alt="" loading="lazy" />
      ) : (
        <span className="world-preview__placeholder" aria-hidden="true">
          <Globe2 size={34} strokeWidth={1.25} />
        </span>
      )}
      <span className="world-preview__shade" aria-hidden="true" />
      <span className="world-preview__badge"><Globe2 size={12} strokeWidth={1.7} /> World</span>
      <span className="world-preview__copy">
        <strong>{world.displayName}</strong>
        <span>{worldCaption(world)}</span>
      </span>
      <span className="world-preview__cta">Explore</span>
    </>
  );
}

/** Face of a World value that does not parse. */
export function InvalidWorldFace() {
  return (
    <>
      <Box aria-hidden="true" size={22} strokeWidth={1.5} />
      <span>World data unavailable</span>
    </>
  );
}
