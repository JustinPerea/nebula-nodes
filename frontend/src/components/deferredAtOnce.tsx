import { Suspense, type FunctionComponent } from 'react';
import type { PreloadableComponent } from '../lib/lazyWithPreload';
import { DeferredBoundary } from './DeferredBoundary';

/** A mounted-at-once deferred piece, with the chunk it waits for. */
export type AtOnceComponent<P> = FunctionComponent<P> & { readonly chunk: PreloadableComponent<P> };

/**
 * A deferred piece (lib/deferredChunks.ts) mounted straight away, like the
 * Agent log: it draws nothing until its chunk lands and then simply appears.
 * Only for a piece whose nothing-until-then is nothing the first frame of a
 * canvas needs: an overlay that shows only what the socket or a fetch brings
 * in, a closed palette. A node card or a card's result view is not one, so the
 * canvas holds a card back until its chunk has settled (lib/cardHold.ts,
 * lib/cardChunks.ts) and this mount never draws it empty beside drawn
 * neighbours. If the chunk fails, the piece draws nothing and retries when
 * the browser is back online or the window regains focus (DeferredBoundary);
 * the rest of the screen keeps working. The chunk is on the returned
 * component so a test can check every deferred card is in the canvas's list.
 */
export function deferredAtOnce<P extends object>(chunk: PreloadableComponent<P>, name: string): AtOnceComponent<P> {
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
  return Object.assign(AtOnce, { chunk });
}
