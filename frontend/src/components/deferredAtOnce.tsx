import { Suspense, type FunctionComponent } from 'react';
import type { PreloadableComponent } from '../lib/lazyWithPreload';
import { DeferredBoundary } from './DeferredBoundary';

/**
 * A deferred piece (lib/deferredChunks.ts) mounted straight away, like the
 * Agent log: it draws nothing until its chunk lands and then simply appears.
 * Only for pieces whose fallback is the nothing they drew themselves at that
 * moment: an overlay that shows only what the socket or a fetch brings in, a
 * closed palette. If the chunk fails, the piece draws nothing and retries when
 * the browser is back online or the window regains focus (DeferredBoundary);
 * the rest of the screen keeps working.
 */
export function deferredAtOnce<P extends object>(chunk: PreloadableComponent<P>, name: string): FunctionComponent<P> {
  const Chunk = chunk;
  function AtOnce(props: P) {
    return (
      <DeferredBoundary chunk={chunk} failed={null}>
        <Suspense fallback={null}>
          <Chunk {...props} />
        </Suspense>
      </DeferredBoundary>
    );
  }
  AtOnce.displayName = name;
  return AtOnce;
}
