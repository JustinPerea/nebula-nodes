import { memo, useEffect, useState, type ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import { heldCardOf, takeSwap } from '../../lib/cardFallback';
import { springLinear, SPRING_SOFT } from '../../lib/springs';
import { CardFallbackFrame } from './CardFallback';
import '../../styles/card-fallback.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * A card that replaces a fallback frame (lib/cardHold.ts marks it,
 * lib/cardFallback.ts takeSwap) fades in on the opacity spring while a ghost of the frame lies
 * over it and fades out on the same one: a crossfade, no scale or movement
 * (styles/card-fallback.css; the spring comes from the canvas wrapper's
 * variables). Under reduced motion both take a 180 ms opacity fade. The card
 * stays the node element's first child and no box is added around it, so a
 * card that was never a frame draws exactly as it does without this wrapper.
 */
export function withCardSwap<P extends NodeProps>(Card: ComponentType<P>): ComponentType<P> {
  function Swapped(props: P) {
    const { id, data, selected } = props;
    // Read and deleted on the first render: a mark is for one mount, and an old one is not honoured.
    const [fading, setFading] = useState(() => takeSwap(id));
    useEffect(() => {
      if (!fading) return undefined;
      const timer = window.setTimeout(() => setFading(false), prefersReducedMotion() ? 180 : springLinear(SPRING_SOFT).durationMs);
      return () => window.clearTimeout(timer);
    }, [fading]);
    return (
      <>
        <Card {...props} />
        {fading ? <CardFallbackFrame data={(data ?? {}) as Record<string, unknown>} held={heldCardOf(data)} selected={selected} ghost /> : null}
      </>
    );
  }
  Swapped.displayName = `Swapped(${Card.displayName ?? Card.name})`;
  return memo(Swapped) as unknown as ComponentType<P>;
}
