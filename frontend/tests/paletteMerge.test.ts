import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deltaE00,
  type EdgeEvidence,
  isNeutralNearBlack,
  MERGE_DELTA_E,
  mergeNearColors,
  NEUTRAL_NEAR_BLACK,
  paletteFromPixels,
  rgbToLab,
} from '../src/lib/paletteExtract';

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
    // Five: k-means's near-blacks are one black (round 4), named at full
    // resolution (GM r13): on an even ramp every value is as common as the
    // next, so the black is its pixels' middle, #0b0b0b. Each other cluster
    // is its own pixel nearest its mean (GM r15), all under ΔE00 0.4 from
    // round 7's means.
    expect(grey).toEqual(['#d1d1d1', '#797979', '#3b3b3b', '#181818', '#0b0b0b']);
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

  it('gives an opaque image with no near-identical swatches six colours, each a pixel it holds', () => {
    // Computed with paletteExtract.ts at 7886a137: six distinct swatches, unchanged.
    const quilt = image(96, 96, (x, y) => {
      const v = (x * 7 + y * 13) % 256;
      return [v, (x * 3 + 40) % 256, (y * 5 + 90) % 256, 255];
    });
    expect(colors(quilt)).toEqual(QUILT_BEFORE);
  });
});

// Evidence for mergeNearColors from an edge share alone: no two swatches
// touch, so no run of blends is a band (foldBands).
const edgeOnly = (edge: EdgeEvidence['edge']): EdgeEvidence => ({ edge, touching: () => false });

describe('mergeNearColors', () => {
  it('folds a small mix of two bigger swatches into the nearer one, up to 5% of the image, when its pixels are an edge', () => {
    const edge = { rgb: [131, 90, 140], weight: 4 }; // half orange, half blue
    const big = [{ rgb: [232, 89, 60], weight: 50 }, { rgb: [30, 90, 220], weight: 46 }];
    const onEdge = edgeOnly(() => 1);
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, onEdge).map((c) => c.weight)).toEqual([50, 50]);
    // Over 5% it is a colour of its own.
    expect(mergeNearColors([...big, { ...edge, weight: 6 }], MERGE_DELTA_E, onEdge)).toHaveLength(3);
    // GM r6: with fewer than 70% of its pixels next to both, it has an interior: an accent.
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, edgeOnly(() => 0.69))).toHaveLength(3);
    expect(mergeNearColors([...big, edge], MERGE_DELTA_E, edgeOnly(() => 0.7))).toHaveLength(2);
    // With no pixels to look at there is no evidence, so nothing folds.
    expect(mergeNearColors([...big, edge])).toHaveLength(3);
  });

  it('asks for edge evidence about every cluster a merged or folded swatch holds', () => {
    const asked: string[] = [];
    const evidence = edgeOnly((s: number[], a: number[], b: number[]) => {
      asked.push(`${[...s].sort()}|${[...a].sort()}|${[...b].sort()}`);
      // Only an edge when the black side holds both black clusters (0 and 1)
      // and, for the second blend, the first blend folded into it (3).
      const black = a.includes(0) && a.includes(1);
      return s.includes(4) ? (black && a.includes(3) ? 1 : 0) : black ? 1 : 0;
    });
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
    expect(MERGE_DELTA_E).toBe(3);
    const near = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [127, 127, 127], weight: 1 }];
    const far = [{ rgb: [120, 120, 120], weight: 1 }, { rgb: [128, 128, 128], weight: 1 }];
    expect(deltaE00(near[0].rgb, near[1].rgb)).toBeLessThan(3);
    expect(deltaE00(far[0].rgb, far[1].rgb)).toBeGreaterThan(3);
    expect(mergeNearColors(near)).toHaveLength(1);
    expect(mergeNearColors(far)).toHaveLength(2);
  });

  it('folds a speck under 0.1% into the nearest bigger swatch within ΔE00 5, past the merge threshold, and keeps a far one', () => {
    const teal = { rgb: [29, 143, 138], weight: 2000 };
    const orange = { rgb: [242, 107, 29], weight: 7998 };
    const speck = { rgb: [19, 136, 139], weight: 0.7 }; // ΔE00 4.0 from the teal: a few faint pixels
    expect(mergeNearColors([orange, teal, speck]).map((c) => c.weight)).toEqual([7998, 2000.7]);
    expect(mergeNearColors([orange, teal, { ...speck, weight: 11 }])).toHaveLength(3); // 0.11%: a colour
    expect(mergeNearColors([orange, teal, { rgb: [40, 200, 70], weight: 0.7 }])).toHaveLength(3); // far: kept
  });
});

