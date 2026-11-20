import { describe, expect, it } from 'vitest';
import { writtenDate } from './commonsFormat';

// A fixed clock: the year rule never depends on the machine's date.
const NOW = new Date(2026, 10, 20, 9, 30);

describe('writtenDate', () => {
  it('writes the month out and leaves the year off in the current year', () => {
    expect(writtenDate('2026-11-20', NOW)).toBe('November 20');
    expect(writtenDate('2026-01-05T08:00:00Z', NOW)).toBe('January 5');
    expect(writtenDate('2026-12-31', NOW)).toBe('December 31');
  });

  it('adds the year when it is not the current one', () => {
    expect(writtenDate('2025-11-20', NOW)).toBe('November 20, 2025');
    expect(writtenDate('2027-03-09T23:59:59-08:00', NOW)).toBe('March 9, 2027');
  });

  it('decides the year from the clock, not the machine', () => {
    expect(writtenDate('2026-11-20', new Date(2027, 0, 2))).toBe('November 20, 2026');
  });

  it('reads the stored day as written, whatever the time zone', () => {
    expect(writtenDate('2026-11-20T23:30:00-11:00', NOW)).toBe('November 20');
    expect(writtenDate('2026-11-20T00:10:00+13:00', NOW)).toBe('November 20');
  });

  it('returns a value with no date as it came', () => {
    expect(writtenDate('', NOW)).toBe('');
    expect(writtenDate('yesterday', NOW)).toBe('yesterday');
    expect(writtenDate('2026-13-01', NOW)).toBe('2026-13-01');
  });
});
