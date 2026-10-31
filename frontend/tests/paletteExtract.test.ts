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

  it("doesn't call a faint image fully transparent", () => {
    // Every pixel under the visibility cut (alpha 16, as the backend), but not all of them clear.
    expect(paletteFromPixels(pixels([10, 20, 30, 15], [0, 0, 0, 0]))).toEqual({ ok: false, reason: 'other' });
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
});

describe('paletteNotice', () => {
  it('puts the reason under the heading for the two known cases', () => {
    expect(paletteNotice('a.png', 'decode')).toBe("Couldn't find colors in “a.png”.\nNebula can't read this image. Try a PNG or JPEG.");
    expect(paletteNotice('a.png', 'transparent')).toBe("Couldn't find colors in “a.png”.\nThe image is fully transparent.");
  });

  it('gives the heading alone otherwise', () => {
    expect(paletteNotice('a.png', 'other')).toBe("Couldn't find colors in “a.png”.");
  });
});
