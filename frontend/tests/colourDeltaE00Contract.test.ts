import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { deltaE00, deltaE00Lab, EDGE_LINE_DELTA_E, MERGE_DELTA_E, rgbToLab } from '../src/lib/paletteExtract';

/** Extract from reference measures colour distance with a port of the
 * backend's CIEDE2000 (backend/commons/colour.py ``delta_e00`` on
 * cinema/color.py's Lab). contracts/fixtures/colour/delta_e00.json holds what
 * the backend computes (backend/tests/test_colour_delta_e00_contract.py checks
 * it there), so the two can't drift. */
const CONTRACT = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/colour/delta_e00.json'), 'utf8')) as {
  mergeDeltaE: number;
  rgbPairs: { a: number[]; b: number[]; labA: number[]; labB: number[]; deltaE00: number }[];
  labPairs: { a: number[]; b: number[]; deltaE00: number }[];
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

  it('gives the reference distance for the Sharma Lab pairs (every hue branch)', () => {
    expect(CONTRACT.labPairs.length).toBeGreaterThan(10);
    for (const c of CONTRACT.labPairs) expect(deltaE00Lab(c.a, c.b)).toBeCloseTo(c.deltaE00, 5);
  });

  it("uses the backend's merge threshold for the edge line and keeps its own, smaller, for merging", () => {
    expect(EDGE_LINE_DELTA_E).toBe(CONTRACT.mergeDeltaE);
    expect(MERGE_DELTA_E).toBe(2);
  });
});
