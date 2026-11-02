import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALPHA_MIN,
  areaGrid,
  deltaE00,
  EDGE_REACH,
  type EdgeEvidence,
  edgeEvidenceFromLabels,
  type EvidenceCell,
  EVIDENCE_MAX_DIM,
  exactAreaGrid,
  extractPaletteFromImage,
  gridFromRgba,
  mergeNearColors,
  MERGE_DELTA_E,
  mostPopulated,
  paletteFromImageData,
  paletteFromPixels,
  READ_MAX_DIM,
  twoFlats,
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
    // The band shows its most populated 256 px colour: the divider's own
    // purple (round 6 showed the mean, #6d1f81; GM r11).
    expect(out[2]).toBe('#781e78');
    noNearPair(out);
    // At 96 px alone the run is one band too.
    expect(colors(paletteFromPixels(small, 6, 96))).toHaveLength(3);
  });

  it('gives the grey divider between black and white one band', () => {
    const out = colors(paletteFromImageData(divided(25, [0, 0, 0], [255, 255, 255], [128, 128, 128]), 1000, 600, 6, {
      data: fixture('bw-grey-25px-of-1000-96x58'), width: 96,
    }));
    // Round 6 showed #8e8e8e, the mean with the divider's partly white edge
    // cells; its most populated colour is the divider's (GM r11).
    expect(out).toEqual(['#000000', '#ffffff', '#808080']);
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

  it('keeps two touching flat accents on one line as two colours (GM r11, review 5 M1)', () => {
    // Two solid stripes side by side between red and blue. Round 6 made them
    // one band at their mean, #781e78, a colour the image doesn't hold.
    const pink = [170, 25, 80];
    const violet = [70, 35, 160];
    const out = colors(paletteFromPixels(image(100, 100, (x, y) => {
      if (y < 4) return [...(x < 50 ? pink : violet), 255];
      return [...(x < 50 ? RED : BLUE), 255];
    }), 6, 100));
    expect(out).toHaveLength(4);
    expect(out).toContain('#aa1950');
    expect(out).toContain('#4623a0');
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
    // and s1 and s2 are one band, kept (no edge between black and white). With
    // no pixels to read, the band shows its heaviest part, never a mean.
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
    expect(out[2].rgb).toEqual([100, 100, 100]);
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

// A decoded image and a canvas that hands back `pixels` for each draw size.
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

describe('extractPaletteFromImage reads the picked image whole (review 4, M3)', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

// PR #208 round 7: review 5 (colour-maths M1, L1, L2, the surviving mutants)
// and GM r11: "a palette never shows a colour the image doesn't contain".
// The reviewer's probes (probes/attack.py), 1000 x 600, scaled to 96 px with
// PIL BILINEAR.
const PINK = [170, 25, 80];
const VIOLET = [70, 35, 160];
function uiNav(gap: number): Uint8ClampedArray {
  // A white page, a black header, a #333 nav bar and a #ddd divider.
  return image(1000, 600, (_, y) => {
    if (y < 180) return [0, 0, 0, 255];
    if (y < 205) return [51, 51, 51, 255];
    if (y >= 205 + gap && y < 230 + gap) return [221, 221, 221, 255];
    return [255, 255, 255, 255];
  });
}
function pinkVioletTags(): Uint8ClampedArray {
  // A red | blue flag with a pink tag and a violet tag touching at the seam.
  return image(1000, 600, (x, y) => {
    if (y >= 100 && y < 140 && x >= 200 && x < 500) return [...PINK, 255];
    if (y >= 100 && y < 140 && x >= 500 && x < 800) return [...VIOLET, 255];
    return [...(x < 500 ? RED : BLUE), 255];
  });
}
/** ``data`` with its first pixel clear: the same image through the area path. */
function withClearPixel(data: Uint8ClampedArray): Uint8ClampedArray {
  const out = data.slice();
  out[3] = 0;
  return out;
}

describe('a band only for a continuous run (GM r11, review 5 M1)', () => {
  it('keeps both greys of a #333 nav bar touching a #ddd divider (ui-nav-gap0)', () => {
    const data = uiNav(0);
    const out = colors(paletteFromImageData(data, 1000, 600, 6, { data: fixture('ui-nav-gap0-96x58'), width: 96 }));
    // Round 6 made the two bars one band at their mean, #858585.
    expect(new Set(out)).toEqual(new Set(['#ffffff', '#000000', '#333333', '#dddddd']));
    expect(new Set(colors(paletteFromImageData(withClearPixel(data), 1000, 600)))).toEqual(
      new Set(['#ffffff', '#000000', '#333333', '#dddddd']),
    );
  });

  it('keeps both greys with a gap between the bars too (ui-nav-gap20)', () => {
    const out = colors(paletteFromImageData(withClearPixel(uiNav(20)), 1000, 600));
    expect(new Set(out)).toEqual(new Set(['#ffffff', '#000000', '#333333', '#dddddd']));
  });

  it('keeps a pink tag and a violet tag that touch on a red | blue flag as two colours', () => {
    const data = pinkVioletTags();
    const out = colors(paletteFromImageData(data, 1000, 600, 6, { data: fixture('pink-violet-touching-96x58'), width: 96 }));
    // Round 6: #1528c7 #dc1428 #781e78, the tags' mean.
    expect(new Set(out)).toEqual(new Set(['#dc1428', '#1528c7', '#aa1950', '#4623a0']));
    expect(new Set(colors(paletteFromImageData(withClearPixel(data), 1000, 600)))).toEqual(
      new Set(['#dc1428', '#1428c8', '#aa1950', '#4623a0']),
    );
  });

  it('keeps the 14 px frame as one keyline, in its own grey', () => {
    const out = colors(paletteFromImageData(framed(14), 1000, 1000, 6, { data: fixture('frame-grey-14px-of-1000-96x96'), width: 96 }));
    // Round 6: #6f6f6f.
    expect(out).toEqual(['#000000', '#fefefe', '#808080']);
  });

  it('reads the band between the heaviest colours first, whatever order the swatches come in', () => {
    // A 10 px frame scaled with PIL BOX: a band between grey blends and the
    // white inside the black one. Taken first (or the nearest first), the
    // smaller band left a dark blend, #171717, as a colour.
    const out = colors(paletteFromImageData(framed(10), 1000, 1000, 6, { data: fixture('frame-grey-10px-of-1000-box-96x96'), width: 96 }));
    expect(out).toEqual(['#000000', '#ffffff', '#808080']);
  });

  it('reads a round sticker ring as one keyline in its own grey', () => {
    // A 1024 px white disc with a 12 px #6e6e6e ring on black. Its blends
    // make bands on more than one line; taking the nearest band first, or a
    // band's heaviest part instead of its pixels, showed #8e8e8e.
    const ring = image(1024, 1024, (x, y) => {
      const r = Math.hypot(x - 512, y - 512);
      return r < 300 ? [255, 255, 255, 255] : r < 312 ? [110, 110, 110, 255] : [0, 0, 0, 255];
    });
    const out = colors(paletteFromImageData(ring, 1024, 1024, 6, { data: fixture('sticker-ring-12px-of-1024-96x96'), width: 96 }));
    expect(out).toEqual(['#000000', '#fefefe', '#6e6e6e']);
  });

  it('takes the longer run first where two runs share a swatch', () => {
    // Black-white and red-cyan cross at mid-grey. The grey run (100, 128,
    // 160) is longer than the red one (191,64,64 with 128); 100 and 160
    // touch only through 128. Longer first: one grey band that then takes
    // the red blend too. Shorter first left 100 and 160 apart.
    const near = new Set(['4,5', '5,6', '5,7']);
    const evidence: EdgeEvidence = {
      edge: () => 0,
      touching: (a, b) => a.some((x) => b.some((y) => near.has([x, y].sort().join()))),
    };
    const out = mergeNearColors([
      [0, 0, 0, 40], [255, 255, 255, 40], [255, 0, 0, 40], [0, 255, 255, 40],
      [100, 100, 100, 2], [128, 128, 128, 3], [160, 160, 160, 1], [191, 64, 64, 4],
    ].map(([r, g, b, weight], i) => ({ rgb: [r, g, b], weight, members: [i] })), MERGE_DELTA_E, evidence);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([
      [[0, 0, 0], 40], [[255, 255, 255], 40], [[255, 0, 0], 40], [[0, 255, 255], 40], [[128, 128, 128], 10],
    ]);
  });

  it('gives the same swatches for the same colours in any order', () => {
    const evidence: EdgeEvidence = { edge: () => 0, touching: () => true };
    const swatches = [
      { rgb: [0, 0, 0], weight: 40 },
      { rgb: [255, 255, 255], weight: 40 },
      { rgb: [200, 0, 0], weight: 30 },
      { rgb: [80, 80, 80], weight: 2 },
      { rgb: [160, 160, 160], weight: 2 },
      { rgb: [100, 0, 0], weight: 2 },
      { rgb: [150, 0, 0], weight: 2 },
    ];
    const sorted = (list: typeof swatches) => mergeNearColors(list, MERGE_DELTA_E, evidence)
      .map((c) => `${c.rgb.join()}:${c.weight}`).sort();
    const first = sorted(swatches);
    expect(sorted([...swatches].reverse())).toEqual(first);
    expect(sorted([swatches[3], swatches[6], swatches[0], swatches[5], swatches[2], swatches[4], swatches[1]])).toEqual(first);
  });

  it('takes only swatches strictly between the ends into a run', () => {
    // [30,30,30] is on the line past the dark end (t -0.13): not a blend.
    const evidence: EdgeEvidence = { edge: () => 0, touching: () => true };
    const out = mergeNearColors([
      { rgb: [50, 50, 50], weight: 40 },
      { rgb: [200, 200, 200], weight: 40 },
      { rgb: [30, 30, 30], weight: 2 },
      { rgb: [100, 100, 100], weight: 2 },
      { rgb: [140, 140, 140], weight: 1 },
    ], MERGE_DELTA_E, evidence);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([
      [[50, 50, 50], 40], [[200, 200, 200], 40], [[100, 100, 100], 3], [[30, 30, 30], 2],
    ]);
  });

  it('folds a band with no pixels into its own line, not a nearer one found later', () => {
    // The band (heaviest part [90,84,84]) is on black-white (t 0.34: black)
    // and exactly on black-[160,149,149] (t 0.56: that pink grey). The band
    // folds into black; kept, it would fold at the end onto the nearer line.
    const evidence: EdgeEvidence = { edge: (swatch) => (swatch.length >= 2 ? NaN : 0), touching: () => true };
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 50 },
      { rgb: [255, 255, 255], weight: 40 },
      { rgb: [160, 149, 149], weight: 30 },
      { rgb: [64, 60, 60], weight: 2 },
      { rgb: [90, 84, 84], weight: 3 },
    ], MERGE_DELTA_E, evidence);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([[[0, 0, 0], 55], [[255, 255, 255], 40], [[160, 149, 149], 30]]);
  });

  it('folds a band with no pixels at the evidence scale (all edge)', () => {
    const noPixels: EdgeEvidence = { edge: () => NaN, touching: () => true };
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 50 },
      { rgb: [255, 255, 255], weight: 40 },
      { rgb: [64, 64, 64], weight: 2 },
      { rgb: [90, 90, 90], weight: 2 },
    ], MERGE_DELTA_E, noPixels);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([[[0, 0, 0], 54], [[255, 255, 255], 40]]);
  });
});

