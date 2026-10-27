import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatChipEstimate, formatSpentUsd, formatUsd, formatUsdRange } from '../src/lib/pricing';
import { runChipLabel, runChipTitle, type RunScopeSummary } from '../src/lib/runScope';
import { proposalEstimateLabel } from '../src/lib/canvasProposals';

/**
 * PR #198 fix round 2, review 2's L4 and GM's asks 1-2 (gm-pr198-r2.md).
 * One money formatter: the backend (services/money.py) and this side read the
 * same table (contracts/fixtures/money/cases.json). The chips never say
 * "<$0.01–0.01", "$0.10–0.10", "$10.00–10", "$0.000" or "$-0.00".
 */

const MONEY = JSON.parse(readFileSync(resolve(__dirname, '../../contracts/fixtures/money/cases.json'), 'utf8')) as {
  spent: { amount: number; text: string }[];
  amount: { amount: number; text: string }[];
};

const summary = (low: number, high: number, open: boolean) => ({
  paid: [{}], cost: { low, high, lines: [{}], unpriced: open ? [{}] : [], plus: [] },
}) as unknown as RunScopeSummary;

describe('one money formatter (L4)', () => {
  it.each(MONEY.spent)('spent $amount reads $text, as the backend writes it', ({ amount, text }) => {
    expect(formatSpentUsd(amount)).toBe(text);
  });
  it.each(MONEY.amount)('an amount of $amount reads $text, as the backend writes it', ({ amount, text }) => {
    expect(formatUsd(amount)).toBe(text);
  });
});

/** Every chip form, its tooltip (GM's asks 1 and 2), as built. */
const CHIPS: [number, number, boolean, string, string | undefined][] = [
  [0, 0, false, '~$0', 'Estimated cost'],
  [0, 0, true, '$0+', "Some costs aren't known yet."],
  [0, 0.0047, false, '<$0.01', 'Estimated cost under $0.01'],
  [0.0047, 0.0047, false, '<$0.01', 'Estimated cost under $0.01'],
  [0.0047, 0.0047, true, '<$0.01+', "Under $0.01 so far. Some costs aren't known yet."],
  [0, 0.43, false, '$0–0.43', 'Between $0 and $0.43.'],
  [0, 0.43, true, '$0–0.43+', "Between $0 and $0.43, plus costs that aren't known yet."],
  [0.0047, 0.43, false, '<$0.01–0.43', 'Between less than $0.01 and $0.43.'],
  [0.0047, 0.43, true, '<$0.01–0.43+', "Between less than $0.01 and $0.43, plus costs that aren't known yet."],
  [0.0099, 0.0101, false, '~$0.01', 'Estimated cost'],
  [0.0099, 0.0101, true, '$0.01+', "At least $0.01. Some costs aren't known yet."],
  [0.009, 0.0104, false, '~$0.01', 'Estimated cost'],
  [0.01, 0.0149, false, '$0.010–0.015', 'Between $0.010 and $0.015.'],
  [0.02, 0.43, true, '$0.02–0.43+', "Between $0.02 and $0.43, plus costs that aren't known yet."],
  [0.05, 0.43, false, '$0.05–0.43', 'Between $0.05 and $0.43.'],
  [0.05, 0.05, true, '$0.05+', "At least $0.05. Some costs aren't known yet."],
  [0.05, 0.05, false, '~$0.05', 'Estimated cost'],
  [0.04, 0.044, false, '$0.040–0.044', 'Between $0.040 and $0.044.'],
  [0.0995, 0.1, false, '~$0.10', 'Estimated cost'],
  [9.996, 10.2, false, '~$10', 'Estimated cost'],
  [9.5, 12, false, '$9.50–12', 'Between $9.50 and $12.'],
];

describe('the chips and their tooltips (GM asks 1 and 2)', () => {
  it.each(CHIPS)('%s–%s open=%s: "%s", titled "%s"', (low, high, open, chip, title) => {
    expect(runChipLabel(summary(low, high, open))).toBe(chip);
    expect(formatChipEstimate(low, high, open)).toBe(chip);
    expect(runChipTitle(summary(low, high, open))).toBe(title);
  });

  it('the proposal card shows the same chip', () => {
    for (const [low, high, open, chip] of CHIPS) {
      const view = { run: ['n1'], cost: { estimate: { low, high, open } } } as never;
      expect(proposalEstimateLabel(view)).toBe(chip);
    }
  });

  it('"At least" only for a single-number "$X+" chip; a range always says "Between"', () => {
    for (const [low, high, open, chip, title] of CHIPS) {
      const range = chip.includes('–');
      if (range) expect(title, chip).toMatch(/^Between /);
      if (title?.startsWith('At least')) expect(chip, chip).toMatch(/^\$[\d.]+\+$/);
      void low; void high; void open;
    }
  });
});

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('the formatter, as properties (L4)', () => {
  const random = rng(198);
  const amount = () => {
    const pick = random();
    if (pick < 0.15) return 0;
    if (pick < 0.3) return random() * 0.02;
    if (pick < 0.45) return 0.09 + random() * 0.02;
    if (pick < 0.6) return 9.9 + random() * 0.2;
    return 10 ** (random() * 6 - 4);
  };

  it('no chip says "<$0.01–0.01", repeats an end, mixes decimals below $0.10, or shows "$0.000" / "$-"', () => {
    for (let index = 0; index < 20_000; index += 1) {
      const a = amount();
      const b = amount();
      const [low, high] = a <= b ? [a, b] : [b, a];
      const open = random() < 0.5;
      const chip = formatChipEstimate(low, high, open);
      const where = `${low} ${high} ${open} -> ${chip}`;
      expect(chip, where).not.toMatch(/\$-|\$0\.000(?!\d*[1-9])|<\$0\.01–0\.01\b/);
      const range = chip.replace(/^[~]/, '').replace(/\+$/, '').split('–');
      if (range.length === 2) {
        const [from, to] = range;
        expect(from.replace('$', ''), where).not.toBe(to);
        const decimals = (text: string) => text.split('.')[1]?.length ?? 0;
        const value = (text: string) => Number(text.replace(/[<$,]/g, ''));
        if (!from.startsWith('<') && value(from) > 0 && value(from) < 0.1 && value(to) < 0.1) expect(decimals(from), where).toBe(decimals(to));
        // "$0.10–0.10" and "$10.00–10" collapse to one figure.
        expect(value(from), where).not.toBe(value(to));
      }
      expect(runChipTitle(summary(low, high, open)), where).toBeTruthy();
      if (chip === '~$0') expect(high, where).toBe(0);
    }
  });

  it('formatUsd never shows "$0" for a non-zero amount, nor two texts for one rounded value', () => {
    for (let index = 0; index < 20_000; index += 1) {
      const a = amount();
      const text = formatUsd(a);
      if (a > 0) expect(text, String(a)).not.toBe('$0');
      expect(text, String(a)).not.toMatch(/^\$0\.1$|^\$10\.00$|^\$\d+\.\d0{2,}$/);
      expect(formatUsdRange(a, a)).toBe(text);
    }
    expect(formatSpentUsd(-0.001)).toBe('$0.00');
    expect(formatUsd(-0.001)).toBe('$0');
    expect(formatUsd(Number.NaN)).toBe('$0');
  });
});
