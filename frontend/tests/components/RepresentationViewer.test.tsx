import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PortValue } from '../../src/types';
import {
  RepresentationViewer,
} from '../../src/components/nodes/RepresentationViewer';
import {
  findStructuredRepresentation,
  hasRepresentationViewer,
  REPRESENTATION_VIEWER_REGISTRY,
  STRUCTURED_REPRESENTATION_PRIORITY,
} from '../../src/lib/representationViewerRegistry';
import { OutputRenderer } from '../../src/components/create-studio/OutputRenderer';
import {
  cameraPoseFixture,
  pointCloudFixture,
  spatialFixtureByType,
  worldV1Fixture,
  worldV2Fixture,
} from '../fixtures/spatialValues';

vi.mock('../../src/components/nodes/WorldPreview', () => ({
  WorldPreview: ({ compact }: { compact?: boolean }) => (
    <div data-testid="legacy-world-preview" data-compact={compact ? 'true' : 'false'} />
  ),
}));

vi.mock('../../src/components/nodes/MeshPreview', () => ({
  MeshPreview: () => <div data-testid="mesh-preview" />,
}));

vi.mock('../../src/lib/backend', () => ({
  backendAssetUrlSync: (value: string) => (
    value.startsWith('/api/outputs/') ? `http://127.0.0.1:8007${value}` : value
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('representation viewer registry', () => {
  it.each(['splat', 'panorama', 'colliderMesh'])('rejects contradictory %s media metadata', (role) => {
    const value = JSON.parse(JSON.stringify(worldV2Fixture));
    if (role === 'splat') value.assets.splats[0].asset.mediaType = 'image/png';
    else value.assets[role] = { id: 'wrong-media', uri: '/api/outputs/run/wrong.bin', mediaType: 'text/html' };
    expect(REPRESENTATION_VIEWER_REGISTRY.World.parse(value)).toBeNull();
  });
  it('shows depth interpretation even on compact cards', () => {
    render(<RepresentationViewer type="DepthMap" value={spatialFixtureByType.DepthMap} compact />);
    expect(screen.getByText('axial · little')).toBeInTheDocument();
    expect(screen.getByText('distance = sample × 1 + 0')).toBeInTheDocument();
    expect(screen.getByText('Invalid: nonfinite samples')).toBeInTheDocument();
  });
  it('registers every versioned spatial port and accepts the safe fixtures', () => {
    expect(Object.keys(REPRESENTATION_VIEWER_REGISTRY)).toEqual(STRUCTURED_REPRESENTATION_PRIORITY);
    for (const type of STRUCTURED_REPRESENTATION_PRIORITY) {
      expect(hasRepresentationViewer(type)).toBe(true);
      expect(REPRESENTATION_VIEWER_REGISTRY[type]?.parse(spatialFixtureByType[type])).not.toBeNull();
    }
    expect(hasRepresentationViewer('Image')).toBe(false);
  });

  it('keeps a legacy World v1 on the existing interactive WorldPreview path', () => {
    render(<RepresentationViewer type="World" value={worldV1Fixture} compact />);

    expect(screen.getByTestId('legacy-world-preview')).toHaveAttribute('data-compact', 'true');
    expect(screen.queryByText(/contract v2/i)).not.toBeInTheDocument();
  });

  it('renders World v2 as a provider-neutral structured summary', () => {
    render(<RepresentationViewer type="World" value={worldV2Fixture} />);

    expect(screen.getByText('World · contract v2')).toBeInTheDocument();
    expect(screen.getByText('Provider-neutral studio')).toBeInTheDocument();
    expect(screen.getByText('Point cloud')).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-world-preview')).not.toBeInTheDocument();
  });

  it.each(STRUCTURED_REPRESENTATION_PRIORITY.filter((type) => type !== 'World'))(
    'renders the validated %s fixture without falling back to an invalid card',
    (type) => {
      const { unmount } = render(
        <RepresentationViewer type={type} value={spatialFixtureByType[type]} compact />,
      );

      expect(screen.queryByTestId('representation-invalid')).not.toBeInTheDocument();
      expect(screen.getByRole('region')).toBeInTheDocument();
      unmount();
    },
  );

  it('shows only parser-validated local asset links without fetching them', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { rerender } = render(<RepresentationViewer type="PointCloud" value={pointCloudFixture} />);

    const link = screen.getByRole('link', { name: /point-cloud-asset/i });
    expect(link).toHaveAttribute(
      'href',
      'http://127.0.0.1:8007/api/outputs/mock-spatial/point-cloud.ply',
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender(
      <RepresentationViewer
        type="PointCloud"
        value={{
          ...pointCloudFixture,
          asset: { ...pointCloudFixture.asset, uri: 'https://signed.invalid/private.ply?expires=1' },
        }}
      />,
    );

    expect(screen.getByTestId('representation-invalid')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds malformed output and never renders raw payload data', () => {
    const secret = 'secret-provider-payload-'.repeat(2_000);
    const { container } = render(
      <RepresentationViewer
        type="CameraPose"
        value={{ ...cameraPoseFixture, orientation: [0, 0, 0, 0], secret }}
      />,
    );

    expect(screen.getByText('CameraPose unavailable')).toBeInTheDocument();
    expect(container.textContent).not.toContain('secret-provider-payload');
    expect(container.textContent?.length).toBeLessThan(220);
  });

  it('selects registered structured values deterministically without claiming media types', () => {
    const outputs: Record<string, PortValue> = {
      stream: { type: 'SensorStream', value: spatialFixtureByType.SensorStream as Record<string, unknown> },
      pose: { type: 'CameraPose', value: cameraPoseFixture as unknown as Record<string, unknown> },
      image: { type: 'Image', value: '/api/outputs/mock-spatial/image.png' },
    };

    expect(findStructuredRepresentation(outputs)?.type).toBe('CameraPose');
    expect(findStructuredRepresentation(outputs, { includeWorld: false })?.type).toBe('CameraPose');
  });
});

describe('create output integration', () => {
  it('preserves the established media priority ahead of structured summaries', () => {
    const outputs: Record<string, PortValue> = {
      pose: { type: 'CameraPose', value: cameraPoseFixture as unknown as Record<string, unknown> },
      text: { type: 'Text', value: 'fallback text' },
      image: { type: 'Image', value: '/api/outputs/mock-spatial/image.png' },
      video: { type: 'Video', value: '/api/outputs/mock-spatial/video.mp4' },
    };

    const { container } = render(<OutputRenderer outputs={outputs} state="complete" />);

    expect(container.querySelector('video')).toHaveAttribute('src', '/api/outputs/mock-spatial/video.mp4');
    expect(screen.queryByText('Camera pose')).not.toBeInTheDocument();
    expect(screen.queryByText('fallback text')).not.toBeInTheDocument();
  });

  it('uses the structured viewer before text when no visual media exists', () => {
    const outputs: Record<string, PortValue> = {
      text: { type: 'Text', value: 'secondary caption' },
      pose: { type: 'CameraPose', value: cameraPoseFixture as unknown as Record<string, unknown> },
    };

    render(<OutputRenderer outputs={outputs} state="complete" />);

    expect(screen.getByText('Camera pose')).toBeInTheDocument();
    expect(screen.queryByText('secondary caption')).not.toBeInTheDocument();
  });
});
