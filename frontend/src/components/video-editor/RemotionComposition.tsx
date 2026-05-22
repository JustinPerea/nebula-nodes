import { Sequence, AbsoluteFill } from 'remotion';
import type { TrackItem, VideoGraphManifest } from '../../types/video';
import { TextRenderer } from './components/TextRenderer';

interface RemotionCompositionProps {
  manifest: VideoGraphManifest;
}

function renderItem(item: TrackItem) {
  switch (item.componentType) {
    case 'TextNode':
      return <TextRenderer item={item} />;
    // SVGInput, ImageAssetNode, VideoAssetNode, IsometricBlock, LottieNode
    // are added in Plan 2.1.b. Render a labeled placeholder so the timeline
    // still shows the item and the smoke test can verify it.
    default:
      return (
        <AbsoluteFill
          style={{
            display: 'grid',
            placeItems: 'center',
            color: '#ff5500',
            fontFamily: 'system-ui',
          }}
        >
          [{item.componentType} — renderer not yet implemented]
        </AbsoluteFill>
      );
  }
}

export function RemotionComposition({ manifest }: RemotionCompositionProps) {
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {manifest.timeline.map((item) => (
        <Sequence
          key={item.id}
          from={item.time.startFrame}
          durationInFrames={item.time.durationInFrames}
          layout="none"
        >
          {renderItem(item)}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
