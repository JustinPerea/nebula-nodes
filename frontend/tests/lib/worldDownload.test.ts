import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadWorldAsset,
  worldImageExtensionFromUrl,
} from '../../src/lib/worldDownload';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('World asset Blob download bounds', () => {
  it('preserves validated panorama image extensions without trusting arbitrary suffixes', () => {
    expect(worldImageExtensionFromUrl('/api/outputs/panorama.jpg?download=1')).toBe('jpg');
    expect(worldImageExtensionFromUrl('/api/outputs/panorama.WEBP')).toBe('webp');
    expect(worldImageExtensionFromUrl('/api/outputs/panorama.svg')).toBe('bin');
    expect(worldImageExtensionFromUrl('/api/outputs/panorama')).toBe('bin');
  });

  it('rejects a declared oversized asset before creating an object URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': '101' },
    })));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    await expect(downloadWorldAsset('/api/outputs/world.spz', 'world.spz', {
      maxBlobBytes: 100,
    })).rejects.toThrow('too large for a safe in-browser download');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects an undeclared oversized stream based on bytes actually read', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    }));
    expect(response.headers.get('content-length')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');

    await expect(downloadWorldAsset('/api/outputs/world.spz', 'world.spz', {
      maxBlobBytes: 3,
    })).rejects.toThrow('too large for a safe in-browser download');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects a remote asset before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadWorldAsset('https://tracker.example/world.spz', 'world.spz'))
      .rejects.toThrow('not safe to download');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
