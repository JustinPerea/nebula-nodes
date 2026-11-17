import { describe, expect, it } from 'vitest';
import { sizeAndLimit, sizeText } from '../../src/lib/sizeText';

const MB = 1024 * 1024;

describe('sizeText', () => {
  it('drops a trailing .0 and keeps one decimal otherwise', () => {
    expect(sizeText(528 * MB)).toBe('528 MB');
    expect(sizeText(16.3 * MB)).toBe('16.3 MB');
    expect(sizeText(528.04 * MB)).toBe('528 MB');
  });
  it('writes GB from 1,024 MB with at most one decimal', () => {
    expect(sizeText(3072 * MB)).toBe('3 GB');
    expect(sizeText(1536 * MB)).toBe('1.5 GB');
    expect(sizeText(1023.9 * MB)).toBe('1023.9 MB');
    // The unit is chosen after rounding, and both sides round with integer arithmetic on the bytes (the backend's
    // size_text has the same cases): 1,127,428,915 bytes is 1.0499999998 GB, so "1 GB".
    expect(sizeText(1_127_428_915)).toBe('1 GB');
    // 1,073,741,823 bytes is 1023.999999 MB: it rounds to 1,024 MB, so it reads "1 GB", not "1024 MB".
    expect(sizeText(1_073_741_823)).toBe('1 GB');
    expect(sizeText(1_073_689_396)).toBe('1 GB');
    expect(sizeText(1_073_000_000)).toBe('1023.3 MB');
  });
  it('shows a size and its limit only when they read differently', () => {
    expect(sizeAndLimit(530 * MB, 528 * MB)).toEqual({ size: '530 MB', limit: '528 MB' });
    expect(sizeAndLimit(528.03 * MB, 528 * MB)).toEqual({ size: null, limit: '528 MB' });
    expect(sizeAndLimit(3.02 * 1024 * MB, 3 * 1024 * MB)).toEqual({ size: null, limit: '3 GB' });
  });
});