// Round 8 (GM r15): each cluster shows its own pixel nearest its mean, not
// the mean (7886a137 gave #463dc0 #4dcc96 #c53892 #3d5c35 #c0852b #c0a3cd;
// the quilt is a texture, so the nearest pixel is up to ΔE00 3.5 away).
const QUILT_BEFORE = ["#423dc3", "#4cd6a0", "#c63a96", "#3d5b30", "#ba8b35", "#c69dc7"];

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
/** Seeds for the noise on each channel apart: the 40 the round 5 test used,
 *  and the 200 GM's r8 check counts (the 40 are the first of them). */
const SEEDS_200 = Array.from({ length: 200 }, (_, i) => 1000 + i * 7919);
const SEEDS_40 = SEEDS_200.slice(0, 40);

/** An orange disc on a noisy grey background, as review 3 built it: each
 *  background pixel ``base`` moved by 0 to 7 levels (toward white when
 *  ``sign`` is 1). */
function noisyDisc(seed: number, base: number, sign: 1 | -1, perChannel = false): Img {
  const next = rng(seed);
  const level = () => base + sign * Math.floor(next() * 8);
  return image(96, 96, (x, y) => {
    if (Math.hypot(x - 48, y - 48) < 20) return [...DISC, 255] as Px;
    if (perChannel) return [level(), level(), level(), 255];
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

  it('merges blacks noisy on each channel apart into one black, 40 of 40 and 200 of 200 (GM r8, round 6)', () => {
    // At ΔE00 3 alone, seed 167299 kept two blacks ΔE00 3.49 apart (#030403,
    // #050106), as did about 2-8% of random images: the neutral near-black
    // merge takes them, since noise blacks peak at C* 1.98.
    for (const seed of SEEDS_40) {
      const out = colors(noisyDisc(seed, 0, 1, true));
      expect(out, `seed ${seed}`).toHaveLength(2);
      expect(Math.max(...rgbOf(out[0]))).toBeLessThanOrEqual(7);
      expect(deltaE00(rgbOf(out[1]), DISC)).toBeLessThan(1);
    }
    const left = SEEDS_200.filter((seed) => colors(noisyDisc(seed, 0, 1, true)).length !== 2);
    expect(left).toEqual([]);
    // 240 palettes: about 1 s alone, so 30 s for a loaded machine.
  }, 30_000);

  it('gives exactly two for the disc on a noisy white (248-255)', () => {
    for (const seed of SEEDS) {
      const out = colors(noisyDisc(seed, 255, -1));
      expect(out, `seed ${seed}`).toHaveLength(2);
      expect(Math.min(...rgbOf(out[0]))).toBeGreaterThanOrEqual(248);
    }
  });

  it('keeps mid-tones just past the threshold apart, and merges them just under it', () => {
    const halves = (a: number[], b: number[]) => colors(image(96, 96, (x) => [...(x < 48 ? a : b), 255] as Px));
    expect(halves([120, 120, 120], [128, 128, 128])).toEqual(['#787878', '#808080']); // ΔE00 3.12
    expect(halves([120, 140, 160], [120, 140, 168])).toHaveLength(2); // ΔE00 3.31
    expect(halves([120, 140, 160], [120, 140, 167])).toHaveLength(1); // ΔE00 2.93
    expect(halves([120, 120, 120], [127, 127, 127])).toHaveLength(1); // ΔE00 2.73
    // Round 4's cases (ΔE00 1.96, 2.14, 2.35) are all under 3 now: one swatch each.
    for (const [a, b] of [[[120, 120, 120], [125, 125, 125]], [[120, 140, 160], [120, 140, 165]], [[120, 120, 120], [126, 126, 126]]]) {
      expect(halves(a, b)).toHaveLength(1);
    }
  });

  it("merges a dark photo's blacks and leaves its greys (cinematic-noir.webp at 96 px)", () => {
    // 7886a137 and b972eb9d gave #020202 #0e0e0e #1a1a1a #070707 #393939 #7f7f7f.
    // Round 6 showed the merged black as their mean, #070808; it is the most
    // populated of them now (GM r11), a black the image holds.
    expect(colors(fixture('cinematic-noir', 96))).toEqual(['#010101', '#1a1a1a', '#393939', '#7f7f7f']);
  });

  it('keeps the tinted darks and deep violets of three photos as round 5 gave them (GM r9 guards)', () => {
    // An L*-only floor merged a pair in each: C* 4.2 / 1.9 (cyberpunk-neon),
    // 5.0 / 3.0 (editorial-flash) and 22.9 / 15.0 (neon-alley).
    // Round 8: the big areas show their own pixel nearest the cluster's mean
    // (GM r15), under ΔE00 2.8 from round 5's means; every pair stays apart.
    expect(colors(fixture('cyberpunk-neon', 96))).toEqual(['#214a56', '#56828e', '#0a262b', '#071315', '#232a2e', '#020909']);
    expect(colors(fixture('editorial-flash', 77))).toEqual(['#d5d6ce', '#020802', '#0e140c', '#2b2f23', '#797a70']);
    expect(colors(fixture('neon-alley-9x16', 54))).toEqual(['#2a0f43', '#200d36', '#361452', '#170b2b', '#0d061f', '#00ffa0']);
  });

  it('gives studio-product.webp three: its two lightest whites merge (GM, round 5)', () => {
    // Round 4 gave #ededee #f9f9f9 #e1e0dd #b49d71; #ededee and #f9f9f9 are
    // ΔE00 2.52 apart and merge into #f2f2f3. #e1e0dd stays (3.5 and 5.5 away).
    // Round 8 (GM r15): #e1e0dd and #b49d71 show their own nearest pixels.
    expect(colors(fixture('studio-product', 96))).toEqual(['#f2f2f3', '#e1e0dc', '#b99c72']);
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
  const sizes: Record<string, string> = {
    'cinematic-noir': '96x54',
    'studio-product': '96x96',
    'cyberpunk-neon': '96x54',
    'editorial-flash': '77x96',
    'neon-alley-9x16': '54x96',
  };
  return resolve(__dirname, `fixtures/palette/${name}-${sizes[name]}.rgba`);
}

// GM r8 and r9 on #208 (round 6): the neutral near-black merge. Two swatches
// both under L* 6 AND both under C* 3 merge whatever their ΔE00.
describe('the neutral near-black merge', () => {
  const merged = (a: number[], b: number[]) => mergeNearColors([{ rgb: a, weight: 3 }, { rgb: b, weight: 1 }]);

  it('is L* under 6 and C* under 3, both strictly', () => {
    expect(NEUTRAL_NEAR_BLACK).toEqual({ maxL: 6, maxC: 3 });
    expect(isNeutralNearBlack([5.999, 0, 0])).toBe(true);
    expect(isNeutralNearBlack([6, 0, 0])).toBe(false);
    expect(isNeutralNearBlack([3, 2.999, 0])).toBe(true);
    expect(isNeutralNearBlack([3, 3, 0])).toBe(false);
    expect(isNeutralNearBlack([3, 0, -3])).toBe(false); // C* from a and b together
    expect(isNeutralNearBlack([3, 2.1, 2.1])).toBe(true); // C* 2.97
  });

  it('merges across the L* 6 edge only from below', () => {
    const partner = [10, 0, 2]; // L* 0.62, C* 2.90
    // L* 5.80, C* 2.76: ΔE00 8.48 apart, merged by the floor alone.
    expect(merged(partner, [15, 20, 17])).toHaveLength(1);
    // L* 6.19, C* 2.83: ΔE00 8.85, past the floor.
    expect(merged(partner, [15, 21, 19])).toHaveLength(2);
  });

  it('merges across the C* 3 edge only from below', () => {
    const partner = [10, 0, 2];
    expect(merged(partner, [11, 19, 18])).toHaveLength(1); // C* 2.96, L* 5.24, ΔE00 8.85
    expect(merged(partner, [11, 19, 17])).toHaveLength(2); // C* 3.15, L* 5.22, ΔE00 9.09
  });

  it('needs both swatches neutral near-blacks, not one', () => {
    const black = [0, 0, 0];
    expect(merged(black, [15, 21, 19])).toHaveLength(2); // the other over L* 6
    expect(merged([15, 21, 19], black)).toHaveLength(2);
    expect(merged(black, [11, 19, 17])).toHaveLength(2); // the other over C* 3
    expect(merged([11, 19, 17], black)).toHaveLength(2);
  });

  it('merges three neutral near-blacks, each pair over ΔE00 3, weights adding, into the most populated one', () => {
    const three = [[0, 0, 0], [0, 7, 2], [5, 0, 6]];
    expect(deltaE00(three[0], three[1])).toBeGreaterThan(3);
    expect(deltaE00(three[0], three[2])).toBeGreaterThan(3);
    expect(deltaE00(three[1], three[2])).toBeGreaterThan(3);
    const out = mergeNearColors([
      { rgb: three[0], weight: 5 },
      { rgb: three[1], weight: 3 },
      { rgb: three[2], weight: 2 },
      { rgb: [240, 120, 20], weight: 4 },
    ]);
    expect(out.map((c) => c.weight)).toEqual([10, 4]);
    // Round 6 showed their weighted mean, #010202; GM r11: the group's most
    // populated real black, here the heaviest.
    expect(out[0].rgb).toEqual([0, 0, 0]);
  });

  it("shows the most populated black, never #000 when the image has no #000 (GM r11)", () => {
    const out = mergeNearColors([
      { rgb: [12, 12, 12], weight: 2 },
      { rgb: [4, 4, 4], weight: 6 },
      { rgb: [9, 9, 12], weight: 3 },
      { rgb: [240, 120, 20], weight: 4 },
    ]);
    expect(out.map((c) => c.weight)).toEqual([11, 4]);
    expect(out[0].rgb).toEqual([4, 4, 4]);
    // The same in any order.
    const again = mergeNearColors([
      { rgb: [240, 120, 20], weight: 4 },
      { rgb: [9, 9, 12], weight: 3 },
      { rgb: [12, 12, 12], weight: 2 },
      { rgb: [4, 4, 4], weight: 6 },
    ]);
    expect(again[0]).toMatchObject({ rgb: [4, 4, 4], weight: 11 });
  });

  it('with pixels to read, shows the black most of the group’s pixels have', () => {
    // Two near-black clusters; at full resolution their pixels are mostly
    // #050505, in a flat area (GM r13: the full image names the colour).
    const footprint: EdgeEvidence['footprint'] = (swatch, visit) => {
      if (!swatch.includes(0) || !swatch.includes(1)) return;
      for (let i = 0; i < 12; i++) visit(5, 5, 5, () => true);
      for (let i = 0; i < 4; i++) visit(2, 2, 2, () => true);
    };
    const evidence: EdgeEvidence = { edge: () => 0, touching: () => false, footprint };
    const out = mergeNearColors([
      { rgb: [2, 2, 2], weight: 6, members: [0] },
      { rgb: [10, 10, 10], weight: 3, members: [1] },
      { rgb: [240, 120, 20], weight: 4, members: [2] },
    ], MERGE_DELTA_E, evidence);
    expect(out[0]).toMatchObject({ rgb: [5, 5, 5], weight: 9 });
  });

  it('keeps a black apart from a heavier grey that its group would otherwise take in', () => {
    // #0a0a0a (2) and #000 (1) are one black, kept #0a0a0a. #161616 (9) is
    // 2.70 from #0a0a0a but 4.28 from #000: taking it in would make it the
    // group's colour, 4.28 from a member.
    const out = mergeNearColors([
      { rgb: [10, 10, 10], weight: 2 },
      { rgb: [0, 0, 0], weight: 1 },
      { rgb: [22, 22, 22], weight: 9 },
    ]);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([[[22, 22, 22], 9], [[10, 10, 10], 3]]);
  });

  it("doesn't chain: each colour meets the rule against the kept black, not a neighbour", () => {
    // #000 (heaviest) and #121212 are neutral near-blacks; #141414 isn't
    // (L* 6.32). It is ΔE00 1.81 from #121212 and 3.72 from #000. Round 6
    // merged the blacks to their mean (#0a0a0a), 2.42 from #141414, and
    // then pulled it in too: one swatch of all three, #0b0b0b.
    const kept = [0, 0, 0];
    const near = [18, 18, 18];
    const grey = [20, 20, 20];
    expect(isNeutralNearBlack(rgbToLab(near))).toBe(true);
    expect(isNeutralNearBlack(rgbToLab(grey))).toBe(false);
    expect(deltaE00(near, grey)).toBeLessThan(3);
    expect(deltaE00(kept, grey)).toBeGreaterThan(3);
    const out = mergeNearColors([
      { rgb: kept, weight: 6 },
      { rgb: near, weight: 5 },
      { rgb: grey, weight: 4 },
    ]);
    expect(out.map((c) => [c.rgb, c.weight])).toEqual([[kept, 11], [grey, 4]]);
  });

  it('keeps a deep navy and a tinted dark apart from black', () => {
    const black = [0, 0, 0];
    expect(merged(black, [10, 14, 40])).toHaveLength(2); // navy: L* 4.80 but C* 18.7
    expect(merged(black, [14, 20, 12])).toHaveLength(2); // tinted dark: L* 5.60, C* 5.04
    expect(merged(black, [7, 19, 21])).toHaveLength(2); // cyberpunk-neon's #071315: C* 4.2
  });
});

describe('a run links only through accents that touch (GM r13, review 6 M3)', () => {
  it("doesn't let the edge between the line's ends link two accents into one band", () => {
    // Red and blue (each under 5%, so the first edge pass leaves this line),
    // a pink and a violet accent on their line, and the seam blend between
    // them, which touches both accents and is all edge. Round 7 linked pink,
    // seam and violet into one run, a band that folded as an edge: both
    // accents lost.
    const RED = [220, 20, 40];
    const BLUE = [20, 40, 200];
    const evidence: EdgeEvidence = {
      edge: (swatch) => (swatch.includes(4) ? 1 : 0),
      touching: (a, b) => {
        const pair = [a[0], b[0]].sort().join();
        return pair === '3,4' || pair === '4,5';
      },
    };
    const out = mergeNearColors([
      { rgb: [128, 128, 128], weight: 1000, members: [0] },
      { rgb: RED, weight: 40, members: [1] },
      { rgb: BLUE, weight: 40, members: [2] },
      { rgb: [170, 25, 80], weight: 5, members: [3] },
      { rgb: [120, 30, 120], weight: 5, members: [4] },
      { rgb: [70, 35, 160], weight: 5, members: [5] },
    ], MERGE_DELTA_E, evidence);
    const rgbs = out.map((c) => c.rgb.map(Math.round).join());
    expect(rgbs).toContain('170,25,80');
    expect(rgbs).toContain('70,35,160');
    // The seam folds on its own, as an edge.
    expect(rgbs).not.toContain('120,30,120');
  });

  it('lets the edge beside one accent join its run, so the accent counts its pixels', () => {
    // One pink accent with its antialiased edge (all edge) beside it: the
    // two are one run, a band that is no edge, shown in the accent's colour
    // with both weights.
    const evidence: EdgeEvidence = {
      edge: (swatch) => (swatch.includes(3) ? 0 : 1),
      touching: (a, b) => [a[0], b[0]].sort().join() === '3,4',
    };
    const out = mergeNearColors([
      { rgb: [128, 128, 128], weight: 1000, members: [0] },
      { rgb: [220, 20, 40], weight: 40, members: [1] },
      { rgb: [20, 40, 200], weight: 40, members: [2] },
      { rgb: [170, 25, 80], weight: 6, members: [3] },
      { rgb: [145, 27, 100], weight: 4, members: [4] },
    ], MERGE_DELTA_E, evidence);
    const pink = out.find((c) => c.rgb.map(Math.round).join() === '170,25,80');
    expect(pink).toMatchObject({ weight: 10 });
  });
});
