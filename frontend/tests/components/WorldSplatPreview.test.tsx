import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldEnvironmentViewerProps } from '../../src/components/nodes/WorldEnvironmentViewer';

// Each mount is one fetch of the file: Try again must remount (refetch).
const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../src/components/nodes/WorldEnvironmentViewer', async () => {
  const { useEffect } = await import('react');
  return { WorldEnvironmentViewer: function MockViewer({
    src, format, upAxis, forwardAxis, framing, navigationMode, onStatusChange, onFailure, quietFallback,
  }: WorldEnvironmentViewerProps) {
    useEffect(() => { mounts.count += 1; }, []);
    return (
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
      {(['missing', 'format', 'too-large', 'webgl', 'load', 'other'] as const).map((failure) => (
        <button
          key={failure}
          type="button"
          onClick={() => { onStatusChange?.('error'); onFailure?.(failure); }}
        >
          {`mock ${failure}`}
        </button>
      ))}
    </div>
    );
  } };
});

vi.mock('../../src/lib/backend', () => ({
  backendAssetUrlSync: (value: string) => value,
}));

import { RepresentationViewer } from '../../src/components/nodes/RepresentationViewer';
import {
  IDOL_SPLAT_GONE_LINE, SPLAT_DAMAGED_LINE, SPLAT_GONE_LINE, SPLAT_LOAD_LINE, SPLAT_NO_WEBGL_LINE, SPLAT_ORBIT_HINT,
  SPLAT_TOO_LARGE_LINE,
} from '../../src/components/nodes/WorldSplatPreview';

