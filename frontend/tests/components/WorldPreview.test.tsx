import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldEnvironmentViewerProps } from '../../src/components/nodes/WorldEnvironmentViewer';

vi.mock('../../src/components/nodes/WorldEnvironmentViewer', () => ({
  WorldEnvironmentViewer: ({ src, navigationMode, resetToken }: WorldEnvironmentViewerProps) => (
    <div
      data-testid="world-environment-viewer"
      data-src={src}
      data-navigation={navigationMode}
      data-reset={resetToken}
    />
  ),
}));

import { WorldPreview } from '../../src/components/nodes/WorldPreview';

const world = {
  schemaVersion: 1,
  provider: 'worldlabs',
  worldId: 'world-123',
  model: 'marble-1.1',
  displayName: 'Moonlit courtyard',
  marbleUrl: 'https://marble.worldlabs.ai/world/world-123',
  promptType: 'text',
  assets: {
    splats: {
      '100k': '/api/outputs/world-100k.spz',
      '500k': '/api/outputs/world-500k.spz',
      full_res: '/api/outputs/world-full.spz',
    },
    panorama: '/api/outputs/panorama.jpg',
    colliderMesh: '/api/outputs/collider.glb',
    thumbnail: '/api/outputs/thumb.jpg',
  },
  semantics: {
    metricScaleFactor: 1,
    groundPlaneOffset: 0,
    coordinateFrame: 'marble_raw_opencv',
  },
  caption: 'A moonlit courtyard',
};

describe('WorldPreview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('stays thumbnail-only until expanded, then defaults desktop to the 500K splat', async () => {
    render(<WorldPreview value={world} />);

    const trigger = screen.getByRole('button', { name: 'Explore 3D world: Moonlit courtyard' });
    expect(screen.queryByTestId('world-environment-viewer')).toBeNull();
    expect(trigger.querySelector('img')).toHaveAttribute('loading', 'lazy');

    fireEvent.click(trigger);
    const viewer = await screen.findByTestId('world-environment-viewer');
    expect(viewer).toHaveAttribute('data-src', '/api/outputs/world-500k.spz');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Marble/i })).toHaveAttribute(
      'href',
      'https://marble.worldlabs.ai/world/world-123',
    );
  });

  it('preserves the viewer across quality and navigation changes, resets explicitly, and closes', async () => {
    render(<WorldPreview value={world} />);
    const trigger = screen.getByRole('button', { name: /Explore 3D world/i });
    trigger.focus();
    fireEvent.click(trigger);

    const viewer = await screen.findByTestId('world-environment-viewer');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const qualityViewer = await screen.findByTestId('world-environment-viewer');
    expect(qualityViewer).toBe(viewer);
    expect(qualityViewer).toHaveAttribute('data-src', '/api/outputs/world-100k.spz');

    fireEvent.click(screen.getByRole('button', { name: /Fly/i }));
    const flyViewer = screen.getByTestId('world-environment-viewer');
    expect(flyViewer).toBe(viewer);
    expect(flyViewer).toHaveAttribute('data-navigation', 'fly');
    expect(screen.getByText(/Use W A S D/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset camera' }));
    expect(viewer).toHaveAttribute('data-reset', '1');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('exposes grouped preview and navigation controls using Nebula control states', async () => {
    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));

    const quality = await screen.findByRole('group', { name: 'Preview quality' });
    const navigation = screen.getByRole('group', { name: 'Navigation mode' });
    expect(quality).toHaveClass('world-modal__segmented', 'world-modal__segmented--quality');
    expect(navigation).toHaveClass('world-modal__segmented');
    expect(screen.getByRole('button', { name: 'Standard' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Orbit/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('traps forward and reverse tab navigation inside the modal', async () => {
    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));

    const dialog = await screen.findByRole('dialog');
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('defaults a narrow touch-style viewport to the 100K preview', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));
    expect(await screen.findByTestId('world-environment-viewer')).toHaveAttribute(
      'data-src',
      '/api/outputs/world-100k.spz',
    );
  });

  it('falls back accessibly when structured World data is invalid', () => {
    render(<WorldPreview value={{ schemaVersion: 2, provider: 'worldlabs' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('World data unavailable');
    expect(screen.queryByRole('button', { name: /Explore 3D world/i })).toBeNull();
  });

  it('does not expose an untrusted Marble URL', async () => {
    render(<WorldPreview value={{ ...world, marbleUrl: 'https://evil.example/phish' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('link', { name: /Open in Marble/i })).toHaveAttribute(
      'href', 'https://marble.worldlabs.ai/world/world-123',
    );
  });

  it('does not render or fetch imported remote World assets', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<WorldPreview value={{
      ...world,
      assets: {
        splats: { '500k': 'http://127.0.0.1:9090/private.spz' },
        thumbnail: 'https://tracker.example/pixel.gif',
        panorama: 'https://tracker.example/panorama.jpg',
      },
    }} />);

    expect(screen.queryByRole('button', { name: /Explore 3D world/i })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('World data unavailable');
    expect(screen.queryByTestId('world-environment-viewer')).toBeNull();
    expect(screen.queryByRole('button', { name: /Panorama/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicit choice before loading full-res or unknown variants', async () => {
    render(<WorldPreview value={{
      ...world,
      assets: {
        splats: {
          full_res: '/api/outputs/world-full.spz',
          'future/v2?quality=max': '/api/outputs/world-future.spz',
        },
      },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));

    expect(await screen.findByText('Choose a preview quality')).toBeInTheDocument();
    expect(screen.queryByTestId('world-environment-viewer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Full' }));
    expect(await screen.findByTestId('world-environment-viewer')).toHaveAttribute(
      'data-src',
      '/api/outputs/world-full.spz',
    );
  });

  it('downloads World assets through fetch-to-Blob instead of a direct download link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([115, 112, 122]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.fn().mockReturnValue('blob:world-download');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));
    await screen.findByRole('dialog');

    const downloadButton = screen.getByRole('button', { name: /Standard SPZ/i });
    expect(screen.queryByRole('link', { name: /Standard SPZ/i })).toBeNull();
    fireEvent.click(downloadButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/outputs/world-500k.spz',
      expect.objectContaining({ cache: 'no-store' }),
    ));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('renders a safe, actionable error when a World asset download fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS detail')));
    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /Panorama/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Download failed. The asset could not be reached.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('CORS detail');
  });

  it('downloads a JPEG panorama with a truthful JPEG filename', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff, 0xd8, 0xff]))));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:panorama'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let downloadedName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function captureDownload() {
      downloadedName = this.download;
    });

    render(<WorldPreview value={world} />);
    fireEvent.click(screen.getByRole('button', { name: /Explore 3D world/i }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Panorama' }));

    await waitFor(() => expect(downloadedName).toBe('moonlit-courtyard-panorama.jpg'));
  });
});
