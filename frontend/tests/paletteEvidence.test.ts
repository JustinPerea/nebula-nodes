import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  areaGrid,
  deltaE00,
  EDGE_REACH,
  type EdgeEvidence,
  EVIDENCE_MAX_DIM,
  extractPaletteFromImage,
  gridFromRgba,
  mergeNearColors,
  MERGE_DELTA_E,
  paletteFromImageData,
  paletteFromPixels,
  READ_MAX_DIM,
} from '../src/lib/paletteExtract';

// PR #208 round 6: review 4 (colour-maths L1, L2, N3, L4; surfaces M3) and
// GM r10. The palette clusters stay at 96 px; the edge evidence is read at
// 256 px; a run of blends between two colours is one band; an image with
// transparency is reduced alpha-weighted, never by the canvas.
//
// Fixtures (tests/fixtures/palette/<name>-<w>x<h>.rgba, straight RGBA): the
// reviewers' probe sources, built again below at full size, scaled to 96 px
// with PIL BILINEAR as the 29 real images are (the browser's own downscale
// of an opaque image stands in the same place). mark74 is the PR's 74%-clear
// mark at its own 182 px, as Chrome's getImageData gives it (its alpha is 0
// or 255, so the colour comes back straight; clear pixels read as 0,0,0,0).

type Px = [number, number, number, number];

function fixture(name: string): Uint8ClampedArray {
  return new Uint8ClampedArray(readFileSync(resolve(__dirname, `fixtures/palette/${name}.rgba`)));
}

function image(w: number, h: number, at: (x: number, y: number) => Px | number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4);
  return data;
}

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function colors(result: ReturnType<typeof paletteFromPixels>): string[] {
  if (!result.ok) throw new Error(result.reason);
  return result.colors;
}

function noNearPair(hexes: string[]) {
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) expect(deltaE00(hexRgb(hexes[i]), hexRgb(hexes[j]))).toBeGreaterThanOrEqual(MERGE_DELTA_E);
  }
}

// The reviewers' sources (probes/stripes.py, frames.py), 1000 px wide: two
// halves with a solid divider of `t` px, centred on x = 500.
const RED = [220, 20, 40];
const BLUE = [20, 40, 200];
const PURPLE = [120, 30, 120];
function divided(t: number, left: number[], right: number[], mid: number[]): Uint8ClampedArray {
  const lo = 500 - Math.floor(t / 2);
  const hi = 500 + t - Math.floor(t / 2);
  return image(1000, 600, (x) => [...(x >= lo && x < hi ? mid : x < 500 ? left : right), 255]);
}
// A 1000 px black square with a white card and a solid grey frame `border` px wide.
function framed(border: number): Uint8ClampedArray {
  return image(1000, 1000, (x, y) => {
    const inFrame = x >= 300 - border && x < 700 + border && y >= 300 - border && y < 700 + border;
    const inCard = x >= 300 && x < 700 && y >= 300 && y < 700;
    return inCard ? [255, 255, 255, 255] : inFrame ? [128, 128, 128, 255] : [0, 0, 0, 255];
  });
}
// numpy's rint: half to even.
const rint = (v: number) => (Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v));

