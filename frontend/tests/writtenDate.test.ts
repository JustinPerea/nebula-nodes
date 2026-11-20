import { describe, expect, it } from 'vitest';
import { writtenDate } from '../src/lib/commonsFormat';
import { writtenDateTime } from '../src/lib/writtenDateTime';
import { isRealCalendarDay } from '../src/lib/writtenDate';

const NOW = new Date(2026, 10, 20, 12, 0);

describe('written dates', () => {
  it('writes a real date out, with the year only when it is not the current one', () => {
    expect(writtenDate('2026-02-28', NOW)).toBe('February 28');
    expect(writtenDate('2025-12-31', NOW)).toBe('December 31, 2025');
    expect(writtenDateTime('2026-11-20T15:00:00', NOW)).toBe('November 20, 3:00 PM');
    expect(writtenDateTime('2026-11-20', NOW)).toBe('November 20');
  });

  it('keeps leap days: 2024-02-29 is real and 2026-02-29 is not', () => {
    expect(writtenDate('2024-02-29', NOW)).toBe('February 29, 2024');
    expect(writtenDate('2026-02-29', NOW)).toBe('2026-02-29');
    expect(isRealCalendarDay('2100-02-29')).toBe(false);
    expect(isRealCalendarDay('2000-02-29')).toBe(true);
  });

  it('reads an impossible day as it came instead of rolling into the next month', () => {
    for (const stored of ['2026-02-30', '2026-04-31', '2026-02-30T10:00:00', '2026-04-31T10:00:00Z', '2026-06-31']) {
      expect(writtenDate(stored, NOW)).toBe(stored);
      expect(writtenDateTime(stored, NOW)).toBe(stored);
    }
  });

  it('reads a non-date as it came, and null as empty', () => {
    expect(writtenDateTime('soon', NOW)).toBe('soon');
    expect(writtenDateTime(null, NOW)).toBe('');
    expect(writtenDateTime(undefined, NOW)).toBe('');
  });
});
