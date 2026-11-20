import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSummaryText, writtenDateTime, writtenDay, writtenTime } from './commonsFormat';

// A fixed clock, and local-time inputs so the cases hold in any zone.
const NOW = new Date(2026, 10, 20, 9, 30);

const savedZone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

describe('writtenDateTime', () => {
  it('writes the month out, with the time and no seconds, and no year in the current one', () => {
    expect(writtenDateTime(new Date(2026, 10, 20, 3, 0, 45).toISOString(), NOW)).toBe('November 20, 3:00 AM');
    expect(writtenDateTime(new Date(2026, 0, 5, 15, 7).toISOString(), NOW)).toBe('January 5, 3:07 PM');
  });

  it('adds the year when it is not the current one', () => {
    expect(writtenDateTime(new Date(2025, 10, 20, 3, 0).toISOString(), NOW)).toBe('November 20, 2025, 3:00 AM');
  });

  it('reads midnight as 12:00 AM and noon as 12:00 PM', () => {
    expect(writtenDateTime(new Date(2026, 10, 20, 0, 0).toISOString(), NOW)).toBe('November 20, 12:00 AM');
    expect(writtenDateTime(new Date(2026, 10, 20, 12, 0).toISOString(), NOW)).toBe('November 20, 12:00 PM');
  });

  it('takes a Date or a millisecond count', () => {
    expect(writtenDateTime(new Date(2026, 10, 20, 3, 0), NOW)).toBe('November 20, 3:00 AM');
    expect(writtenDateTime(new Date(2026, 10, 20, 3, 0).getTime(), NOW)).toBe('November 20, 3:00 AM');
  });

  it('writes a date with no time as the date alone', () => {
    expect(writtenDateTime('2026-11-20', NOW)).toBe('November 20');
  });

  it('reads a value that is not a date as it came, and null or undefined as nothing', () => {
    expect(writtenDateTime('yesterday', NOW)).toBe('yesterday');
    expect(writtenDateTime(null, NOW)).toBe('');
    expect(writtenDateTime(undefined, NOW)).toBe('');
    expect(writtenDateTime('', NOW)).toBe('');
  });
});

describe('writtenTime', () => {
  it('writes the time of day with no seconds', () => {
    expect(writtenTime(new Date(2026, 10, 20, 15, 4, 59).toISOString())).toBe('3:04 PM');
    expect(writtenTime(new Date(2026, 10, 20, 0, 0).toISOString())).toBe('12:00 AM');
  });

  it('reads a non-date and null as nothing', () => {
    expect(writtenTime('soon')).toBe('');
    expect(writtenTime(null)).toBe('');
  });
});

describe('scanSummaryText', () => {
  it('puts the count first and reads known keys in a fixed order', () => {
    expect(scanSummaryText({ unchanged: 4, added: 3, changed: 2 })).toBe('3 added · 2 changed');
    // Unchanged files are not news: a rescan that found nothing reads "nothing new".
    expect(scanSummaryText({ added: 0, changed: 0, unchanged: 120 })).toBe('nothing new');
  });

  it('leaves out a zero, and reads "nothing new" when every count is zero', () => {
    expect(scanSummaryText({ added: 0, changed: 1, missing: 0 })).toBe('1 changed');
    expect(scanSummaryText({ added: 0, unchanged: 0, failed: [], truncated: false })).toBe('nothing new');
    expect(scanSummaryText({})).toBe('nothing new');
  });

  it('counts the failed list and spaces an unknown key', () => {
    expect(scanSummaryText({ failed: [{ rel_path: 'a', error: 'x' }, { rel_path: 'b', error: 'y' }], added: 1 })).toBe('1 added · 2 failed');
    expect(scanSummaryText({ added: 1, moved_away: 2 })).toBe('1 added · 2 moved away');
  });

  it('reads no summary as not scanned yet', () => {
    expect(scanSummaryText(null)).toBe('Not scanned yet');
  });
});

describe('writtenDay', () => {
  it('writes a Date out, with the year only when it is not the current one', () => {
    expect(writtenDay(new Date(2026, 10, 20, 3), NOW)).toBe('November 20');
    expect(writtenDay(new Date(2025, 0, 5, 3), NOW)).toBe('January 5, 2025');
  });
});
