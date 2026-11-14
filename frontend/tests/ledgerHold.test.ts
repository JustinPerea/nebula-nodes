import { describe, expect, it } from 'vitest';
import {
  clockLabel, COUNTED_AS_USED_UP, holdOn, LEDGER_HOLD_SENTENCE, ledgerHoldLine, proposalHoldLine, withHoldLine,
} from '../src/lib/ledgerHold';

/** Epoch seconds and ms for a local date, so no test depends on the machine's zone. */
const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0, 0);
const seconds = (at: Date) => at.getTime() / 1000;

describe('the hold line', () => {
  it('keeps the fixed part GM wrote, with curly apostrophes', () => {
    expect(LEDGER_HOLD_SENTENCE).toBe(
      'Nebula couldn’t read its record of what agents have spent, so it counts every spending limit as used up until');
    expect(COUNTED_AS_USED_UP).toBe('Counted as used up');
  });

  it('says the time alone when it ends today', () => {
    const now = local(11, 14, 9, 5).getTime();
    expect(ledgerHoldLine({ until: seconds(local(11, 14, 15, 40)) }, now)).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM.`);
  });

  it('adds "tomorrow" when it ends on another date', () => {
    const now = local(11, 14, 15, 41).getTime();
    expect(ledgerHoldLine({ until: seconds(local(11, 15, 15, 40)) }, now)).toBe(`${LEDGER_HOLD_SENTENCE} 3:40 PM tomorrow.`);
    // Across a month end.
    expect(ledgerHoldLine({ until: seconds(local(12, 1, 0, 5)) }, local(11, 30, 23, 0).getTime()))
      .toBe(`${LEDGER_HOLD_SENTENCE} 12:05 AM tomorrow.`);
  });

  it('reads noon, midnight and a single-digit hour', () => {
    expect(clockLabel(local(11, 14, 12, 0))).toBe('12:00 PM');
    expect(clockLabel(local(11, 14, 0, 0))).toBe('12:00 AM');
    expect(clockLabel(local(11, 14, 9, 7))).toBe('9:07 AM');
    expect(clockLabel(local(11, 14, 13, 30))).toBe('1:30 PM');
    expect(clockLabel(local(11, 14, 23, 59))).toBe('11:59 PM');
  });

  it('has no line once the hold has ended, or with nothing to read', () => {
    const until = seconds(local(11, 14, 15, 40));
    expect(ledgerHoldLine({ until }, until * 1000)).toBeNull();
    expect(ledgerHoldLine({ until }, until * 1000 + 1)).toBeNull();
    expect(ledgerHoldLine(undefined, 0)).toBeNull();
    expect(ledgerHoldLine({ until: Number.NaN }, 0)).toBeNull();
    expect(holdOn({ until }, until * 1000 - 1)).toBe(true);
    expect(holdOn({ until }, until * 1000)).toBe(false);
  });
});

describe('a proposal\'s hold line', () => {
  const hold = { until: 2000, line: 'Nebula couldn’t read it.' };
  it('is the backend\'s sentence while the hold is on, then nothing', () => {
    expect(proposalHoldLine(hold, 1_999_999)).toBe(hold.line);
    expect(proposalHoldLine(hold, 2_000_000)).toBeNull();
    expect(proposalHoldLine(undefined, 0)).toBeNull();
    expect(proposalHoldLine({ until: 2000 }, 0)).toBeNull();
  });

  it('follows the text after one space', () => {
    expect(withHoldLine('This would pass the $5 daily total.', hold.line)).toBe('This would pass the $5 daily total. Nebula couldn’t read it.');
    expect(withHoldLine('Same.', null)).toBe('Same.');
  });
});
