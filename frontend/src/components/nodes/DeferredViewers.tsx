import { Suspense } from 'react';
import type { WorldPreviewProps } from './WorldPreview';
import { DeferredMeshPreview, DeferredWorldPreview, DeferredWorldSplatPreview } from '../../lib/deferredChunks';
import type { WorldSplatPreviewProps } from './WorldSplatPreview';
import { isSplatExport, meshFormatLabel } from '../../lib/meshFormat';
import { parseWorldValue } from '../../lib/worldValue';
import { InvalidWorldFace, WorldPreviewFace } from './WorldPreviewFace';
import { DeferredBoundary } from '../DeferredBoundary';
// The fallbacks below use the viewers' own classes, so their styles stay in the
// startup CSS (nodes.css carries .mesh-preview) and only the JS is deferred.
import '../../styles/world-preview.css';

/**
 * Node-card mesh and world previews, loaded on first use. Each fallback is the
 * idle card the real viewer draws first (same classes, same min-height, the
 * same absolutely placed layers), so a node does not change height when the
 * viewer chunk arrives. After the idle preload in App.tsx the chunk is usually
 * already here and the fallback never renders. If the chunk fails to load, the
 * card keeps that face and the real viewer replaces it once the chunk loads
 * (back online, window focus, or any other preload; DeferredBoundary).
 */

function MeshPreviewFallback({ src }: { src: string }) {
  const status = isSplatExport(src) ? 'file' : 'idle';
  const label = meshFormatLabel(src);
  return (
    <div
      className={`mesh-preview mesh-preview--${status} nodrag nowheel`}
      role="status"
      aria-label={`Loading ${label} preview`}
      data-status={status}
      data-deferred-fallback="mesh"
    >
      <div className="mesh-preview__placeholder" aria-hidden="true">
        <span className="mesh-preview__mesh" />
      </div>
      <div className="mesh-preview__hud" aria-hidden="true">
        <span>{label}</span>
        <span>{status}</span>
      </div>
    </div>
  );
}

export function MeshPreview({ src }: { src: string }) {
  return (
    <DeferredBoundary chunk={DeferredMeshPreview} failed={<MeshPreviewFallback src={src} />}>
      <Suspense fallback={<MeshPreviewFallback src={src} />}>
        <DeferredMeshPreview src={src} />
      </Suspense>
    </DeferredBoundary>
  );
}

function WorldPreviewFallback({ value, compact = false }: WorldPreviewProps) {
  const world = parseWorldValue(value);
  if (!world) {
    return (
      <div className="world-preview world-preview--invalid" role="status" data-deferred-fallback="world">
        <InvalidWorldFace />
      </div>
    );
  }
  // The same face the viewer's button draws (WorldPreviewFace), so the card
  // neither changes size nor pops in a badge, icon or thumbnail on arrival.
  return (
    <div
      className={`world-preview nodrag nowheel${compact ? ' world-preview--compact' : ''}`}
      role="status"
      aria-label={`Loading 3D world: ${world.displayName}`}
      data-deferred-fallback="world"
    >
      <WorldPreviewFace world={world} />
    </div>
  );
}

export function WorldPreview(props: WorldPreviewProps) {
  return (
    <DeferredBoundary chunk={DeferredWorldPreview} failed={<WorldPreviewFallback {...props} />}>
      <Suspense fallback={<WorldPreviewFallback {...props} />}>
        <DeferredWorldPreview {...props} />
      </Suspense>
    </DeferredBoundary>
  );
}

/** The same button the World v2 splat viewer draws, disabled until its chunk
 * arrives, so the card keeps its height. */
function WorldSplatPreviewFallback({ world, compact = false }: WorldSplatPreviewProps) {
  return (
    <button
      type="button"
      className={`world-splat-preview__open nodrag nowheel${compact ? ' world-splat-preview__open--compact' : ''}`}
      disabled
      aria-label={`Explore “${world.displayName}” in 3D`}
      data-deferred-fallback="world-splat"
    >
      <span className="world-splat-preview__glyph" aria-hidden="true" />
      Explore in 3D
    </button>
  );
}

export function WorldSplatPreview(props: WorldSplatPreviewProps) {
  return (
    <DeferredBoundary chunk={DeferredWorldSplatPreview} failed={<WorldSplatPreviewFallback {...props} />}>
      <Suspense fallback={<WorldSplatPreviewFallback {...props} />}>
        <DeferredWorldSplatPreview {...props} />
      </Suspense>
    </DeferredBoundary>
  );
}
