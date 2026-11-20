import { describe, expect, it } from 'vitest';
import { ASIDE_DOT, aside } from './labelAside';

describe('aside', () => {
  it('joins a label and its note with a no-break space before the dot', () => {
    expect(aside('Moodboard', 'optional')).toBe('Moodboard\u00a0· optional');
    expect(aside(10, 'default')).toBe('10\u00a0· default');
    expect(ASIDE_DOT).toBe('\u00a0·');
  });

  it('reads as the plain " · " form once whitespace is normalised', () => {
    expect(aside('Ambient', 'subtle').replace(/\s+/g, ' ')).toBe('Ambient · subtle');
  });
});
