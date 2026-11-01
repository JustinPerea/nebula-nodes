import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deltaE00, MERGE_DELTA_E, mergeNearColors, paletteFromPixels } from '../src/lib/paletteExtract';

// GM r3 on #208: "The image has two colors, so it should show two swatches.
// Merge swatches that are near-identical (a small ΔE) and show fewer than six
// when the reference has fewer distinct colors, ordered by weight."

type Px = [number, number, number, number];

type Img = { data: Uint8ClampedArray; w: number };

function image(w: number, h: number, at: (x: number, y: number) => Px): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(at(x, y), (y * w + x) * 4);
  return { data, w };
}

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const CHARCOAL = [17, 20, 19];
const ORANGE = [232, 89, 60];
const BLUE = [30, 90, 220];

function colors({ data, w }: Img): string[] {
  const result = paletteFromPixels(data, 6, w);
  if (!result.ok) throw new Error(result.reason);
  return result.colors;
}

function noNearPair(hexes: string[]) {
  const rgb = hexes.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  for (let i = 0; i < rgb.length; i++) {
    for (let j = i + 1; j < rgb.length; j++) expect(deltaE00(rgb[i], rgb[j])).toBeGreaterThanOrEqual(MERGE_DELTA_E);
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
    expect(deltaE00([232, 89, 60], [1, 3, 5].map((i) => parseInt(out[1].slice(i, i + 2), 16)))).toBeLessThan(1);
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
    // Five: k-means's #000000 and #070707 (ΔE00 1.1) are one black now, as
    // the moodboard palette reads them (round 4); the rest stay apart.
    expect(grey).toEqual(['#d0d0d0', '#797979', '#3a3a3a', '#171717', '#050505']);
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
  it('folds a small mix of two bigger swatches into the nearer one, up to 5% of the image, when its pixels are an edge', () => {
    const edge = { rgb: [131, 90, 140], weight: 4 }; // half orange, half blue
    const big = [{ rgb: [232, 89, 60], weight: 50 }, { rgb: [30, 90, 220], weight: 46 }];
    const onEdge = () => 1;
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, onEdge).map((c) => c.weight)).toEqual([50, 50]);
    // Over 5% it is a colour of its own.
    expect(mergeNearColors([...big, { ...edge, weight: 6 }], MERGE_DELTA_E, onEdge)).toHaveLength(3);
    // GM r6: with fewer than 70% of its pixels next to both, it has an interior: an accent.
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, () => 0.69)).toHaveLength(3);
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, () => 0.7)).toHaveLength(2);
    // With no pixels to look at there is no evidence, so nothing folds.
    expect(mergeNearColors([...big, edge])).toHaveLength(3);
  });

  it('asks for edge evidence about every cluster a merged or folded swatch holds', () => {
    const asked: string[] = [];
    const evidence = (s: number[], a: number[], b: number[]) => {
      asked.push(`${[...s].sort()}|${[...a].sort()}|${[...b].sort()}`);
      // Only an edge when the black side holds both black clusters (0 and 1)
      // and, for the second blend, the first blend folded into it (3).
      const black = a.includes(0) && a.includes(1);
      return s.includes(4) ? (black && a.includes(3) ? 1 : 0) : black ? 1 : 0;
    };
    const out = mergeNearColors([
      { rgb: [0, 0, 0], weight: 30, members: [0] },
      { rgb: [1, 1, 1], weight: 30, members: [1] },
      { rgb: [255, 255, 255], weight: 36, members: [2] },
      { rgb: [100, 100, 100], weight: 1, members: [3] },
      { rgb: [110, 110, 110], weight: 2, members: [4] },
    ], MERGE_DELTA_E, evidence);
    expect(out.map((c) => c.weight)).toEqual([63, 36]);
    expect(out[0].members).toEqual([0, 1, 3, 4]);
    expect(asked).toContain('3|0,1|2');
    expect(asked).toContain('4|0,1,3|2');
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
    expect(merged[1]).toMatchObject({ rgb: [200, 40, 40], weight: 2 });
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
    expect(MERGE_DELTA_E).toBe(2);
    const near = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [125, 125, 125], weight: 1 }];
    const far = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [126, 126, 126], weight: 1 }];
    expect(deltaE00(near[0].rgb, near[1].rgb)).toBeLessThan(2);
    expect(deltaE00(far[0].rgb, far[1].rgb)).toBeGreaterThan(2);
    expect(mergeNearColors(near)).toHaveLength(1);
    expect(mergeNearColors(far)).toHaveLength(2);
  });

  it('folds a speck under 0.1% into the nearest bigger swatch within ΔE00 5, and keeps a far one', () => {
    const teal = { rgb: [29, 143, 138], weight: 2000 };
    const orange = { rgb: [242, 107, 29], weight: 7998 };
    const speck = { rgb: [23, 139, 139], weight: 0.7 }; // ΔE00 2.4 from the teal: a few faint pixels
    expect(mergeNearColors([orange, teal, speck]).map((c) => c.weight)).toEqual([7998, 2000.7]);
    expect(mergeNearColors([orange, teal, { ...speck, weight: 11 }])).toHaveLength(3); // 0.11%: a colour
    expect(mergeNearColors([orange, teal, { rgb: [40, 200, 70], weight: 0.7 }])).toHaveLength(3); // far: kept
  });
});

