import { Sequence, AbsoluteFill } from 'remotion';
import type { TrackItem, VideoGraphManifest } from '../../types/video';
import { TextRenderer } from './components/TextRenderer';
import { SVGRenderer } from './components/SVGRenderer';
import { ImageRenderer } from './components/ImageRenderer';
import { VideoRenderer } from './components/VideoRenderer';
import { IsometricBlockRenderer } from './components/IsometricBlockRenderer';
import { LottieRenderer } from './components/LottieRenderer';

export interface RemotionCompositionProps {
  manifest: VideoGraphManifest;
}

function renderItem(item: TrackItem) {
  switch (item.componentType) {
    case 'TextNode':
      return <TextRenderer item={item} />;
    case 'SVGInput':
      return <SVGRenderer item={item} />;
    case 'ImageAssetNode':
      return <ImageRenderer item={item} />;
    case 'VideoAssetNode':
      return <VideoRenderer item={item} />;
    case 'IsometricBlock':
      return <IsometricBlockRenderer item={item} />;
    case 'LottieNode':
      return <LottieRenderer item={item} />;
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
