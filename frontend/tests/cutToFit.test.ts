import { describe, expect, it } from 'vitest';
import { cutToFit } from '../src/lib/cutToFit';

/** A fake space that holds `n` characters. */
const holds = (n: number) => (candidate: string) => candidate.length <= n;

describe('cutToFit', () => {
  it('returns the whole text when it fits', () => {
    expect(cutToFit('Is the logo visible?', holds(20))).toBe('Is the logo visible?');
  });

  it('cuts at the last word that fits, with the real ellipsis', () => {
    const out = cutToFit('Is the logo clearly visible in the corner', holds(19));
    expect(out).toBe('Is the logo…');
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('...');
  });

  it('keeps the longest prefix that still fits', () => {
    expect(cutToFit('aa bb cc dd', holds(9))).toBe('aa bb cc…');
    expect(cutToFit('aa bb cc dd', holds(8))).toBe('aa bb…');
  });

  it('trims trailing spaces and , ; : before the ellipsis', () => {
    expect(cutToFit('Is it red, blue; green: or none', holds(13))).toBe('Is it red…');
    expect(cutToFit('Is it red,  blue; green: or none', holds(12))).toBe('Is it red…');
    expect(cutToFit('one; two: three', holds(5))).toBe('one…');
  });

  it('cuts by characters when a single word is longer than the space', () => {
    expect(cutToFit('abcdefghijklmnop', holds(6))).toBe('abcde…');
    expect(cutToFit('abcdefghijklmnop rest', holds(6))).toBe('abcde…');
  });

  it('shows just the ellipsis when not even one character fits', () => {
    expect(cutToFit('abcdef', holds(1))).toBe('…');
  });

  it('returns empty text as it is, without asking', () => {
    let asked = 0;
    expect(cutToFit('', () => { asked += 1; return false; })).toBe('');
    expect(asked).toBe(0);
  });

  it('does not ask about every word of a long text', () => {
    const text = Array.from({ length: 512 }, (_, i) => `w${i}`).join(' ');
    let asked = 0;
    cutToFit(text, (c) => { asked += 1; return c.length <= 100; });
    expect(asked).toBeLessThan(20);
  });
});