const QUILT_BEFORE = ["#463dc0", "#4dcc96", "#c53892", "#3d5c35", "#c0852b", "#c0a3cd"];

// Review 2 L3: the final population is counted by alpha weight, as the backend
// counts it, so a big faint area doesn't outrank a smaller opaque one.
describe('palette order under partial alpha', () => {
  it('orders by alpha weight, not by pixel count', () => {
    // 30% of the pixels opaque orange, 70% blue at alpha 40 (weight ~0.16 each).
    const { data, w } = image(10, 10, (x) => (x < 3 ? [...ORANGE, 255] : [...BLUE, 40]) as Px);
    expect(paletteFromPixels(data, 6, w)).toEqual({ ok: true, colors: ['#e8593c', '#1e5adc'] });
  });
});

// Review 3 M1 and GM r6 on #208, round 4: CIEDE2000 (the moodboard palette's
// metric) so near-identical blacks are one swatch, and the edge fold goes by
// evidence, so a solid accent stays however small.

/** xoshiro128** seeded by splitmix32: a real generator, not an LCG whose low
 *  bits repeat with a short period. */
function rng(seed: number): () => number {
  let z = seed >>> 0;
  const split = () => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0;
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
    return (t ^ (t >>> 16)) >>> 0;
  };
  const s = [split(), split(), split(), split()];
  const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const out = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return out / 2 ** 32;
  };
}

const DISC = [240, 120, 20];
const SEEDS = [7, 11, 2026, 31337, 424242];

/** An orange disc on a noisy grey background, as review 3 built it: each
 *  background pixel ``base`` moved by 0 to 7 levels (toward white when
 *  ``sign`` is 1). */
function noisyDisc(seed: number, base: number, sign: 1 | -1): Img {
  const next = rng(seed);
  const level = () => base + sign * Math.floor(next() * 8);
  return image(96, 96, (x, y) => {
    if (Math.hypot(x - 48, y - 48) < 20) return [...DISC, 255] as Px;
    const v = level();
    return [v, v, v, 255];
  });
}

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('near-identical blacks and whites are one swatch (review 3, M1)', () => {
  it('gives exactly two for an orange disc on a noisy black (values 0-7), over several seeds', () => {
    for (const seed of SEEDS) {
      const out = colors(noisyDisc(seed, 0, 1));
      expect(out, `seed ${seed}`).toHaveLength(2);
      expect(Math.max(...rgbOf(out[0]))).toBeLessThanOrEqual(7); // the black leads
      expect(deltaE00(rgbOf(out[1]), DISC)).toBeLessThan(1);
    }
  });

  it('gives exactly two for the disc on a noisy white (248-255)', () => {
    for (const seed of SEEDS) {
      const out = colors(noisyDisc(seed, 255, -1));
      expect(out, `seed ${seed}`).toHaveLength(2);
      expect(Math.min(...rgbOf(out[0]))).toBeGreaterThanOrEqual(248);
    }
  });

  it('keeps mid-tones just past the threshold apart, and merges them just under it', () => {
    const halves = (a: number[], b: number[]) => colors(image(96, 96, (x) => [...(x < 48 ? a : b), 255] as Px));
    expect(halves([120, 120, 120], [126, 126, 126])).toEqual(['#787878', '#7e7e7e']); // ΔE00 2.35
    expect(halves([120, 140, 160], [120, 140, 165])).toHaveLength(2); // ΔE00 2.14
    expect(halves([120, 120, 120], [125, 125, 125])).toHaveLength(1); // ΔE00 1.96
  });

  it("merges a dark photo's blacks and leaves its greys (cinematic-noir.webp at 96 px)", () => {
    // 7886a137 and b972eb9d gave #020202 #0e0e0e #1a1a1a #070707 #393939 #7f7f7f.
    expect(colors(fixture('cinematic-noir', 96))).toEqual(['#070808', '#1a1a1a', '#393939', '#7f7f7f']);
  });

  it('gives studio-product.webp the four swatches GM signed off (r4)', () => {
    expect(colors(fixture('studio-product', 96))).toEqual(['#ededee', '#f9f9f9', '#e1e0dd', '#b49d71']);
  });
});

