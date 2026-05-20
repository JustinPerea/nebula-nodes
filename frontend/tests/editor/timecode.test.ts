import { describe, it, expect } from 'vitest';
import { formatSmpte, parseSmpte } from '../../src/lib/editor/timecode';

describe('formatSmpte', () => {
  it('formats 0s at 30fps as 00:00:00:00', () => {
    expect(formatSmpte(0, 30)).toBe('00:00:00:00');
  });
  it('formats 1.5s at 30fps as 00:00:01:15', () => {
    expect(formatSmpte(1.5, 30)).toBe('00:00:01:15');
  });
  it('formats 65.5s at 30fps as 00:01:05:15', () => {
    expect(formatSmpte(65.5, 30)).toBe('00:01:05:15');
  });
  it('handles 24fps', () => {
    expect(formatSmpte(1.5, 24)).toBe('00:00:01:12');
  });
});

describe('parseSmpte', () => {
  it('round-trips with formatSmpte', () => {
    expect(parseSmpte('00:01:05:15', 30)).toBeCloseTo(65.5, 5);
  });
  it('returns NaN for invalid input', () => {
    expect(parseSmpte('not valid', 30)).toBeNaN();
  });
});
