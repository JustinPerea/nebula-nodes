// PR #200 fix round 23, review 19 NIT-1/2/3 (GM r34: approved as described):
// the heading cut keeps a straight quote that closes something, drops one
// that opens a word at the cut, never doubles a "…" the name already had,
// and never leaves a bare "…", even for a name of nothing but punctuation.
import { describe, expect, it } from 'vitest';
import { graphemesOf, noteHeading, noteHeadingName, wordCut } from '../src/lib/noteHeading';

/** The heading for `title` cut after `keep` graphemes, as fitNoteHeading cuts it (the word step-back included). */
const cutAt = (title: string, keep: number) => { const graphemes = graphemesOf(title); return noteHeading(title, wordCut(keep, graphemes), graphemes); };

describe('review 19 NIT-1: straight quotes', () => {
  it.each([
    ['A lighthouse "warm" and more', 19, 'Note for agents on “A lighthouse "warm"…”'],
    ['A lighthouse "warm" and more', 20, 'Note for agents on “A lighthouse "warm"…”'],
    ["The keepers' lamp at dusk", 12, 'Note for agents on “The keepers\'…”'],
    ["say 'hi' to the sea", 8, "Note for agents on “say 'hi'…”"],
  ])('a closing straight quote is kept: %j at %i', (title, keep, shown) => {
    expect(cutAt(title, keep)).toBe(shown);
  });

  it.each([
    ['A lighthouse "warm', 14, 'A lighthouse…'],
    ["A lighthouse 'warm", 14, 'A lighthouse…'],
    ['A — "x and more', 5, 'A…'],
    ['A ("x and more', 4, 'A…'],
  ])('one that opens a word at the cut goes: %j at %i', (title, keep, name) => {
    expect(noteHeadingName(title, keep)).toBe(`${name}`);
  });
});

describe('review 19 NIT-2: a "…" already in the name', () => {
  it('is not doubled', () => {
    expect(noteHeadingName('Lighthouse… at dusk', 11)).toBe('Lighthouse…');
    expect(cutAt('Lighthouse… wa and more', 13)).toBe('Note for agents on “Lighthouse…”');
    expect(noteHeadingName('Lighthouse... and more', 13)).toBe('Lighthouse…');
  });
});

describe('review 19 NIT-3: never a bare "…"', () => {
  it.each([
    [',,,,,,,,,,', 5, ',,,,,…'],
    [',,,,,,,,,,', 0, ',…'],
    ['…………', 2, '………'],
    ['-- -- --', 1, '-…'],
  ])('a name of only punctuation keeps a grapheme cut: %j at %i', (title, keep, name) => {
    expect(noteHeadingName(title, keep)).toBe(name);
    expect(noteHeading(title, keep)).not.toBe('Note for agents on “…”');
  });
});
