import { useState, useEffect } from 'react';
import { AbsoluteFill } from 'remotion';
import { Lottie, type LottieAnimationData } from '@remotion/lottie';
import type { TrackItem } from '../../../types/video';

interface LottieRendererProps {
  item: TrackItem;
}

export function LottieRenderer({ item }: LottieRendererProps) {
  const src = typeof item.props.src === 'string' ? item.props.src : null;
  const [animationData, setAnimationData] = useState<LottieAnimationData | null>(null);

  useEffect(() => {
    if (!src) {
      setAnimationData(null);
      return;
    }
    let cancelled = false;
    fetch(src)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setAnimationData(data as LottieAnimationData);
      })
      .catch(() => {
        if (!cancelled) setAnimationData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!src) {
    return (
      <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no lottie src]
      </AbsoluteFill>
    );
  }

  if (!animationData) {
    return (
      <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [loading lottie…]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center' }}>
      <div data-track-item-content-id={item.id} style={{ width: '100%', height: '100%' }}>
        <Lottie animationData={animationData} style={{ width: '100%', height: '100%' }} />
      </div>
    </AbsoluteFill>
  );
}
