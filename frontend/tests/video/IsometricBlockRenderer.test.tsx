import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { IsometricBlockRenderer } from '../../src/components/video-editor/components/IsometricBlockRenderer';
import type { TrackItem } from '../../src/types/video';

// JSDOM has no WebGL; stub @remotion/three's canvas as a passthrough div.
vi.mock('@remotion/three', () => ({
  ThreeCanvas: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="three-canvas">{children}</div>
  ),
}));

// Stub drei's OrthographicCamera so the test doesn't need three.js.
vi.mock('@react-three/drei', () => ({
  OrthographicCamera: ({ position }: { position: [number, number, number] }) => (
    <div data-testid="ortho-camera" data-pos={position.join(',')} />
  ),
  useGLTF: (url: string) => ({ scene: { name: `mock-scene-${url}` } }),
}));

// Stub remotion's useVideoConfig so the component can run outside a composition.
vi.mock('remotion', () => ({
  useVideoConfig: () => ({ width: 1920, height: 1080, fps: 30, durationInFrames: 300 }),
}));

function makeItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'IsometricBlock',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: {},
    ...overrides,
  };
}

describe('IsometricBlockRenderer', () => {
  it('renders a ThreeCanvas + orthographic camera by default', () => {
    const { getByTestId } = render(<IsometricBlockRenderer item={makeItem()} />);
    expect(getByTestId('three-canvas')).toBeInTheDocument();
    expect(getByTestId('ortho-camera')).toBeInTheDocument();
  });

  it('positions the default camera at the 45° isometric angle', () => {
    const { getByTestId } = render(<IsometricBlockRenderer item={makeItem()} />);
    const cam = getByTestId('ortho-camera');
    // True isometric: position vector should have x ≈ z and y > 0
    const [x, y, z] = (cam.getAttribute('data-pos') ?? '0,0,0').split(',').map(Number);
    expect(x).toBeCloseTo(z, 1);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it.each([
    ['cube'],
    ['sphere'],
    ['cylinder'],
    ['cone'],
    ['plane'],
  ])('routes geometry=%s through the correct primitive case', (geometry) => {
    const { container } = render(
      <IsometricBlockRenderer item={makeItem({ props: { geometry } })} />,
    );
    // IsometricBlockRenderer wraps the ThreeCanvas in a <div data-iso-geometry={geometry}>
    // so we can assert routing in JSDOM (which has no GL).
    expect(container.querySelector(`[data-iso-geometry="${geometry}"]`)).not.toBeNull();
  });

  it('routes geometry=gltf through the GLTF primitive case', () => {
    const { container } = render(
      <IsometricBlockRenderer item={makeItem({ props: { geometry: 'gltf', gltfUrl: 'https://example.com/cube.glb' } })} />,
    );
    expect(container.querySelector('[data-iso-geometry="gltf"]')).not.toBeNull();
  });
});