describe('telling two flat colours from a run (twoFlats, mostPopulated)', () => {
  const cell = (v: number[], inside = true, weight = 1): EvidenceCell => ({ rgb: v, weight, inside });
  const A = [0, 0, 0];
  const B = [255, 255, 255];
  const grey = (v: number, inside = true) => cell([v, v, v], inside);

  it('reads two flat greys with nothing between as two', () => {
    expect(twoFlats([...Array(20).fill(grey(51)), ...Array(20).fill(grey(221))], A, B)).toBe(true);
  });

  it('reads a ramp, one flat colour, or only edge cells as a run', () => {
    expect(twoFlats(Array.from({ length: 64 }, (_, i) => grey(i * 4)), A, B)).toBe(false);
    expect(twoFlats(Array(30).fill(grey(128)), A, B)).toBe(false);
    // Two "modes" made only of cells an edge cuts (none inside) are no evidence.
    expect(twoFlats([...Array(20).fill(grey(64, false)), ...Array(20).fill(grey(192, false))], A, B)).toBe(false);
    // A flat colour with its edge cells beside it is one.
    expect(twoFlats([...Array(30).fill(grey(128)), ...Array(10).fill(grey(64, false))], A, B)).toBe(false);
  });

  it('reads a third flat colour between the two as a run, not two flats', () => {
    expect(twoFlats([...Array(20).fill(grey(51)), ...Array(20).fill(grey(221)), ...Array(8).fill(grey(136))], A, B)).toBe(false);
  });

  it("doesn't read a small second mode as a second colour", () => {
    expect(twoFlats([...Array(40).fill(grey(51)), ...Array(5).fill(grey(221))], A, B)).toBe(false);
  });

  it('shows the most populated colour, preferring cells inside a flat area', () => {
    expect(mostPopulated([grey(60, false), grey(60, false), grey(60, false), grey(128)])).toEqual([128, 128, 128]);
    expect(mostPopulated([grey(60, false), grey(60, false), grey(128, false)])).toEqual([60, 60, 60]);
    expect(mostPopulated([])).toBeNull();
  });

  it("takes a thin line's middle when it and its two edge mixes are about as common", () => {
    // A keyline one cell wide at 256: 97 | 128 | 153, a near tie.
    const line = [...Array(33).fill(grey(97, false)), ...Array(31).fill(grey(128, false)), ...Array(30).fill(grey(153, false))];
    expect(mostPopulated(line)).toEqual([128, 128, 128]);
  });

  it('counts a cell by its weight (alpha) in the evidence', () => {
    const pixels = { rgb: new Float64Array([10, 20, 30, 10, 20, 30, 10, 20, 30, 200, 100, 50]), weight: new Float64Array([0.1, 0.1, 0.1, 1]), width: 4 };
    const evidence = edgeEvidenceFromLabels(new Int32Array([0, 0, 0, 0]), 4, undefined, pixels);
    expect(evidence.colour?.([0])).toEqual([200, 100, 50]);
  });
});

