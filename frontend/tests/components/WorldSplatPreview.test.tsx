import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldEnvironmentViewerProps } from '../../src/components/nodes/WorldEnvironmentViewer';

vi.mock('../../src/components/nodes/WorldEnvironmentViewer', () => ({
  WorldEnvironmentViewer: ({
    src, format, upAxis, forwardAxis, framing, navigationMode, onStatusChange, onFailure, quietFallback,
  }: WorldEnvironmentViewerProps) => (
    <div
      data-testid="world-environment-viewer"
      data-src={src}
      data-format={format}
      data-up={upAxis}
      data-forward={forwardAxis}
      data-framing={framing}
      data-navigation={navigationMode}
      data-quiet={quietFallback ? 'true' : 'false'}
    >
      <button type="button" onClick={() => onStatusChange?.('ready')}>mock ready</button>
      {(['missing', 'format', 'too-large'] as const).map((failure) => (
        <button
          key={failure}
          type="button"
          onClick={() => { onStatusChange?.('error'); onFailure?.(failure); }}
        >
          {`mock ${failure}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../../src/lib/backend', () => ({
  backendAssetUrlSync: (value: string) => value,
}));

import { RepresentationViewer } from '../../src/components/nodes/RepresentationViewer';
import {
  IDOL_SPLAT_GONE_LINE, SPLAT_DAMAGED_LINE, SPLAT_ORBIT_HINT, SPLAT_TOO_LARGE_LINE,
} from '../../src/components/nodes/WorldSplatPreview';

/** A World v2 value the way the Idol handler writes it (handlers/speridlabs_idol.py world_value). */
const idolWorld = {
  schemaVersion: 2,
  kind: 'world',
  id: 'idol-0123456789ab',
  displayName: 'Idol object',
  coordinateSystem: {
    schemaVersion: 1, kind: 'coordinate-system', id: 'idol-object', handedness: 'right', upAxis: '-y',
    forwardAxis: 'x', unit: 'custom', metersPerUnit: 1, originMeters: [0, 0, 0],
  },
  session: {
    schemaVersion: 1, kind: 'spatial-session', id: 'idol-0123456789ab', source: 'generated', createdAtMs: 1,
    provider: 'speridlabs', model: 'idol', label: 'Idol object',
    tags: ['seed:42', 'gaussians:262144', 'mode:synthetic', 'steps:50'],
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
    expect(viewer).toHaveAttribute('data-forward', 'x');
    expect(viewer).toHaveAttribute('data-framing', 'object');
    // Orbit only: Fly is for World Labs scenes (GM, PR #203 r1).
    expect(viewer).toHaveAttribute('data-navigation', 'orbit');
    expect(screen.queryByRole('button', { name: 'Fly' })).not.toBeInTheDocument();
    const status = within(dialog).getByRole('status');
    expect(status).toHaveTextContent(/^Loading$/);
    expect(dialog).toHaveTextContent(SPLAT_ORBIT_HINT);
    expect(within(dialog).getByRole('button', { name: 'Download splat' })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/-Y UP|contract|application\/octet-stream/i);

    fireEvent.click(screen.getByRole('button', { name: 'mock ready' }));
    expect(status).toHaveTextContent(/^262,144 Gaussians · PLY$/);
    // No raw "ready" or "error" anywhere outside the mock's own buttons.
    expect(within(dialog).getByRole('group', { name: '3D viewer controls' })).not.toHaveTextContent(/ready|error/i);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('reads like the World v1 card: kind, name, maker, Explore and "Splat · PLY"', async () => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore in 3D: Idol object' })).toBeEnabled());
    const card = screen.getByRole('region');
    expect(card).toHaveTextContent('World');
    expect(card).toHaveTextContent('Idol object');
    expect(card).toHaveTextContent('Idol · Speridlabs');
    expect(within(card).getByRole('link', { name: /Splat · PLY/ })).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/contract|right-handed|-y up|generated|application\/octet-stream|Local assets/i);
  });

  it.each([
    ['format', SPLAT_DAMAGED_LINE, true],
    ['too-large', SPLAT_TOO_LARGE_LINE, true],
    ['missing', IDOL_SPLAT_GONE_LINE, false],
  ] as const)('a %s failure shows its line in the status, hides the help, and offers a download only if the file exists', async (
    failure, line, downloadable,
  ) => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore in 3D: Idol object' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Explore in 3D: Idol object' }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    await screen.findByTestId('world-environment-viewer');
    expect(screen.getByTestId('world-environment-viewer')).toHaveAttribute('data-quiet', 'true');
    fireEvent.click(screen.getByRole('button', { name: `mock ${failure}` }));
    const status = within(dialog).getByRole('status');
    expect(status).toHaveTextContent(line);
    expect(status).toHaveAttribute('data-splat-failure', failure);
    expect(dialog).not.toHaveTextContent(SPLAT_ORBIT_HINT);
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(within(dialog).getByRole('button', { name: 'Reset camera' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Download splat' }) !== null).toBe(downloadable);
  });

  it('keeps Tab inside the dialog, including from outside it', async () => {
    render(<><button type="button">behind</button><RepresentationViewer type="World" value={idolWorld} /></>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore in 3D: Idol object' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Explore in 3D: Idol object' }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    await screen.findByTestId('world-environment-viewer');
    const close = within(dialog).getByRole('button', { name: 'Close 3D viewer' });
    await waitFor(() => expect(close).toHaveFocus());
    const download = within(dialog).getByRole('button', { name: 'Download splat' });
    download.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    // Focus that fell out (a button that disabled itself) comes back in on Tab.
    screen.getByRole('button', { name: 'behind' }).focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
  });

  it('shows no button for a World v2 value without a safe splat', async () => {
    const remote = { ...idolWorld, assets: { splats: [{ ...idolWorld.assets.splats[0],
      asset: { ...idolWorld.assets.splats[0].asset, uri: 'https://example.com/idol.ply' } }] } };
    render(<RepresentationViewer type="World" value={remote} />);
    // The remote URL fails the World v2 parse or the preview's own check: either way, no button.
    expect(screen.queryByRole('button', { name: /Explore in 3D/ })).not.toBeInTheDocument();
  });
});
