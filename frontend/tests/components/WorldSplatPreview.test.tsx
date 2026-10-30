import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldEnvironmentViewerProps } from '../../src/components/nodes/WorldEnvironmentViewer';

vi.mock('../../src/components/nodes/WorldEnvironmentViewer', () => ({
  WorldEnvironmentViewer: ({ src, format, upAxis, forwardAxis, framing, navigationMode }: WorldEnvironmentViewerProps) => (
    <div
      data-testid="world-environment-viewer"
      data-src={src}
      data-format={format}
      data-up={upAxis}
      data-forward={forwardAxis}
      data-framing={framing}
      data-navigation={navigationMode}
    />
  ),
}));

vi.mock('../../src/lib/backend', () => ({
  backendAssetUrlSync: (value: string) => value,
}));

import { RepresentationViewer } from '../../src/components/nodes/RepresentationViewer';

/** A World v2 value the way the Idol handler writes it (handlers/speridlabs_idol.py world_value). */
const idolWorld = {
  schemaVersion: 2,
  kind: 'world',
  id: 'idol-0123456789ab',
  displayName: 'Idol object',
  coordinateSystem: {
    schemaVersion: 1, kind: 'coordinate-system', id: 'idol-object', handedness: 'right', upAxis: '-y',
    forwardAxis: 'z', unit: 'custom', metersPerUnit: 1, originMeters: [0, 0, 0],
  },
  session: {
    schemaVersion: 1, kind: 'spatial-session', id: 'idol-0123456789ab', source: 'generated', createdAtMs: 1,
    provider: 'speridlabs', model: 'idol', label: 'Idol object',
    tags: ['seed:42', 'gaussians:262144', 'mode:Synthetic', 'steps:50'],
  },
  assets: {
    splats: [{
      id: 'splat', format: 'ply', pointCount: 262144,
      asset: { id: 'splat-ply', uri: '/api/outputs/run/idol-seed42-262144.ply', mediaType: 'application/octet-stream',
        byteLength: 17_826_208 },
    }],
  },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('World v2 splat preview', () => {
  it('mounts an Explore button on the card and opens the viewer on the PLY, turned and framed as an object', async () => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    // The button's chunk is deferred (lib/deferredChunks.ts): its placeholder
    // (disabled, same name) shows until the chunk arrives.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore in 3D: Idol object' }))
      .toHaveAttribute('data-splat-format', 'ply'));
    const open = screen.getByRole('button', { name: 'Explore in 3D: Idol object' });
    expect(open).toBeEnabled();
    expect(screen.queryByTestId('world-environment-viewer')).not.toBeInTheDocument();

    open.focus(); // a real click focuses the button; fireEvent.click doesn't
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    expect(dialog).toHaveTextContent('Idol · Speridlabs');
    const viewer = await screen.findByTestId('world-environment-viewer');
    expect(viewer).toHaveAttribute('data-src', '/api/outputs/run/idol-seed42-262144.ply');
    expect(viewer).toHaveAttribute('data-format', 'ply');
    expect(viewer).toHaveAttribute('data-up', '-y');
    expect(viewer).toHaveAttribute('data-forward', 'z');
    expect(viewer).toHaveAttribute('data-framing', 'object');
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('262,144 Gaussians · PLY · loading');
    expect(screen.getByRole('button', { name: /Splat PLY/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fly' }));
    expect(screen.getByTestId('world-environment-viewer')).toHaveAttribute('data-navigation', 'fly');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('shows no button for a World v2 value without a safe splat', async () => {
    const remote = { ...idolWorld, assets: { splats: [{ ...idolWorld.assets.splats[0],
      asset: { ...idolWorld.assets.splats[0].asset, uri: 'https://example.com/idol.ply' } }] } };
    render(<RepresentationViewer type="World" value={remote} />);
    // The remote URL fails the World v2 parse or the preview's own check: either way, no button.
    expect(screen.queryByRole('button', { name: /Explore in 3D/ })).not.toBeInTheDocument();
  });
});
