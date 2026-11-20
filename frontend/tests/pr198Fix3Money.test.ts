import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chipEstimate, chipTitle, formatChipEstimate, formatUsd, formatUsdRange } from '../src/lib/pricing';

/**
 * PR #198, design's rulings:
 * - A high end that isn't a number never reads "~$0" ("$0" only means
 *   free), and an amount too small for figures reads "<$0.000001" on both
 *   sides (money.py usd_amount(5e-324) used to raise).
 * - "At least" says the low end as it is.
 * - No end of a detail line has a third figure.
 * - A range from under a cent reads "Up to $Y."
 */

const MONEY = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/money/cases.json'), 'utf8')) as {
  spent: { amount: number; text: string }[];
  amount: { amount: number; text: string }[];
};

describe('no "~$0" for an unknown high end', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number])('high %s', (high) => {
    // Design (PR #198): " + unpriced", led by the priced part.
    expect(formatChipEstimate(0.05, high, false)).toBe('$0.05 + unpriced');
    expect(chipTitle(chipEstimate(0.05, high, false))).toBe('The priced part of this run costs about $0.05.');
    expect(formatChipEstimate(0, high, false)).toBe('$0 + unpriced');
    expect(formatChipEstimate(0, high, false)).not.toBe('~$0');
  });
});

describe('amounts too small for figures', () => {
  it.each([5e-324, 1e-300, 9.9e-7])('%s reads "<$0.000001", never 300 figures or a throw', (amount) => {
    expect(formatUsd(amount)).toBe('<$0.000001');
    expect(formatUsdRange(amount, amount)).toBe('<$0.000001');
    // Design: a detail line writes each end in full.
    expect(formatUsdRange(amount, 0.43)).toBe('<$0.000001–$0.43');
  });

  it('the shared table holds them, so the backend writes the same', () => {
    const amounts = new Map(MONEY.amount.map((row) => [row.amount, row.text]));
    expect(amounts.get(5e-324)).toBe('<$0.000001');
    expect(amounts.get(1e-6)).toBe('$0.000001');
    expect(amounts.get(1.23e-6)).toBe('$0.0000012');
    for (const row of MONEY.amount) expect(formatUsd(row.amount), String(row.amount)).toBe(row.text);
  });

  it('as a property: tiny and denormal amounts never throw, and "~$0" only for nothing', () => {
    let seed = 3;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let index = 0; index < 5_000; index += 1) {
      const a = 10 ** (-random() * 330);
      const b = random() < 0.2 ? Number.NaN : 10 ** (-random() * 330 + 2);
      const chip = formatChipEstimate(Math.min(a, Number.isNaN(b) ? a : b), Number.isNaN(b) ? b : Math.max(a, b), random() < 0.5);
      expect(chip).not.toBe('~$0');
      expect(chip.length, chip).toBeLessThan(24);
      expect(formatUsd(a).length).toBeLessThan(16);
    }
  });
});

describe('chips and detail lines at a cent', () => {
  // Design: chips never show sub-cent precision; a low end
  // under a cent is "Up to $Y", so the chip and its tooltip say the same figure.
  it('a low end under a cent reads "Up to", in the chip and its tooltip', () => {
    expect(formatChipEstimate(0.0099, 0.0101, true)).toBe('Up to $0.01 + unpriced');
    expect(chipTitle(chipEstimate(0.0099, 0.0101, true))).toBe('The priced part of this run costs up to $0.01.');
  });

  it('two figures on each end of a detail line', () => {
    expect(formatUsdRange(0.0099, 0.0101)).toBe('$0.0099–$0.010');
    expect(formatUsdRange(0.01, 0.0149)).toBe('$0.010–$0.015');
    expect(formatUsdRange(0.04, 0.044)).toBe('$0.040–$0.044');
  });
});

describe('a range from under a cent (design)', () => {
  it('"Up to $Y." and, open, "The priced part of this run costs up to $Y."', () => {
    expect(chipTitle(chipEstimate(0.0047, 0.43, false))).toBe('Up to $0.43.');
    expect(chipTitle(chipEstimate(0.0047, 0.43, true))).toBe('The priced part of this run costs up to $0.43.');
    expect(chipTitle(chipEstimate(0.0047, 0.43, true))).not.toMatch(/less than/);
  });
});
