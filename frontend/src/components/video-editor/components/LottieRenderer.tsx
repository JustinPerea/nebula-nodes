import { useState, useEffect } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Lottie, type LottieAnimationData } from '@remotion/lottie';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface LottieRendererProps {
  item: TrackItem;
}

export function LottieRenderer({ item }: LottieRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

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
        <span
          data-track-item-content-id={item.id}
          style={{
            opacity,
            transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
          }}
        >
          [no lottie src]
        </span>
      </AbsoluteFill>
    );
  }

  if (!animationData) {
    return (
      <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        <span
          data-track-item-content-id={item.id}
          style={{
            opacity,
            transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
          }}
        >
          [loading lottie…]
        </span>
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
