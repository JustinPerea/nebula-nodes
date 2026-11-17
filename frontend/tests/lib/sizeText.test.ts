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
  });
  it('shows a size and its limit only when they read differently', () => {
    expect(sizeAndLimit(530 * MB, 528 * MB)).toEqual({ size: '530 MB', limit: '528 MB' });
    expect(sizeAndLimit(528.03 * MB, 528 * MB)).toEqual({ size: null, limit: '528 MB' });
    expect(sizeAndLimit(3.02 * 1024 * MB, 3 * 1024 * MB)).toEqual({ size: null, limit: '3 GB' });
  });
});
