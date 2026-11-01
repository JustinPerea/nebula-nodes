import { describe, expect, it } from 'vitest';

import { deltaEOk, MERGE_DELTA_E, mergeNearColors, paletteFromPixels } from '../src/lib/paletteExtract';

// GM r3 on #208: "The image has two colors, so it should show two swatches.
// Merge swatches that are near-identical (a small ΔE) and show fewer than six
// when the reference has fewer distinct colors, ordered by weight."

type Px = [number, number, number, number];

function image(w: number, h: number, at: (x: number, y: number) => Px): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4);
  return data;
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const CHARCOAL = [17, 20, 19];
const ORANGE = [232, 89, 60];
const BLUE = [30, 90, 220];

function colors(data: Uint8ClampedArray): string[] {
  const result = paletteFromPixels(data);
  if (!result.ok) throw new Error(result.reason);
  return result.colors;
}

function noNearPair(hexes: string[]) {
  const rgb = hexes.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  for (let i = 0; i < rgb.length; i++) {
    for (let j = i + 1; j < rgb.length; j++) expect(deltaEOk(rgb[i], rgb[j])).toBeGreaterThanOrEqual(MERGE_DELTA_E);
  }
}

describe('Extract from reference shows each distinct colour once', () => {
  it('gives exactly two swatches for a two-colour logo with soft edges on a clear background', () => {
    // A charcoal bar and an orange bar, 1 px antialiased edges between them and into the clear.
    const data = image(96, 96, (x, y) => {
      if (y < 20 || y >= 76 || x < 10 || x >= 86) return [0, 0, 0, 0];
      const edge = y === 20 || y === 75 || x === 10 || x === 85;
      if (x < 47) return [...CHARCOAL, edge ? 128 : 255] as Px;
      if (x === 47 || x === 48) return [...mix(CHARCOAL, ORANGE, x === 47 ? 0.33 : 0.67), edge ? 128 : 255] as Px;
      return [...ORANGE, edge ? 128 : 255] as Px;
    });
    const out = colors(data);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('#111413'); // the charcoal covers more, so it leads
    expect(deltaEOk([232, 89, 60], [1, 3, 5].map((i) => parseInt(out[1].slice(i, i + 2), 16)))).toBeLessThan(0.01);
  });

  it('gives two for an orange core in a translucent blue glow (the shot GM reviewed)', () => {
    const data = image(96, 96, (x, y) => {
      const r = Math.hypot(x - 48, y - 48);
      if (r < 14) return [...ORANGE, 255] as Px;
      if (r < 15) return [...mix(ORANGE, BLUE, 0.5), 200] as Px; // the core's soft edge
      if (r < 41) return [...BLUE, Math.round(110 - (r / 41) * 70)] as Px;
      return [0, 0, 0, 0];
    });
    const out = colors(data);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('#1e5adc');
    expect(out[1]).toBe('#e8593c');
  });

  it('still gives six for six colours, in stripes or in bands', () => {
    const six = [[220, 40, 40], [40, 180, 60], [40, 80, 220], [240, 220, 40], [30, 30, 30], [240, 240, 240]];
    const stripes = colors(image(96, 60, (x) => [...six[Math.floor(x / 16)], 255] as Px));
    const bands = colors(image(60, 96, (_, y) => [...six[Math.floor(y / 16)], 255] as Px));
    for (const out of [stripes, bands]) {
      expect(out).toHaveLength(6);
      expect(new Set(out)).toEqual(new Set(six.map((c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`)));
    }
  });

  it("doesn't collapse a gradient", () => {
    const grey = colors(image(96, 60, (x) => { const v = Math.round((x / 95) * 255); return [v, v, v, 255]; }));
    expect(grey).toHaveLength(6);
    noNearPair(grey);
    const warm = colors(image(96, 60, (x) => [...mix([30, 90, 200], [230, 90, 40], x / 95), 255] as Px));
    expect(warm.length).toBeGreaterThanOrEqual(3);
    noNearPair(warm);
  });

  it('keeps a small accent that is no mix of the others', () => {
    // 2% green on blue and orange halves: small, but not their edge.
    const out = colors(image(100, 100, (x, y) => {
      if (x < 10 && y < 20) return [40, 200, 70, 255];
      return [...(x < 50 ? BLUE : ORANGE), 255] as Px;
    }));
    // Orange covers 50%, blue 48%, green 2%.
    expect(out).toEqual(['#e8593c', '#1e5adc', '#28c846']);
  });

  it('gives an opaque image with no near-identical swatches the colours it gave before', () => {
    // Computed with paletteExtract.ts at 7886a137: six distinct swatches, unchanged.
    const quilt = image(96, 96, (x, y) => {
      const v = (x * 7 + y * 13) % 256;
      return [v, (x * 3 + 40) % 256, (y * 5 + 90) % 256, 255];
    });
    expect(colors(quilt)).toEqual(QUILT_BEFORE);
  });
});

describe('mergeNearColors', () => {
  it('folds a small mix of two bigger swatches into the nearer one, up to 5% of the image', () => {
    const edge = { rgb: [131, 90, 140], weight: 4 }; // half orange, half blue
    const big = [{ rgb: [232, 89, 60], weight: 50 }, { rgb: [30, 90, 220], weight: 46 }];
    expect(mergeNearColors([...big, edge]).map((c) => c.weight)).toEqual([50, 50]);
    // Over 5% it is a colour of its own.
    expect(mergeNearColors([...big, { ...edge, weight: 6 }])).toHaveLength(3);
  });

  it('adds up the weights it merges, averages by weight and orders by weight', () => {
    const merged = mergeNearColors([
      { rgb: [100, 100, 100], weight: 1 },
      { rgb: [200, 40, 40], weight: 2 },
      { rgb: [101, 100, 100], weight: 3 },
      { rgb: [5, 5, 5], weight: 0 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].weight).toBe(4);
    expect(merged[0].rgb[0]).toBeCloseTo(100.75, 6);
    expect(merged[1]).toEqual({ rgb: [200, 40, 40], weight: 2 });
  });

  it('orders by the merged weights: two near shades together can lead', () => {
    const merged = mergeNearColors([
      { rgb: [200, 40, 40], weight: 3 },
      { rgb: [100, 100, 100], weight: 2 },
      { rgb: [101, 100, 100], weight: 2 },
    ]);
    expect(merged.map((c) => c.weight)).toEqual([4, 3]);
  });

  it('merges under the threshold and not at it', () => {
    expect(MERGE_DELTA_E).toBe(0.03);
    const near = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [124, 124, 124], weight: 1 }];
    const far = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [130, 130, 130], weight: 1 }];
    expect(deltaEOk(near[0].rgb, near[1].rgb)).toBeLessThan(0.03);
    expect(deltaEOk(far[0].rgb, far[1].rgb)).toBeGreaterThan(0.03);
    expect(mergeNearColors(near)).toHaveLength(1);
    expect(mergeNearColors(far)).toHaveLength(2);
  });
});

const QUILT_BEFORE = ["#463dc0", "#4dcc96", "#c53892", "#3d5c35", "#c0852b", "#c0a3cd"];

// Review 2 L3: the final population is counted by alpha weight, as the backend
// counts it, so a big faint area doesn't outrank a smaller opaque one.
describe('palette order under partial alpha', () => {
  it('orders by alpha weight, not by pixel count', () => {
    // 30% of the pixels opaque orange, 70% blue at alpha 40 (weight ~0.16 each).
    const data = image(10, 10, (x) => (x < 3 ? [...ORANGE, 255] : [...BLUE, 40]) as Px);
    expect(paletteFromPixels(data)).toEqual({ ok: true, colors: ['#e8593c', '#1e5adc'] });
  });
});