describe('the evidence is exactly 256 px (GM r11, review 5 L1)', () => {
  const band = (w: number, h: number, at: number, width: number) =>
    image(w, h, (_, y) => (y < at ? [0, 0, 0, 255] : y < at + width ? [128, 128, 128, 255] : [255, 255, 255, 255]));

  it('reduces to exactly 256 on the longest edge, from 500 to 520 px', () => {
    for (let w = 500; w <= 520; w++) {
      const grid = exactAreaGrid(band(w, 300, 150, 7), w, 300, EVIDENCE_MAX_DIM);
      expect(grid.width).toBe(256);
      expect(grid.weight.length).toBe(256 * Math.round((300 * 256) / w));
    }
  });

  it("keeps a 7 px band and folds a 3 px one at every size from 500 to 520 px, wherever it sits", () => {
    // Round 6's integer blocks made the grid 256 px up to 512 and 171 px
    // from 513: the 7 px band folded at 513 and up (review 5, L1).
    // Each image is w x 200 (the longest edge sets the scale), to keep it quick.
    for (let w = 500; w <= 520; w++) {
      for (const at of [100, 101, 102, 103]) {
        expect(new Set(colors(paletteFromImageData(band(w, 200, at, 7), w, 200)))).toEqual(new Set(['#ffffff', '#000000', '#808080']));
        expect(colors(paletteFromImageData(band(w, 200, at, 3), w, 200))).toHaveLength(2);
      }
    }
  }, 30_000);

  it('shares a pixel between the cells it overlaps, by area', () => {
    // 3 px to 2 cells: the middle pixel is half in each.
    const data = new Uint8ClampedArray([0, 0, 0, 255, 120, 120, 120, 255, 240, 240, 240, 255]);
    const grid = exactAreaGrid(data, 3, 1, 2);
    expect(grid.width).toBe(2);
    expect([...grid.rgb]).toEqual([40, 40, 40, 200, 200, 200]);
    expect([...grid.weight]).toEqual([1, 1]);
  });

  it(`counts a pixel at alpha ${ALPHA_MIN}, and drops one under it`, () => {
    const at = (alpha: number) => new Uint8ClampedArray([200, 40, 40, alpha, 0, 0, 0, 0]);
    expect(areaGrid(at(ALPHA_MIN), 2, 1, 1).weight[0]).toBeGreaterThan(0);
    expect(areaGrid(at(ALPHA_MIN - 1), 2, 1, 1).weight[0]).toBe(0);
    expect(exactAreaGrid(at(ALPHA_MIN), 2, 1, 1).weight[0]).toBeGreaterThan(0);
    expect(exactAreaGrid(at(ALPHA_MIN - 1), 2, 1, 1).weight[0]).toBe(0);
  });
});