const EXPLORE = 'Explore “Idol object” in 3D';

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
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE }))
      .toHaveAttribute('data-splat-format', 'ply'));
    const open = screen.getByRole('button', { name: EXPLORE });
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
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    const card = screen.getByRole('region');
    expect(card).toHaveTextContent('World');
    expect(card).toHaveTextContent('Idol object');
    expect(card).toHaveTextContent('Idol · Speridlabs');
    expect(within(card).getByRole('link', { name: /Splat · PLY/ })).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/contract|right-handed|-y up|generated|application\/octet-stream|Local assets/i);
  });

  it.each([
    ['format', SPLAT_DAMAGED_LINE, true],
    ['other', SPLAT_DAMAGED_LINE, true],
    ['too-large', SPLAT_TOO_LARGE_LINE, true],
    ['missing', IDOL_SPLAT_GONE_LINE, false],
    ['webgl', SPLAT_NO_WEBGL_LINE, true],
    ['load', SPLAT_LOAD_LINE, false],
  ] as const)('a %s failure: its line alone, centred in the stage; status empty, no reset; a download only where GM keeps one', async (
    failure, line, downloadable,
  ) => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    await screen.findByTestId('world-environment-viewer');
    expect(screen.getByTestId('world-environment-viewer')).toHaveAttribute('data-quiet', 'true');
    fireEvent.click(screen.getByRole('button', { name: `mock ${failure}` }));
    const stage = dialog.querySelector('.world-modal__stage') as HTMLElement;
    const message = within(stage).getByRole('alert');
    expect(message).toHaveClass('world-modal__failure');
    expect(message).toHaveAttribute('data-splat-failure', failure);
    expect(message.querySelector('p')).toHaveTextContent(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    // The specific line replaces the generic one, never both (GM r2).
    expect(dialog).not.toHaveTextContent('Interactive preview unavailable');
    expect(within(dialog).getByRole('status')).toBeEmptyDOMElement();
    expect(dialog).not.toHaveTextContent(SPLAT_ORBIT_HINT);
    expect(dialog).toHaveAttribute('aria-describedby', message.querySelector('p')!.id);
    expect(within(dialog).queryByRole('button', { name: 'Reset camera' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Download splat' }) !== null).toBe(downloadable);
    expect(within(dialog).queryByRole('button', { name: 'Try again' }) !== null).toBe(failure === 'load');
  });

  it('names another node\'s gone splat without Idol (GM r3, k)', async () => {
    const other = { ...idolWorld, session: { ...idolWorld.session, model: 'other-model' } };
    render(<RepresentationViewer type="World" value={other} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    fireEvent.click(await screen.findByRole('button', { name: 'mock missing' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(SPLAT_GONE_LINE);
    expect(dialog).not.toHaveTextContent(IDOL_SPLAT_GONE_LINE);
  });

  it('Try again fetches the splat again and recovers, focus kept in the dialog', async () => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    await screen.findByTestId('world-environment-viewer');
    const before = mounts.count;
    fireEvent.click(screen.getByRole('button', { name: 'mock load' }));
    const retry = within(dialog).getByRole('button', { name: 'Try again' });
    retry.focus();
    fireEvent.click(retry);
    // A new viewer (a new fetch), back to loading, with nothing left of the failure.
    await waitFor(() => expect(mounts.count).toBe(before + 1));
    expect(dialog).toHaveFocus();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent(/^Loading$/);
    fireEvent.click(screen.getByRole('button', { name: 'mock ready' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent(/^262,144 Gaussians · PLY$/);
    expect(within(dialog).getByRole('button', { name: 'Reset camera' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download splat' })).toBeInTheDocument();
  });

  it('names nothing but the download button itself in its footer (GM r3: no "Splat download" label)', async () => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    expect(within(dialog).queryByRole('group', { name: 'Splat download' })).not.toBeInTheDocument();
    expect(dialog.querySelector('[aria-label="Splat download"]')).toBeNull();
  });

  it('Tab from the dialog itself goes to the first control, Shift+Tab to the last (review MEDIUM 1)', async () => {
    render(<RepresentationViewer type="World" value={idolWorld} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
    const dialog = await screen.findByRole('dialog', { name: 'Idol object' });
    await screen.findByTestId('world-environment-viewer');
    const close = within(dialog).getByRole('button', { name: 'Close 3D viewer' });
    const download = within(dialog).getByRole('button', { name: 'Download splat' });
    dialog.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    dialog.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();
  });

  it('keeps Tab inside the dialog, including from outside it', async () => {
    render(<><button type="button">behind</button><RepresentationViewer type="World" value={idolWorld} /></>);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: EXPLORE }));
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

  it.each([
    ['a collider', { colliderMesh: { id: 'collider', uri: '/api/outputs/run/collider.glb', mediaType: 'model/gltf-binary' } }],
    ['a panorama', { panorama: { id: 'pano', uri: '/api/outputs/run/pano.png', mediaType: 'image/png' } }],
  ])('keeps the full summary for a splat with %s, the maker spelled as the maker does (review LOW 4, M4)', async (
    _name, extra,
  ) => {
    const richer = { ...idolWorld, assets: { ...idolWorld.assets, ...extra } };
    render(<RepresentationViewer type="World" value={richer} />);
    await waitFor(() => expect(screen.getByRole('button', { name: EXPLORE })).toBeEnabled());
    const card = screen.getByRole('region');
    expect(card).toHaveTextContent('World · contract v2');
    expect(card).toHaveTextContent('Representations');
    expect(card).toHaveTextContent('Speridlabs');
    expect(card).not.toHaveTextContent(/speridlabs/);
  });

  it('shows no button for a World v2 value without a safe splat', async () => {
    const remote = { ...idolWorld, assets: { splats: [{ ...idolWorld.assets.splats[0],
      asset: { ...idolWorld.assets.splats[0].asset, uri: 'https://example.com/idol.ply' } }] } };
    render(<RepresentationViewer type="World" value={remote} />);
    // The remote URL fails the World v2 parse or the preview's own check: either way, no button.
    expect(screen.queryByRole('button', { name: /Explore in 3D/ })).not.toBeInTheDocument();
  });
});
