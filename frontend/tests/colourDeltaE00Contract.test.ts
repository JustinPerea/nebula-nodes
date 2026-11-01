import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deltaE00, deltaE00Lab, EDGE_LINE_DELTA_E, MERGE_DELTA_E, rgbToLab } from '../src/lib/paletteExtract';

/** Extract from reference measures colour distance with a port of the
 * backend's CIEDE2000 (backend/commons/colour.py ``delta_e00`` on
 * cinema/color.py's Lab). contracts/fixtures/colour/delta_e00.json holds what
 * the backend computes (backend/tests/test_colour_delta_e00_contract.py checks
 * it there), so the two can't drift, and for its Lab pairs the values published
 * by Sharma, Wu and Dalal (2005) and an independent CIEDE2000, so a bug both
 * sides share fails too. */
const CONTRACT = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/colour/delta_e00.json'), 'utf8')) as {
  mergeDeltaE: number;
  rgbPairs: { a: number[]; b: number[]; labA: number[]; labB: number[]; deltaE00: number }[];
  labPairs: { a: number[]; b: number[]; deltaE00: number; sharmaPair?: number; published?: number; independent?: number }[];
};

describe('CIEDE2000 matches the backend', () => {
  it('converts sRGB to Lab as cinema.color does', () => {
    for (const c of CONTRACT.rgbPairs) {
      rgbToLab(c.a).forEach((v, i) => expect(v).toBeCloseTo(c.labA[i], 5));
      rgbToLab(c.b).forEach((v, i) => expect(v).toBeCloseTo(c.labB[i], 5));
    }
  });

  it('gives the backend distance for every sRGB pair', () => {
    expect(CONTRACT.rgbPairs.length).toBeGreaterThan(20);
    for (const c of CONTRACT.rgbPairs) expect(deltaE00(c.a, c.b)).toBeCloseTo(c.deltaE00, 5);
  });

  it('gives the backend distance for every Lab pair (every hue branch)', () => {
    expect(CONTRACT.labPairs.length).toBeGreaterThan(10);
    for (const c of CONTRACT.labPairs) expect(deltaE00Lab(c.a, c.b)).toBeCloseTo(c.deltaE00, 5);
  });

  it('gives the published distance for all 34 Sharma, Wu and Dalal (2005) pairs', () => {
    const sharma = CONTRACT.labPairs.filter((c) => c.published !== undefined);
    expect(sharma.map((c) => c.sharmaPair)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    for (const c of sharma) {
      expect(Math.abs(deltaE00Lab(c.a, c.b) - c.published!), `Sharma pair ${c.sharmaPair}`).toBeLessThanOrEqual(1e-4);
    }
  });

  it('takes both hue wraps away from zero chroma as an independent CIEDE2000 does (review 4 N1)', () => {
    const wraps = CONTRACT.labPairs.filter((c) => c.independent !== undefined);
    expect(wraps.length).toBe(2);
    for (const c of wraps) expect(Math.abs(deltaE00Lab(c.a, c.b) - c.independent!)).toBeLessThanOrEqual(1e-4);
  });

  it("uses the backend's merge threshold for the edge line and keeps its own, smaller, for merging", () => {
    expect(EDGE_LINE_DELTA_E).toBe(CONTRACT.mergeDeltaE);
    expect(MERGE_DELTA_E).toBe(3);
  });
});