describe('a small swatch shows its 256 px colour (GM r11, review 5 L2)', () => {
  it('shows a 10 px keyline in its own grey, #808080, not the 96 px smear', () => {
    const out = colors(paletteFromImageData(framed(20), 1000, 1000, 6, { data: fixture('frame-grey-20px-of-1000-96x96'), width: 96 }));
    expect(out[2]).toBe('#808080');
    // Through the area path, the keylines round 6 showed as #6a6a6a and #707070.
    for (const border of [10, 14]) {
      expect(colors(paletteFromImageData(withClearPixel(framed(border)), 1000, 1000))).toEqual(['#000000', '#ffffff', '#808080']);
    }
  });
});

describe('a small swatch of scattered tones keeps its colour (REAL_COLOUR)', () => {
  it("doesn't jump to a stray pixel when no few colours hold the swatch", () => {
    // 40 different tones and 3 pixels of one red: the red is the most
    // populated, but it is 7% of the swatch, a stray.
    const scattered = [
      ...Array.from({ length: 40 }, (_, i) => ({ rgb: [60 + i * 4, 120, 90], weight: 1, inside: false })),
      ...Array.from({ length: 3 }, () => ({ rgb: [200, 50, 50], weight: 1, inside: false })),
    ];
    const evidence: EdgeEvidence = {
      edge: () => 0,
      touching: () => false,
      cells: (swatch) => (swatch.includes(2) ? scattered : []),
    };
    const out = mergeNearColors([
      { rgb: [10, 10, 10], weight: 50, members: [0] },
      { rgb: [240, 240, 240], weight: 46, members: [1] },
      { rgb: [112, 159, 122], weight: 4, members: [2] },
    ], MERGE_DELTA_E, evidence);
    expect(out[2].rgb).toEqual([112, 159, 122]);
  });
});