describe('one band (GM r10, review 4 L1)', () => {
  it('gives the 2.4 px stripe one band: a red and blue flag with a 25 px purple divider shows three, not six', () => {
    const small = fixture('flag-purple-25px-of-1000-96x58');
    // Round 5 read these four 96 px blend columns as four swatches.
    const out = colors(paletteFromImageData(divided(25, RED, BLUE, PURPLE), 1000, 600, 6, { data: small, width: 96 }));
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).sort()).toEqual(['#1428c8', '#dc1428']);
    // The band's colour is read on its 256 px pixels: the divider's purple.
    expect(deltaE00(hexRgb(out[2]), PURPLE)).toBeLessThan(5);
    noNearPair(out);
    // At 96 px alone the run is one band too.
    expect(colors(paletteFromPixels(small, 6, 96))).toHaveLength(3);
  });

  it('gives the grey divider between black and white one band', () => {
    const out = colors(paletteFromImageData(divided(25, [0, 0, 0], [255, 255, 255], [128, 128, 128]), 1000, 600, 6, {
      data: fixture('bw-grey-25px-of-1000-96x58'), width: 96,
    }));
    expect(out).toHaveLength(3);
    // #8e8e8e: its 256 px pixels hold the divider's partly white edge cells.
    expect(deltaE00(hexRgb(out[2]), [128, 128, 128])).toBeLessThan(6);
  });

  it('folds a band that is all edge: a 2 px ramp of two blends between orange and blue', () => {
    const blue = [30, 90, 220];
    const orange = [232, 89, 60];
    const mix = (t: number) => blue.map((v, i) => Math.round(v + (orange[i] - v) * t));
    const out = colors(paletteFromPixels(image(96, 96, (x) => [...(x === 47 ? mix(0.33) : x === 48 ? mix(0.67) : x < 47 ? blue : orange), 255]), 6, 96));
    expect(out.sort()).toEqual(['#1e5adc', '#e8593c']);
  });

  it('keeps two accents on one line apart when they do not touch', () => {
    // Red and blue halves; a pink square on the red side and a violet one on
    // the blue side, both on the red-blue line, each solid (4% of the image).
    const pink = [170, 25, 80];
    const violet = [70, 35, 160];
    const out = colors(paletteFromPixels(image(100, 100, (x, y) => {
      if (y >= 10 && y < 30 && x >= 10 && x < 30) return [...pink, 255];
      if (y >= 60 && y < 80 && x >= 70 && x < 90) return [...violet, 255];
      return [...(x < 50 ? RED : BLUE), 255];
    }), 6, 100));
    expect(out).toHaveLength(4);
    expect(out).toContain('#aa1950');
    expect(out).toContain('#4623a0');
  });

  it('makes touching swatches on one line one band, at their weighted centre, as GM ruled', () => {
    // Two solid stripes side by side between red and blue: one run, one band.
    const pink = [170, 25, 80];
    const violet = [70, 35, 160];
    const out = colors(paletteFromPixels(image(100, 100, (x, y) => {
      if (y < 4) return [...(x < 50 ? pink : violet), 255];
      return [...(x < 50 ? RED : BLUE), 255];
    }), 6, 100));
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('#781e78');
  });
});

describe('how a run becomes a band (GM r10)', () => {
  // Stub evidence: s1 and s2 touch; a single swatch is never an edge, the
  // band of both is all edge (and has no pixels to colour it by).
  const bandIsEdge: EdgeEvidence = {
    edge: (swatch) => (swatch.length >= 2 ? 1 : 0),
    touching: () => true,
  };

  it('folds the band into the nearer colour, even when the band is over 5% and its parts under', () => {
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 50 },
      { rgb: [255, 255, 255], weight: 40 },
      { rgb: [64, 64, 64], weight: 3 },
      { rgb: [90, 90, 90], weight: 3 },
    ], MERGE_DELTA_E, bandIsEdge);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([[[0, 0, 0], 56], [[255, 255, 255], 40]]);
  });

  it('reads only lines between two main colours before the runs: a blend between a run and a main colour waits for its run', () => {
    // s2 is an edge between s1 and white (stub), but s1 is under 5%: s2 waits,
    // and s1 and s2 are one band at their weighted centre, kept (no edge
    // between black and white).
    const evidence: EdgeEvidence = {
      edge: (swatch, a, b) => (swatch.length === 1 && swatch[0] === 3 && [...a, ...b].sort().join() === '1,2' ? 1 : 0),
      touching: () => true,
    };
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 50, members: [0] },
      { rgb: [255, 255, 255], weight: 45, members: [1] },
      { rgb: [100, 100, 100], weight: 3, members: [2] },
      { rgb: [180, 180, 180], weight: 2, members: [3] },
    ], MERGE_DELTA_E, evidence);
    expect(out.map((c) => c.weight)).toEqual([50, 45, 5]);
    expect(out[2].rgb).toEqual([132, 132, 132]);
  });
});

