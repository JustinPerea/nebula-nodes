import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writtenDate } from './commonsFormat';

// A fixed clock: the year rule never depends on the machine's date.
const NOW = new Date(2026, 10, 20, 9, 30);

// The day a timestamp reads as is the person's local one, so the cases that sit near midnight UTC
// pin the time zone. Where the runner can't change it (the check below), they are built from local
// parts instead, which holds in any zone.
const ZONE = 'America/Los_Angeles';
const savedZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

describe('writtenDate', () => {
  it('writes the month out and leaves the year off in the current year', () => {
    expect(writtenDate('2026-11-20', NOW)).toBe('November 20');
    expect(writtenDate('2026-12-31', NOW)).toBe('December 31');
    expect(writtenDate(new Date(2026, 0, 5, 12).toISOString(), NOW)).toBe('January 5');
  });

  it('adds the year when it is not the current one', () => {
    expect(writtenDate('2025-11-20', NOW)).toBe('November 20, 2025');
    expect(writtenDate(new Date(2027, 2, 9, 12).toISOString(), NOW)).toBe('March 9, 2027');
  });

  it('decides the year from the clock, not the machine', () => {
    expect(writtenDate('2026-11-20', new Date(2027, 0, 2))).toBe('November 20, 2026');
  });

  it('shows a timestamp as the local calendar day, not the UTC one', () => {
    // Local evening of December 31: stored as January 1 UTC (a zone behind UTC), still December 31 here.
    const evening = new Date(2026, 11, 31, 22, 30);
    expect(writtenDate(evening.toISOString(), NOW)).toBe('December 31');
    // Local morning of January 1: stored as December 31 UTC in a zone ahead of UTC, still January 1 here.
    const morning = new Date(2027, 0, 1, 0, 30);
    expect(writtenDate(morning.toISOString(), new Date(2027, 5, 1))).toBe('January 1');
  });

  it('compares the local year, not the UTC year, with the clock', () => {
    // 2027-01-01T02:00Z is still December 31, 2026 in Los Angeles: no year when it is 2026, a year when it is 2027.
    const stored = '2027-01-01T02:00:00Z';
    if (new Date(stored).getFullYear() === 2026) {
      expect(writtenDate(stored, new Date(2026, 11, 31, 18))).toBe('December 31');
      expect(writtenDate(stored, new Date(2027, 0, 1, 18))).toBe('December 31, 2026');
    } else {
      // The runner kept its own zone (which is at or ahead of UTC): the local date is January 1.
      expect(writtenDate(stored, new Date(2027, 0, 1, 18))).toBe('January 1');
    }
  });

  it('reads a date with no time as written, whatever the time zone', () => {
    expect(writtenDate('2026-11-20', NOW)).toBe('November 20');
    expect(writtenDate('2025-12-31', new Date(2026, 0, 1))).toBe('December 31, 2025');
  });

  it('returns a value with no date as it came', () => {
    expect(writtenDate('', NOW)).toBe('');
    expect(writtenDate('yesterday', NOW)).toBe('yesterday');
    expect(writtenDate('2026-13-01', NOW)).toBe('2026-13-01');
  });
});