describe('the evidence labels and touching (review 5, surviving mutants)', () => {
  it('reads touching on 8 neighbours, never across the end of a row', () => {
    // 3 wide: 0 at (0,0) and 1 at (1,1) touch at a corner.
    const corner = edgeEvidenceFromLabels(new Int32Array([0, -1, -1, -1, 1, -1]), 3);
    expect(corner.touching([0], [1])).toBe(true);
    // 0 at the end of row 0 and 1 at the start of row 1 are far apart.
    const wrap = edgeEvidenceFromLabels(new Int32Array([-1, -1, 0, 1, -1, -1]), 3);
    expect(wrap.touching([0], [1])).toBe(false);
  });

  it('labels no clear pixel at the evidence scale: a grey line between clear and white stays a keyline', () => {
    // A black block, a white card, and a 4 px grey line between the clear
    // background and the card. Clear pixels labelled black would put the
    // line next to black and white, and fold it as their edge.
    const data = image(1000, 600, (x, y) => {
      if (x < 200 && y < 200) return [0, 0, 0, 255];
      if (x < 400) return [0, 0, 0, 0];
      if (x < 404) return [128, 128, 128, 255];
      return [255, 255, 255, 255];
    });
    expect(colors(paletteFromImageData(data, 1000, 600))).toContain('#808080');
  });
});

describe('Extract picks the path by any transparency (review 5, surviving mutants)', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads an image at alpha 128 everywhere, no pixel clear, by area on its own pixels', async () => {
    stubImage(200, 200);
    const half = image(200, 200, () => [240, 120, 20, 128]);
    const canvas = image(96, 96, () => [20, 60, 200, 255]);
    stubCanvas((w) => (w === 200 ? half : canvas));
    const result = await extractPaletteFromImage(new File([new Uint8Array(8)], 'half.png', { type: 'image/png' }));
    expect(result).toEqual({ ok: true, colors: ['#f07814'] });
  });

  it('draws the 96 px read rounded to the nearest pixel', async () => {
    stubImage(1000, 599);
    const drawn = stubCanvas((w, h) => image(w, h, () => [40, 80, 160, 255]));
    await extractPaletteFromImage(new File([new Uint8Array(8)], 'tall.png', { type: 'image/png' }));
    expect(drawn).toEqual([[0, 0, 96, 58], [0, 0, 1000, 599]]);
  });
});