describe('the evidence is read at 256 px (GM r10, review 4 L2)', () => {
  it('reads at up to 256 px, folding bands up to 2 px wide there', () => {
    expect(EVIDENCE_MAX_DIM).toBe(256);
    expect(EDGE_REACH).toBe(2);
  });

  it('keeps a 20 px keyline on a 1000 px image: about 5 px at 256, with an interior', () => {
    const small = fixture('frame-grey-20px-of-1000-96x96');
    const out = colors(paletteFromImageData(framed(20), 1000, 1000, 6, { data: small, width: 96 }));
    // Round 5 read the evidence on the 96 px frame, 2 px wide, every pixel
    // next to both, and folded it: ['#000000', '#fefefe'].
    expect(out).toEqual(['#000000', '#fefefe', '#808080']);
  });

  it('keeps the frame on an image with transparency too, reduced by area', () => {
    const data = framed(20);
    for (let i = 0; i < 1000 * 40 * 4; i += 4) data[i + 3] = 0; // the top 40 rows clear
    const out = colors(paletteFromImageData(data, 1000, 1000));
    expect(out).toHaveLength(3);
    expect(out).toContain('#808080');
  });
});

describe('soft edges and seams (GM r10, review 4 N3)', () => {
  it('folds a 1 px antialiased seam on a 1000 px image', () => {
    const seam = image(1000, 600, (x) => (x === 500 ? [128, 128, 128, 255] : x < 500 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(colors(paletteFromImageData(seam, 1000, 600, 6, { data: fixture('seam-1px-of-1000-96x58'), width: 96 }))).toEqual(['#000000', '#ffffff']);
    // And by area, as for an image with transparency.
    expect(colors(paletteFromImageData(seam, 1000, 600))).toEqual(['#ffffff', '#000000']);
  });

  it('keeps the mid-tone of a soft edge 6 px wide at 96 (16 at 256)', () => {
    const ramp = image(960, 600, (x) => {
      const v = rint(Math.min(1, Math.max(0, (x - 450) / 60)) * 255);
      return [v, v, v, 255];
    });
    const out = colors(paletteFromImageData(ramp, 960, 600, 6, { data: fixture('ramp-60px-of-960-96x60'), width: 96 }));
    expect(out).toHaveLength(3);
    const [, , mid] = out.map(hexRgb);
    expect(mid[0]).toBeGreaterThan(64);
    expect(mid[0]).toBeLessThan(192);
  });

  it('cuts between 2 and 3 px at 256: 1 and 2 px bands fold, 3 px keeps (a 240 px image, read as is)', () => {
    const band = (w: number) => image(240, 240, (_, y) => (y < 118 ? [0, 0, 0, 255] : y < 118 + w ? [128, 128, 128, 255] : [255, 255, 255, 255]));
    expect(colors(paletteFromImageData(band(1), 240, 240))).toHaveLength(2);
    expect(colors(paletteFromImageData(band(2), 240, 240))).toHaveLength(2);
    expect(colors(paletteFromImageData(band(3), 240, 240))).toEqual(['#000000', '#ffffff', '#808080']);
  });
});

describe('an image with transparency is reduced alpha-weighted (review 4, M3)', () => {
  it("gives the 74%-clear mark its two colours, as the board's palette does", () => {
    const out = colors(paletteFromImageData(fixture('mark74-182x182'), 182, 182));
    expect(out).toEqual(['#111413', '#e8593c']);
  });

  it('reduces as the backend does: alpha-weighted means, weights the coverage, pixels under ALPHA_MIN out', () => {
    // 4 x 2 to 2 x 1: block 1 is two red pixels at alpha 255 and 85, one at
    // alpha 15 (out) and one clear; block 2 is clear.
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 0, 255, 85, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 255, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const grid = areaGrid(data, 4, 2, 2);
    expect(grid.width).toBe(2);
    expect([...grid.rgb.slice(0, 3)]).toEqual([191, 0, 64]);
    expect(grid.weight[0]).toBeCloseTo(340 / (4 * 255));
    expect(grid.weight[1]).toBe(0);
    // With nothing to reduce it is the pixels as they are, wherever one counts.
    const one = areaGrid(data, 4, 2, 4);
    const plain = gridFromRgba(data, 4);
    expect([...one.weight]).toEqual([...plain.weight]);
    for (let n = 0; n < 8; n++) {
      if (plain.weight[n] > 0) expect([...one.rgb.slice(n * 3, n * 3 + 3)]).toEqual([...plain.rgb.slice(n * 3, n * 3 + 3)]);
    }
  });

  it('keeps a block with one seen pixel: nothing seen at full size is lost', () => {
    const data = new Uint8ClampedArray(10 * 10 * 4);
    data.set([200, 40, 40, 255], (5 * 10 + 5) * 4);
    const grid = areaGrid(data, 10, 10, 1);
    expect(grid.weight[0]).toBeCloseTo(1 / 100);
    expect(colors(paletteFromImageData(data, 10, 10))).toEqual(['#c82828']);
  });
});

describe('extractPaletteFromImage reads the picked image whole (review 4, M3)', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubImage(width: number, height: number) {
    class LoadedImage {
      width = width;
      height = height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    globalThis.Image = LoadedImage as unknown as typeof Image;
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }));
  }

  function stubCanvas(pixels: (w: number, h: number) => Uint8ClampedArray) {
    const drawn: number[][] = [];
    const ctx = {
      drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => { drawn.push([x, y, w, h]); },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: pixels(w, h) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    return drawn;
  }

  it('clusters an image with transparency on its own pixels, never on the canvas downscale', async () => {
    stubImage(182, 182);
    const mark = fixture('mark74-182x182');
    // The canvas's 96 px downscale of the mark: what round 5 clustered, with
    // its premultiplied faint blocks. It must not be what Extract reads.
    const blurred = image(96, 96, () => [15, 25, 15, 40]);
    const drawn = stubCanvas((w) => (w === 182 ? mark : blurred));
    const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'mark74.png', { type: 'image/png' }));
    expect(result).toEqual({ ok: true, colors: ['#111413', '#e8593c'] });
    expect(drawn).toEqual([[0, 0, 96, 96], [0, 0, 182, 182]]);
  });

  it('clusters an opaque image on the canvas 96 px downscale drawn first, as before, and reads its evidence whole', async () => {
    stubImage(1000, 1000);
    const big = framed(20);
    const small = fixture('frame-grey-20px-of-1000-96x96');
    const drawn = stubCanvas((w) => (w === 1000 ? big : small));
    const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'frame.png', { type: 'image/png' }));
    // Chrome downscales an image it already drew at full size differently,
    // so the 96 px draw comes first.
    expect(drawn).toEqual([[0, 0, 96, 96], [0, 0, 1000, 1000]]);
    expect(result).toEqual({ ok: true, colors: ['#000000', '#fefefe', '#808080'] });
  });

  it(`reads at most ${READ_MAX_DIM} px on the longest edge`, async () => {
    stubImage(8192, 2048);
    const drawn = stubCanvas((w, h) => image(w, h, () => [40, 80, 160, 255]));
    const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'wide.png', { type: 'image/png' }));
    expect(drawn).toEqual([[0, 0, 96, 24], [0, 0, 4096, 1024]]);
    expect(result).toEqual({ ok: true, colors: ['#2850a0'] });
  });
});

