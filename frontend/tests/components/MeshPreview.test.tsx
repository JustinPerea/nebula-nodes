import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@google/model-viewer', () => ({}));

import { MESH_PREVIEW_MAX_BYTES, MeshPreview } from '../../src/components/nodes/MeshPreview';

describe('MeshPreview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back without mounting model-viewer when WebGL is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    render(<MeshPreview src="/mesh.glb" />);

    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    expect(preview.getAttribute('data-status')).toBe('idle');
    fireEvent.click(preview);
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('error'));

    expect(preview.querySelector('model-viewer')).toBeNull();
    expect(preview.querySelector('.mesh-preview__placeholder')).not.toBeNull();
  });

  it('falls back when a same-origin mesh URL resolves to HTML', async () => {
    const webglContext = {
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(webglContext);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('<html/>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
    vi.stubGlobal('fetch', fetchSpy);

    render(<MeshPreview src="/api/outputs/missing.glb" />);

    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(preview);
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('error'));

    expect(fetch).toHaveBeenCalledWith(
      '/api/outputs/missing.glb',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(preview.querySelector('model-viewer')).toBeNull();
  });

  it('does not fetch or mount a GLB until the user opens the preview', () => {
    const webglContext = {
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(webglContext);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<MeshPreview src="/api/outputs/run/large.glb" />);

    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    expect(preview.getAttribute('data-status')).toBe('idle');
    expect(preview.querySelector('model-viewer')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized GLB before model-viewer can allocate it', async () => {
    const webglContext = {
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(webglContext);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(MESH_PREVIEW_MAX_BYTES + 1),
      },
    })));

    render(<MeshPreview src="/api/outputs/run/huge.glb" />);
    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    fireEvent.click(preview);

    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('error'));
    expect(screen.getByText(/too large for a safe interactive preview/i)).toBeInTheDocument();
    expect(document.querySelector('model-viewer')).toBeNull();
  });

  it('presents PLY output as a valid download-only splat instead of a broken model viewer', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<MeshPreview src="/api/outputs/run/world.ply" />);

    const preview = screen.getByRole('button', { name: /open ply splat export preview/i });
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('file'));
    expect(preview.querySelector('model-viewer')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(preview);
    expect(screen.getByText('Splat export ready to download')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/i })).toBeInTheDocument();
  });

  it('moves focus into the dialog, traps Tab, and restores focus after Escape', async () => {
    render(<MeshPreview src="/api/outputs/run/world.ply" />);

    const trigger = screen.getByRole('button', { name: /open ply splat export preview/i });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close' });
    const download = screen.getByRole('button', { name: 'Download' });
    await waitFor(() => expect(close).toHaveFocus());

    download.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(download).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('disables model auto-rotation when reduced motion is preferred', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const webglContext = {
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(webglContext);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'model/gltf-binary' },
    })));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:mesh-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    render(<MeshPreview src="/api/outputs/run/model.glb" />);
    fireEvent.click(screen.getByRole('button', { name: /open glb model preview/i }));

    await waitFor(() => expect(document.querySelector('model-viewer')).not.toBeNull());
    expect(document.querySelector('model-viewer')).not.toHaveAttribute('auto-rotate');
  });
});
