/* eslint-disable react-refresh/only-export-components -- dedicated Remotion bundle entry */
import { Composition, registerRoot } from 'remotion';
import { RemotionComposition } from '../components/video-editor/RemotionComposition';
import {
  compositionDurationInFrames,
  createEmptyManifest,
  DEFAULT_FPS,
  type VideoGraphManifest,
} from '../types/video';

const NEBULA_COMPOSITION_ID = 'NebulaComposition';

interface NebulaCompositionProps {
  manifest: VideoGraphManifest;
}

const defaultProps: Record<string, unknown> = { manifest: createEmptyManifest() };

function RenderableComposition(props: Record<string, unknown>) {
  return <RemotionComposition manifest={(props as unknown as NebulaCompositionProps).manifest} />;
}

function RemotionRoot() {
  return (
    <Composition
      id={NEBULA_COMPOSITION_ID}
      component={RenderableComposition}
      width={1280}
      height={720}
      fps={DEFAULT_FPS}
      durationInFrames={compositionDurationInFrames(createEmptyManifest())}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: compositionDurationInFrames(
          (props as unknown as NebulaCompositionProps).manifest,
        ),
        props,
      })}
    />
  );
}

registerRoot(RemotionRoot);
