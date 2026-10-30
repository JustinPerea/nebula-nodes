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
  paid: [{}], cost: { low, high, lines: [{}], unpriced: open ? ['Kling'] : [], plus: [] },
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
  // GM, PR #198 r6 and r7 item 3: an open chip reads " + unpriced", and its
  // tooltip leads with the priced part (the reasons need the run's scope).
  // GM r8 (PR #198 round 6): no line for a free priced part; the reason leads.
  [0, 0, true, '$0 + unpriced', '“Kling” has no listed price.'],
  [0, 0.0047, false, '<$0.01', 'Estimated cost under $0.01'],
  [0.0047, 0.0047, false, '<$0.01', 'Estimated cost under $0.01'],
  [0.0047, 0.0047, true, '<$0.01 + unpriced', 'The priced part of this run costs under $0.01.'],
  // GM r6 item 2: a range from $0 reads "Up to $Y".
  [0, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
  [0, 0.43, true, 'Up to $0.43 + unpriced', 'The priced part of this run costs up to $0.43.'],
  // GM, PR #198 r3 item 6 and r4: a range from under a cent reads "Up to $Y",
  // in the chip and its tooltip (fix round 4: chips never show sub-cent figures).
  [0.0047, 0.43, false, 'Up to $0.43', 'Up to $0.43.'],
  [0.0047, 0.43, true, 'Up to $0.43 + unpriced', 'The priced part of this run costs up to $0.43.'],
  [0.0099, 0.0101, false, 'Up to $0.01', 'Up to $0.01.'],
  [0.0099, 0.0101, true, 'Up to $0.01 + unpriced', 'The priced part of this run costs up to $0.01.'],
  [0.009, 0.0104, false, 'Up to $0.01', 'Up to $0.01.'],
  [0.01, 0.0149, false, '~$0.01', 'Estimated cost'],
  [0.02, 0.43, true, '$0.02–0.43 + unpriced', 'The priced part of this run costs between $0.02 and $0.43.'],
  [0.05, 0.43, false, '$0.05–0.43', 'Between $0.05 and $0.43.'],
  [0.05, 0.05, true, '$0.05 + unpriced', 'The priced part of this run costs about $0.05.'],
  [0.05, 0.05, false, '~$0.05', 'Estimated cost'],
  [0.04, 0.044, false, '~$0.04', 'Estimated cost'],
  [0.0995, 0.1, false, '~$0.10', 'Estimated cost'],
  [9.996, 10.2, false, '~$10', 'Estimated cost'],
  // GM r4: the same decimals on both ends.
  [9.5, 12, false, '$9.50–12.00', 'Between $9.50 and $12.00.'],
];

/** The run chip and the proposal card write a closed $0 run as "$0": every
 * priced line is exactly 0 (Idol on its free Space), so it isn't an estimate
 * (GM, PR #203 r1). The shared formatter keeps "~$0". */
const runChip = (low: number, high: number, open: boolean, chip: string) =>
  (!open && low === 0 && high === 0 ? '$0' : chip);

describe('the chips and their tooltips (GM asks 1 and 2)', () => {
  it.each(CHIPS)('%s–%s open=%s: "%s", titled "%s"', (low, high, open, chip, title) => {
    expect(runChipLabel(summary(low, high, open))).toBe(runChip(low, high, open, chip));
    expect(formatChipEstimate(low, high, open)).toBe(chip);
    expect(runChipTitle(summary(low, high, open))).toBe(title);
  });

  it('the proposal card shows the same chip', () => {
    for (const [low, high, open, chip] of CHIPS) {
      const view = { run: ['n1'], cost: { estimate: { low, high, open } } } as never;
      expect(proposalEstimateLabel(view)).toBe(runChip(low, high, open, chip));
    }
  });

  it('a range says "between", "Up to" says "up to", and an open chip never ends in a bare "+"', () => {
    for (const [, , open, chip, title] of CHIPS) {
      if (chip.includes('–')) expect(title, chip).toMatch(open ? /^The priced part of this run costs between / : /^Between /);
      if (chip.startsWith('Up to')) expect(title, chip).toMatch(open ? /^The priced part of this run costs up to / : /^Up to /);
      expect(chip, chip).not.toMatch(/\d\+$/);
      if (open) expect(chip, chip).toMatch(/ \+ unpriced$/);
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
      const range = chip.replace(/^[~]/, '').replace(/ \+ unpriced$/, '').split('–');
      if (range.length === 2) {
        const [from, to] = range;
        expect(from.replace('$', ''), where).not.toBe(to);
        const decimals = (text: string) => text.split('.')[1]?.length ?? 0;
        const value = (text: string) => Number(text.replace(/[<$,]/g, ''));
        // The same decimals below $0.10, unless that would give an end a
        // third figure (review 3, N3: "$0.0099–0.010", as "$9.50–12"
        // changes at $10).
        const figures = (text: string) => text.replace(/[<$,.]/g, '').replace(/^0+/, '').length;
        if (!from.startsWith('<') && value(from) > 0 && value(from) < 0.1 && value(to) < 0.1 && decimals(from) !== decimals(to)) {
          expect(Math.min(figures(from), figures(to)), where).toBe(2);
          expect(Math.max(figures(from), figures(to)), where).toBeLessThanOrEqual(2);
        }
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
