import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractPaletteFromImage, paletteFromPixels, paletteNotice } from '../src/lib/paletteExtract';

// Why an image gave no colours (fix/drop-followups, 2026-10-24). GM: "If the
// two cases can't be told apart, use only the heading. Don't guess the reason."

function pixels(...rgba: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat());
}

describe('paletteFromPixels', () => {
  it('finds the colours of opaque pixels', () => {
    const result = paletteFromPixels(pixels([255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255]), 2);
    expect(result).toEqual({ ok: true, colors: ['#ff0000', '#0000ff'] });
  });

  it('says so when every pixel is transparent', () => {
    expect(paletteFromPixels(pixels([10, 20, 30, 0], [0, 0, 0, 0]))).toEqual({ ok: false, reason: 'transparent' });
  });

  it('gives a faint image the same reason as a clear one (GM r5 on #208)', () => {
    // Every pixel under the visibility cut (alpha 16, as the backend), but not all of them clear.
    expect(paletteFromPixels(pixels([10, 20, 30, 15], [0, 0, 0, 0]))).toEqual({ ok: false, reason: 'transparent' });
  });

  it('has no reason for an empty image', () => {
    expect(paletteFromPixels(new Uint8ClampedArray())).toEqual({ ok: false, reason: 'other' });
  });
});

describe('extractPaletteFromImage', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
    vi.unstubAllGlobals();
  });

  it("reports a file the browser can't decode as 'decode'", async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    globalThis.Image = BrokenImage as unknown as typeof Image;
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: () => 'blob:test', revokeObjectURL: () => {},
    }));
    const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'broken.png', { type: 'image/png' }));
    expect(result).toEqual({ ok: false, reason: 'decode' });
  });

  it('reads the canvas as rows of its width, so a 1 px horizontal seam folds as an edge (round 4)', async () => {
    // 40x40: black above (22 rows), white below (17), one grey row between them.
    const w = 40;
    const data = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const v = y < 22 ? 0 : y === 22 ? 128 : 255;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    class LoadedImage {
      width = w;
      height = w;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = LoadedImage as unknown as typeof Image;
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: () => 'blob:test', revokeObjectURL: () => {},
    }));
    const ctx = { drawImage: () => {}, getImageData: () => ({ data }) };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    try {
      const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'seam.png', { type: 'image/png' }));
      expect(result).toEqual({ ok: true, colors: ['#000000', '#ffffff'] });
    } finally {
      getContext.mockRestore();
    }
  });
});

describe('paletteNotice', () => {
  it('puts the reason under the heading for the two known cases', () => {
    expect(paletteNotice('a.png', 'decode')).toBe("Couldn't find colors in “a.png”.\nNebula can't read this image. Try a PNG or JPEG.");
    expect(paletteNotice('a.png', 'transparent')).toBe("Couldn't find colors in “a.png”.\nThis image is too transparent to pull colors from.");
  });

  it('gives the heading alone otherwise', () => {
    expect(paletteNotice('a.png', 'other')).toBe("Couldn't find colors in “a.png”.");
  });
});
