import { useCurrentFrame, AbsoluteFill } from 'remotion';
import { Video } from '@remotion/media';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface VideoRendererProps {
  item: TrackItem;
}

export function VideoRenderer({ item }: VideoRendererProps) {
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
  const volume = typeof item.props.volume === 'number' ? item.props.volume : 1;
  const muted = item.props.muted === true;

  if (!src) {
    return (
      <AbsoluteFill style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        [no video src]
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <Video
        src={src}
        volume={muted ? 0 : volume}
        style={{
          opacity,
          maxWidth: '100%',
          maxHeight: '100%',
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      />
    </AbsoluteFill>
  );
}
