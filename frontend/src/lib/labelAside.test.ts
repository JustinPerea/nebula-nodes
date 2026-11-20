import { describe, expect, it } from 'vitest';
import { ASIDE_DOT, afterDot, aside } from './labelAside';

describe('aside', () => {
  it('joins a label and its note with an ordinary space before the dot and a no-break space after it', () => {
    expect(aside('Moodboard', 'optional')).toBe('Moodboard ·\u00a0optional');
    expect(aside(10, 'default')).toBe('10 ·\u00a0default');
    expect(ASIDE_DOT).toBe(' ·\u00a0');
  });

  it('has a breakable space before the dot and none after it', () => {
    const built = aside('Moodboard', 'optional');
    expect(built.charAt(built.indexOf('·') - 1)).toBe(' ');
    expect(built.charAt(built.indexOf('·') + 1)).toBe('\u00a0');
    expect(built.split(/ +/)).toEqual(['Moodboard', '·\u00a0optional']);
  });

  it('reads as the plain " · " form once whitespace is normalised', () => {
    expect(aside('Ambient', 'subtle').replace(/\s+/g, ' ')).toBe('Ambient · subtle');
  });
});

describe('afterDot', () => {
  it('starts the first word lower case', () => {
    expect(afterDot('Setup required')).toBe('setup required');
    expect(afterDot('Verified key')).toBe('verified key');
    expect(afterDot('Configured · not checked')).toBe('configured · not checked');
  });

  it('keeps an acronym, and a word with its own capitals', () => {
    expect(afterDot('API key saved')).toBe('API key saved');
    expect(afterDot('GPU busy')).toBe('GPU busy');
  });

  it('leaves an empty note alone', () => {
    expect(afterDot('')).toBe('');
  });
});
