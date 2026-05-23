import { useCurrentFrame, AbsoluteFill, Img } from 'remotion';
import type { TrackItem } from '../../../types/video';
import { interpolateScalar, interpolateVec3 } from '../../../lib/video/keyframeInterp';

interface SVGRendererProps {
  item: TrackItem;
}

/** Convert inline SVG markup to a data URL. Using encodeURIComponent (not
 *  btoa) so multi-byte UTF-8 content in the SVG doesn't break. This routes
 *  through Remotion's <Img>, avoiding any innerHTML surface. */
function svgMarkupToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SVGRenderer({ item }: SVGRendererProps) {
  const localFrame = useCurrentFrame();

  const opacity = interpolateScalar(localFrame, item.keyframes.opacity ?? [], 1);
  const position = interpolateVec3(localFrame, item.keyframes.position ?? [], [
    item.spatial.x,
    item.spatial.y,
    item.spatial.z,
  ]);
  const rotation = interpolateVec3(localFrame, item.keyframes.rotation ?? [], item.spatial.rotation);
  const scale = interpolateVec3(localFrame, item.keyframes.scale ?? [], item.spatial.scale);

  // Two source paths: inline markup or external URL. Inline wins if present.
  const svgMarkup = typeof item.props.svg === 'string' ? item.props.svg : null;
  const explicitSrc = typeof item.props.src === 'string' ? item.props.src : null;
  const src = svgMarkup ? svgMarkupToDataUrl(svgMarkup) : explicitSrc;

  const width = typeof item.props.width === 'number' ? item.props.width : undefined;
  const height = typeof item.props.height === 'number' ? item.props.height : undefined;

  if (!src) {
    return (
      <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center', color: '#888' }}>
        <span data-track-item-content-id={item.id}>[no svg source]</span>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill data-track-item-id={item.id} style={{ display: 'grid', placeItems: 'center' }}>
      <Img
        src={src}
        alt=""
        data-track-item-content-id={item.id}
        style={{
          opacity,
          width,
          height,
          maxWidth: '100%',
          maxHeight: '100%',
          transform: `translate3d(${position[0]}px, ${position[1]}px, ${position[2]}px) rotateX(${rotation[0]}deg) rotateY(${rotation[1]}deg) rotateZ(${rotation[2]}deg) scale3d(${scale[0]}, ${scale[1]}, ${scale[2]})`,
        }}
      />
    </AbsoluteFill>
  );
}