// Review 4 L4: mutants that survived round 5 and changed what Extract shows.
describe('the edge fold, pinned where round 5 left it open (review 4, L4)', () => {
  const edgeOnly = (edge: EdgeEvidence['edge']): EdgeEvidence => ({ edge, touching: () => false });

  it('reads the evidence where the counted pixels are: a grey caption on a black-and-white logo on a clear background stays', () => {
    // A clear margin of 8 px all round; the logo half black, half white; the
    // top 4 rows of the logo grey.
    const data = image(96, 96, (x, y) => {
      if (x < 8 || x >= 88 || y < 8 || y >= 88) return [0, 0, 0, 0];
      if (y < 12) return [128, 128, 128, 255];
      return x < 48 ? [0, 0, 0, 255] : [255, 255, 255, 255];
    });
    expect(colors(paletteFromPixels(data, 6, 96))).toEqual(['#000000', '#ffffff', '#808080']);
    expect(colors(paletteFromImageData(data, 96, 96))).toEqual(['#000000', '#ffffff', '#808080']);
  });

  it('keeps a light highlight past the end of the line: #d7d7d7 between black and mid-grey', () => {
    const out = colors(paletteFromPixels(image(96, 96, (_, y) => (y < 47 ? [0, 0, 0, 255] : y < 49 ? [215, 215, 215, 255] : [128, 128, 128, 255])), 6, 96));
    expect(out).toEqual(['#000000', '#808080', '#d7d7d7']);
  });

  it("doesn't read 'next to' across the end of a row: a grey right border with black on the left border stays", () => {
    // Columns 0-2 black, 94-95 grey, the rest white.
    const out = colors(paletteFromPixels(image(96, 96, (x) => (x < 3 ? [0, 0, 0, 255] : x >= 94 ? [128, 128, 128, 255] : [255, 255, 255, 255])), 6, 96));
    expect(out).toEqual(['#ffffff', '#000000', '#808080']);
  });

  it('folds a blend up to ΔE00 5 off the line, and not past it', () => {
    const big = [{ rgb: [0, 0, 0], weight: 50 }, { rgb: [255, 255, 255], weight: 46 }];
    expect(mergeNearColors([...big, { rgb: [128, 133, 128], weight: 4 }], MERGE_DELTA_E, edgeOnly(() => 1))).toHaveLength(2); // 4.34 off
    expect(mergeNearColors([...big, { rgb: [128, 134, 128], weight: 4 }], MERGE_DELTA_E, edgeOnly(() => 1))).toHaveLength(3); // 5.11 off
  });

  it('folds a blend only between two heavier swatches, not into one of equal weight', () => {
    // b lies between a and c, but c is no heavier than b.
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 50 },
      { rgb: [128, 128, 128], weight: 4 },
      { rgb: [255, 255, 255], weight: 4 },
      { rgb: [200, 40, 40], weight: 42 },
    ], MERGE_DELTA_E, edgeOnly(() => 1));
    expect(out).toHaveLength(4);
  });

  it('folds along the nearest line, not the first one found', () => {
    // [120,128,128] is 4.15 off the black-white line (t 0.49: black) and
    // 1.55 off the red-cyan line (t 0.51: cyan). Nearest wins: cyan.
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 30 },
      { rgb: [255, 255, 255], weight: 30 },
      { rgb: [255, 0, 0], weight: 20 },
      { rgb: [0, 255, 255], weight: 18 },
      { rgb: [120, 128, 128], weight: 2 },
    ], MERGE_DELTA_E, edgeOnly(() => 1));
    expect(out.map((c) => c.weight)).toEqual([30, 30, 20, 20]);
    expect(out[3].rgb).toEqual([0, 255, 255]);
  });

  it('folds a speck only into a heavier swatch, not into one of equal weight', () => {
    // Two specks 4 apart (past the merge, within the speck tolerance), far from the rest.
    const out = mergeNearColors([
      { rgb: [240, 240, 240], weight: 9999 },
      { rgb: [40, 200, 70], weight: 0.5 },
      { rgb: [40, 188, 64], weight: 0.5 },
    ]);
    expect(out).toHaveLength(3);
  });
});
