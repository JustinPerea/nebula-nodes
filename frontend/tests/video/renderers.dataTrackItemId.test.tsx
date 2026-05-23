import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { TrackItem } from '../../src/types/video';
import { TextRenderer } from '../../src/components/video-editor/components/TextRenderer';
import { SVGRenderer } from '../../src/components/video-editor/components/SVGRenderer';
import { ImageRenderer } from '../../src/components/video-editor/components/ImageRenderer';
import { VideoRenderer } from '../../src/components/video-editor/components/VideoRenderer';
import { LottieRenderer } from '../../src/components/video-editor/components/LottieRenderer';

// Mock Remotion's useCurrentFrame and Img so renderers don't require a Composition context.
vi.mock('remotion', async () => {
  const actual = await vi.importActual<typeof import('remotion')>('remotion');
  return {
    ...actual,
    useCurrentFrame: () => 0,
    Img: ({ src, alt, style, ...rest }: { src: string; alt?: string; style?: React.CSSProperties; [key: string]: unknown }) => (
      <img src={src} alt={alt} style={style} {...rest} />
    ),
  };
});

// Mock @remotion/lottie's Lottie component so the test doesn't need
// the real Lottie player (which expects animationData JSON).
vi.mock('@remotion/lottie', () => ({
  Lottie: ({ animationData }: { animationData: unknown }) => (
    <div data-testid="lottie-mounted" data-has-data={animationData ? 'true' : 'false'} />
  ),
}));

// Mock @remotion/media's Video component so the test doesn't require video config.
vi.mock('@remotion/media', () => ({
  Video: ({ src, volume, style }: { src: string; volume?: number; style?: React.CSSProperties }) => (
    <video src={src} style={style} data-volume={volume} />
  ),
}));

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 'track-abc',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('CSS-driven renderers — data-track-item-id', () => {
  it('TextRenderer puts data-track-item-id on its root AbsoluteFill', () => {
    const { container } = render(<TextRenderer item={makeItem({ props: { text: 'hi' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('SVGRenderer happy path puts data-track-item-id on its root', () => {
    const { container } = render(<SVGRenderer item={makeItem({ componentType: 'SVGInput', props: { svg: '<svg/>' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('SVGRenderer empty-state ([no svg source]) also puts data-track-item-id', () => {
    const { container } = render(<SVGRenderer item={makeItem({ componentType: 'SVGInput', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('ImageRenderer happy path puts data-track-item-id on its root', () => {
    const { container } = render(<ImageRenderer item={makeItem({ componentType: 'ImageAssetNode', props: { src: 'data:image/png;base64,AAAA' } })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('ImageRenderer empty-state also puts data-track-item-id', () => {
    const { container } = render(<ImageRenderer item={makeItem({ componentType: 'ImageAssetNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('VideoRenderer empty-state puts data-track-item-id (happy path requires media context)', () => {
    const { container } = render(<VideoRenderer item={makeItem({ componentType: 'VideoAssetNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });

  it('LottieRenderer empty-state ([no lottie src]) puts data-track-item-id', () => {
    const { container } = render(<LottieRenderer item={makeItem({ componentType: 'LottieNode', props: {} })} />);
    expect(container.querySelector('[data-track-item-id="track-abc"]')).not.toBeNull();
  });
});

describe('CSS-driven renderers — data-track-item-content-id', () => {
  it('TextRenderer puts data-track-item-content-id on the inner content div', () => {
    const { container } = render(<TextRenderer item={makeItem({ props: { text: 'hi' } })} />);
    expect(container.querySelector('[data-track-item-content-id="track-abc"]')).not.toBeNull();
  });

  it('SVGRenderer happy path puts data-track-item-content-id on the Img element', () => {
    const { container } = render(<SVGRenderer item={makeItem({ componentType: 'SVGInput', props: { svg: '<svg/>' } })} />);
    expect(container.querySelector('[data-track-item-content-id="track-abc"]')).not.toBeNull();
  });

  it('ImageRenderer happy path puts data-track-item-content-id on the Img element', () => {
    const { container } = render(<ImageRenderer item={makeItem({ componentType: 'ImageAssetNode', props: { src: 'data:image/png;base64,AAAA' } })} />);
    expect(container.querySelector('[data-track-item-content-id="track-abc"]')).not.toBeNull();
  });
});
