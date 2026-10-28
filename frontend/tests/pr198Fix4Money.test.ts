import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chipEstimate, chipLabel, chipTitle, formatChipEstimate, formatSpentUsd, formatUsd, formatUsdRange } from '../src/lib/pricing';

/**
 * PR #198 fix round 4: review 4's L2 and GM's money ruling (gm-pr198-r4.md):
 * "chips never show sub-cent precision. A range whose low end is under $0.01
 * → chip "Up to $0.01" with tooltip "Up to $0.01." ("Up to $0.01+" when some
 * costs unknown). Every other range: same decimals both ends ("$9.50–12.00",
 * not "$9.50–12")."
 * - A chip and its tooltip say the same figures.
 * - formatUsdRange never writes an end that isn't a number, or a high end
 *   under the low one ("$0.02–0.00", "$0.05–0.02").
 * - The parity fuzz: contracts/fixtures/money/fuzz.json, which the backend
 *   checks money.py against (backend/tests/test_money_fuzz_parity.py).
 */

const FUZZ = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/money/fuzz.json'), 'utf8')) as {
  rows: { amount: number; text: string; spent: string }[];
};

const UNKNOWN = "Some costs aren't known yet.";
const PLUS = ", plus costs that aren't known yet.";

const CHIPS: [number, number, boolean, string, string][] = [
  // Review 4, L2: the chip and its tooltip agree.
  [0.0049, 0.0101, true, 'Up to $0.01+', `Up to $0.01${PLUS}`],
  [0.0049, 0.0101, false, 'Up to $0.01', 'Up to $0.01.'],
  [0.0099, 0.0101, true, 'Up to $0.01+', `Up to $0.01${PLUS}`],
  [0.0047, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
  [0.0047, 0.43, true, 'Up to $0.43+', `Up to $0.43${PLUS}`],
  [0.0047, 12.4, false, 'Up to $12', 'Up to $12.'],
  // Under a cent at the top: as before.
  [0.0047, 0.0047, false, '<$0.01', 'Estimated cost under $0.01'],
  [0.0047, 0.0047, true, '<$0.01+', `Under $0.01 so far. ${UNKNOWN}`],
  // No sub-cent figures on a chip.
  [0.01, 0.0149, false, '~$0.01', 'Estimated cost'],
  [0.04, 0.044, false, '~$0.04', 'Estimated cost'],
  [0.044, 0.046, false, '$0.04–0.05', 'Between $0.04 and $0.05.'],
  [0.0123, 0.0123, true, '$0.01+', `At least $0.01. ${UNKNOWN}`],
  [0.05, 0.05, true, '$0.05+', `At least $0.05. ${UNKNOWN}`],
  [0.02, 0.43, true, '$0.02–0.43+', `Between $0.02 and $0.43${PLUS}`],
  // The same decimals on both ends.
  [9.5, 12, false, '$9.50–12.00', 'Between $9.50 and $12.00.'],
  [9.5, 1234.5, true, '$9.50–1,234.50+', `Between $9.50 and $1,234.50${PLUS}`],
  [12, 1234.5, false, '$12–1,235', 'Between $12 and $1,235.'],
  [9.996, 10.2, false, '~$10', 'Estimated cost'],
  // Free, and from nothing.
  [0, 0, false, '~$0', 'Estimated cost'],
  [0, 0.43, false, '$0–0.43', 'Between $0 and $0.43.'],
  [0, 0.044, false, '$0–0.04', 'Between $0 and $0.04.'],
  // A high end that isn't a number: the low end, with the rest unknown.
  [0.02, Number.NaN, false, '$0.02+', `At least $0.02. ${UNKNOWN}`],
  [0.0049, Number.NaN, false, '<$0.01+', `Under $0.01 so far. ${UNKNOWN}`],
];

describe('GM r4: the chips and their tooltips', () => {
  it.each(CHIPS)('%s–%s open=%s: "%s", titled "%s"', (low, high, open, label, title) => {
    expect(formatChipEstimate(low, high, open)).toBe(label);
    expect(chipTitle(chipEstimate(low, high, open))).toBe(title);
  });
});

/** The dollar figures a text says, as numbers ("$9.50–12.00" → [9.5, 12]). */
function figures(text: string): number[] {
  return [...text.matchAll(/\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g)].map((match) => Number(match[1].replace(/,/g, '')));
}

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('as properties', () => {
  const random = rng(4);
  const amount = () => {
    const pick = random();
    if (pick < 0.1) return 0;
    if (pick < 0.3) return random() * 0.03;
    if (pick < 0.45) return 0.09 + random() * 0.02;
    if (pick < 0.6) return 9.4 + random() * 1.2;
    if (pick < 0.65) return Number.NaN;
    return 10 ** (random() * 8 - 5);
  };

  it('a chip never shows sub-cent figures, mixes decimals, or says a figure its tooltip doesn\'t', () => {
    for (let index = 0; index < 12_000; index += 1) {
      const a = amount();
      const b = amount();
      const [low, high] = Number.isNaN(b) ? [a, b] : a <= b ? [a, b] : [b, a];
      const open = random() < 0.5;
      const chip = chipEstimate(low, high, open);
      const label = chipLabel(chip);
      const title = chipTitle(chip);
      const where = `${low} ${high} ${open} -> ${label} / ${title}`;
      // At most two decimals on any figure ("<$0.01" included).
      for (const match of label.matchAll(/\d+\.(\d+)/g)) expect(match[1].length, where).toBeLessThanOrEqual(2);
      const ends = label.replace(/^~|^Up to /, '').replace(/\+$/, '').split('–');
      // "$0–0.43" keeps its "$0" (GM r1: "$0" is the one way to write nothing).
      if (ends.length === 2 && ends[0] !== '$0') {
        const decimals = (text: string) => text.split('.')[1]?.length ?? 0;
        expect(decimals(ends[0]), where).toBe(decimals(ends[1]));
      }
      // The tooltip's figures are the chip's.
      const said = figures(label);
      for (const figure of figures(title)) expect(said, where).toContain(figure);
      if (label.startsWith('Up to')) expect(title, where).toMatch(/^Up to /);
      if (label === '~$0') expect(high, where).toBe(0);
    }
  }, 60_000);
});

describe('L2: formatUsdRange with an end that isn\'t a number', () => {
  it.each([
    [0.02, Number.NaN, '$0.02'],
    [0.02, Number.POSITIVE_INFINITY, '$0.02'],
    [0.02, undefined as unknown as number, '$0.02'],
    [0.05, 0.02, '$0.05'],
    [Number.NaN, Number.NaN, '$0'],
    [Number.NaN, 0.43, '$0–0.43'],
  ])('%s–%s reads %s', (low, high, text) => {
    expect(formatUsdRange(low, high)).toBe(text);
  });

  it('never "$0.02–0.00", whatever the high end', () => {
    for (const high of [Number.NaN, -1, 0, Number.NEGATIVE_INFINITY, 0.01, 0.019]) {
      expect(formatUsdRange(0.02, high)).not.toMatch(/–0\.00|–0\.01$/);
    }
  });

  it('a detail line keeps formatUsd\'s figures and N3\'s two per end', () => {
    expect(formatUsdRange(0.0099, 0.0101)).toBe('$0.0099–0.010');
    expect(formatUsdRange(0.0047, 0.43)).toBe('$0.0047–0.43');
  });
});

describe('the parity fuzz (contracts/fixtures/money/fuzz.json)', () => {
  it(`writes every one of the ${FUZZ.rows.length} amounts as money.py does`, () => {
    expect(FUZZ.rows.length).toBeGreaterThan(2000);
    const diffs = FUZZ.rows.filter((row) => formatUsd(row.amount) !== row.text || formatSpentUsd(row.amount) !== row.spent)
      .map((row) => ({ amount: row.amount, py: [row.text, row.spent], ts: [formatUsd(row.amount), formatSpentUsd(row.amount)] }));
    expect(diffs.slice(0, 10)).toEqual([]);
  });
});
