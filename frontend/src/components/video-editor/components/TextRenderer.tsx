import { useCurrentFrame, AbsoluteFill } from 'remotion';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface TextRendererProps {
  item: TrackItem;
}

export function TextRenderer({ item }: TextRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  const text = (item.props.text as string) ?? 'Hello World';
  const fontSize = (item.props.fontSize as number) ?? 64;
  const color = (item.props.color as string) ?? '#ffffff';

  return (
    <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
      <div
        style={{
          opacity,
          color,
          fontSize,
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 600,
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
