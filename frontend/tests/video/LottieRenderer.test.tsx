import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LottieRenderer } from '../../src/components/video-editor/components/LottieRenderer';
import type { TrackItem } from '../../src/types/video';

// Mock Remotion's useCurrentFrame so LottieRenderer doesn't require a Composition context.
vi.mock('remotion', async () => {
  const actual = await vi.importActual<typeof import('remotion')>('remotion');
  return {
    ...actual,
    useCurrentFrame: () => 0,
  };
});

// Mock @remotion/lottie's Lottie component so the test doesn't need
// the real Lottie player (which expects animationData JSON).
vi.mock('@remotion/lottie', () => ({
  Lottie: ({ animationData }: { animationData: unknown }) => (
    <div data-testid="lottie-mounted" data-has-data={animationData ? 'true' : 'false'} />
  ),
}));

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'LottieNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('LottieRenderer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state when src is missing', () => {
    render(<LottieRenderer item={makeItem({ props: {} })} />);
    expect(screen.getByText(/no lottie src/i)).toBeInTheDocument();
    expect(screen.queryByTestId('lottie-mounted')).toBeNull();
  });

  it('fetches the Lottie JSON from props.src and mounts <Lottie>', async () => {
    const fakeJson = { v: '5.7.1', layers: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(fakeJson),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LottieRenderer item={makeItem({ props: { src: 'https://example.com/anim.json' } })} />);

    await waitFor(() => {
      expect(screen.getByTestId('lottie-mounted')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/anim.json');
  });

  it('applies spatial transform to the successful Lottie wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ v: '5.7.1', layers: [] }),
    }));

    const { container } = render(<LottieRenderer item={makeItem({
      spatial: {
        x: 10,
        y: 20,
        z: 30,
        scale: [2, 3, 4],
        rotation: [5, 15, 25],
      },
      props: { src: 'https://example.com/anim.json' },
    })} />);

    await waitFor(() => {
      expect(screen.getByTestId('lottie-mounted')).toBeInTheDocument();
    });
    const wrapper = container.querySelector('[data-track-item-content-id="t1"]') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.style.transform).toBe(
      'translate3d(10px, 20px, 30px) rotateX(5deg) rotateY(15deg) rotateZ(25deg) scale3d(2, 3, 4)',
    );
  });
});