describe('the edge fold goes by evidence (GM r6)', () => {
  it('keeps a grey caption on a black-and-white logo', () => {
    // Half black, half white, the top 4 rows grey: 4.2%, between the two in colour, but solid.
    const out = colors(image(96, 96, (x, y) => (y < 4 ? [128, 128, 128, 255] : x < 48 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    expect(out).toEqual(['#000000', '#ffffff', '#808080']);
  });

  it('keeps a solid 4% purple band between red and blue', () => {
    const out = colors(image(96, 96, (x, y) => (y < 4 ? [128, 0, 128, 255] : x < 48 ? [255, 0, 0, 255] : [0, 0, 255, 255])));
    expect(out).toHaveLength(3);
    expect(out).toContain('#800080');
  });

  it('still folds a true antialiased edge: a 1 px seam, and a 2 px ramp', () => {
    const seam = colors(image(96, 96, (x) => (x === 48 ? [128, 128, 128, 255] : x < 48 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    expect(seam).toEqual(['#000000', '#ffffff']);
    const ramp = colors(image(96, 96, (x) => [...(x === 47 ? mix(BLUE, ORANGE, 0.33) : x === 48 ? mix(BLUE, ORANGE, 0.67) : x < 47 ? BLUE : ORANGE), 255] as Px));
    expect(ramp).toHaveLength(2);
  });

  it('keeps a 3 px grey line between black and white: its middle row is interior', () => {
    // Rows 0-46 black, 47-49 grey (3.1%), 50-95 white. Only the middle row is
    // next to both, a third of its pixels.
    const out = colors(image(96, 96, (_, y) => (y < 47 ? [0, 0, 0, 255] : y < 50 ? [128, 128, 128, 255] : [255, 255, 255, 255])));
    expect(out).toEqual(['#000000', '#ffffff', '#808080']);
  });

  it('folds a 1 px horizontal seam: "next to" is read in rows of the image width', () => {
    const out = colors(image(96, 96, (_, y) => (y < 48 ? [0, 0, 0, 255] : y === 48 ? [128, 128, 128, 255] : [255, 255, 255, 255])));
    expect(out).toEqual(['#000000', '#ffffff']);
  });

  it('folds the seam and keeps the caption in the same image', () => {
    const out = colors(image(96, 96, (x, y) => {
      if (y < 4) return [128, 128, 128, 255];
      if (x === 48) return [120, 120, 120, 255];
      return x < 48 ? [0, 0, 0, 255] : [255, 255, 255, 255];
    }));
    expect(out).toHaveLength(3);
    expect(out[2]).toBe('#808080');
  });
});

function fixture(name: string, w: number): Img {
  const file = readdirFixture(name);
  return { data: new Uint8ClampedArray(readFileSync(file)), w };
}

function readdirFixture(name: string): string {
  // tests/fixtures/palette/<name>-<w>x<h>.rgba: the preset thumbnail scaled to
  // the Inspector's 96 px (PIL bilinear), straight RGBA.
  const sizes: Record<string, string> = { 'cinematic-noir': '96x54', 'studio-product': '96x96' };
  return resolve(__dirname, `fixtures/palette/${name}-${sizes[name]}.rgba`);
}
