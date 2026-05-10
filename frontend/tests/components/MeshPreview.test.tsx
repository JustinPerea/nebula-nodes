import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@google/model-viewer', () => ({}));

import { MeshPreview } from '../../src/components/nodes/MeshPreview';

describe('MeshPreview', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back without mounting model-viewer when WebGL is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    render(<MeshPreview src="/mesh.glb" />);

    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('error'));

    expect(preview.querySelector('model-viewer')).toBeNull();
    expect(preview.querySelector('.mesh-preview__placeholder')).not.toBeNull();
  });

  it('falls back when a same-origin mesh URL resolves to HTML', async () => {
    const webglContext = {
      getExtension: vi.fn().mockReturnValue(null),
    } as unknown as WebGLRenderingContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(webglContext);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: vi.fn().mockReturnValue('text/html; charset=utf-8'),
      },
    }));

    render(<MeshPreview src="/missing.glb" />);

    const preview = screen.getByRole('button', { name: /open glb model preview/i });
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('error'));

    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: 'HEAD' }));
    expect(preview.querySelector('model-viewer')).toBeNull();
  });
});
