// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BITMAP_OPTIONS, offscreenReadsSame, readPaletteJobOffscreen } from '../src/lib/paletteExtract';

// Round 8c (GM r18 5): the worker reads the picked file with
// createImageBitmap and an OffscreenCanvas, for the formats where Chrome
// gives the page's pixels byte for byte (measured: notes, round 8c).

const png = (depth: number) => {
  const head = new Uint8Array(32);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  head[24] = depth;
  return head;
};
const ascii = (text: string) => {
  const head = new Uint8Array(32);
  head.set([...text].map((c) => c.charCodeAt(0)));
  return head;
};

describe('which files the worker reads (offscreenReadsSame)', () => {
  it('reads PNG up to 8 bits a channel, GIF and BMP', () => {
    for (const depth of [1, 2, 4, 8]) expect(offscreenReadsSame(png(depth))).toBe(true);
    expect(offscreenReadsSame(ascii('GIF89a'))).toBe(true);
    expect(offscreenReadsSame(ascii('GIF87a'))).toBe(true);
    expect(offscreenReadsSame(ascii('BM'))).toBe(true);
  });

  it('leaves 16-bit PNG, JPEG, WebP, AVIF, SVG and anything else to the page', () => {
    expect(offscreenReadsSame(png(16))).toBe(false);
    const jpeg = new Uint8Array(32);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    expect(offscreenReadsSame(jpeg)).toBe(false);
    expect(offscreenReadsSame(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe(false);
    expect(offscreenReadsSame(ascii('\0\0\0\x1cftypavif'))).toBe(false);
    expect(offscreenReadsSame(ascii('<svg xmlns='))).toBe(false);
    expect(offscreenReadsSame(new Uint8Array(0))).toBe(false);
    // A PNG signature without IHDR first isn't trusted.
    const odd = png(8);
    odd.set(ascii('IDAT').subarray(0, 4), 12);
    expect(offscreenReadsSame(odd)).toBe(false);
  });
});

describe('the worker read (readPaletteJobOffscreen)', () => {
  const draws: { w: number; h: number; options: unknown; read: unknown }[] = [];
  let bitmapOptions: unknown = null;
  let closed = 0;
  function stub(width: number, height: number) {
    vi.stubGlobal('createImageBitmap', async (_file: Blob, options: unknown) => {
      bitmapOptions = options;
      return { width, height, close: () => { closed++; } };
    });
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(public width: number, public height: number) {}
      getContext(_kind: string, options: unknown) {
        const entry = { w: this.width, h: this.height, options, read: null as unknown };
        return {
          drawImage: () => draws.push(entry),
          getImageData: (_x: number, _y: number, w: number, h: number, read: unknown) => {
            entry.read = read;
            const data = new Uint8ClampedArray(w * h * 4).fill(draws.length);
            return { data };
          },
        };
      }
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    draws.length = 0;
    bitmapOptions = null;
    closed = 0;
  });
  const file = (head: Uint8Array) => new Blob([head]);

  it("reads as the page does: orientation, colour and alpha set out, sRGB, the 96 px first", async () => {
    stub(1000, 600);
    const job = await readPaletteJobOffscreen(file(png(8)), 6);
    expect(bitmapOptions).toEqual({ imageOrientation: 'from-image', colorSpaceConversion: 'default', premultiplyAlpha: 'default' });
    expect(BITMAP_OPTIONS).toEqual(bitmapOptions);
    expect(draws.map(({ w, h }) => [w, h])).toEqual([[96, 58], [1000, 600]]);
    for (const draw of draws) {
      expect(draw.options).toEqual({ colorSpace: 'srgb' });
      expect(draw.read).toEqual({ colorSpace: 'srgb' });
    }
    expect(job).toMatchObject({ width: 1000, height: 600, k: 6, small: { width: 96 } });
    expect(job!.small.data[0]).toBe(1);
    expect(job!.data[0]).toBe(2);
    expect(closed).toBe(1);
  });

  it('reads a small image once, as its own downscale, and an 8K one at 4096', async () => {
    stub(80, 40);
    const small = await readPaletteJobOffscreen(file(png(8)));
    expect(draws).toHaveLength(1);
    expect(small!.small.data).toBe(small!.data);
    draws.length = 0;
    stub(7680, 4320);
    const big = await readPaletteJobOffscreen(file(png(8)));
    expect(draws.map(({ w, h }) => [w, h])).toEqual([[96, 54], [4096, 2304]]);
    expect(big).toMatchObject({ width: 4096, height: 2304 });
  });

  it('gives null (the page reads it) for a file it does not read the same, one it cannot decode, or no OffscreenCanvas', async () => {
    stub(100, 100);
    const jpeg = new Uint8Array(32);
    jpeg.set([0xff, 0xd8, 0xff]);
    expect(await readPaletteJobOffscreen(file(jpeg))).toBeNull();
    expect(bitmapOptions).toBeNull();
    vi.stubGlobal('createImageBitmap', async () => { throw new DOMException('bad', 'InvalidStateError'); });
    expect(await readPaletteJobOffscreen(file(png(8)))).toBeNull();
    vi.unstubAllGlobals();
    expect(await readPaletteJobOffscreen(file(png(8)))).toBeNull();
  });
});
