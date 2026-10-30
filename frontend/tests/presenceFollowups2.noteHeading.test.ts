// PR #200 follow-up 2, review 20 NIT-5: a name made only of "…" showed
// "………" when cut. The heading never leaves a run of "…".
import { describe, expect, it } from 'vitest';
import { fitNoteHeading, noteHeading, noteHeadingName } from '../src/lib/noteHeading';

describe('review 20 NIT-5: never a run of "…"', () => {
  it.each([
    ['…………', 2, '…'],
    ['…………', 0, '…'],
    ['……………………………………', 7, '…'],
    ['……a b', 1, '…a…'],
    [',,…,,,,', 3, ',,…'],
  ])('%j cut at %i shows %j', (title, keep, name) => {
    expect(noteHeadingName(title, keep)).toBe(name);
    expect(noteHeading(title, keep)).not.toMatch(/……/);
  });

  it('a fit of a long all-"…" name has a single "…"', () => {
    const title = '…'.repeat(200);
    const heading = fitNoteHeading(title, 120, (text) => text.length * 6);
    expect(heading).toBe('Note for agents on “…”');
  });

  it('other punctuation names are as before', () => {
    expect(noteHeadingName(',,,,,,,,,,', 5)).toBe(',,,,,…');
    expect(noteHeadingName('-- -- --', 1)).toBe('-…');
  });
});

// GM, PR #202 r1: a name made only of "…" keeps its single "…" (it is the
// name, in quotes); no truncation "…" is ever added after it, and no type-name
// fallback replaces it.
describe('GM PR #202 r1: a name made only of "…"', () => {
  it('a one-"…" name shows as itself, whole or squeezed to any width', () => {
    expect(noteHeading('…')).toBe('Note for agents on “…”');
    for (const width of [0, 10, 60, 120, 400]) {
      const heading = fitNoteHeading('…', width, (text) => text.length * 6);
      expect(heading).toBe('Note for agents on “…”');
    }
  });

  it('a cut never puts a truncation "…" after a name\'s own "…"', () => {
    for (const title of ['……', '…………', '…'.repeat(80)]) {
      for (let keep = 0; keep < Math.min(title.length, 12); keep += 1) {
        expect(noteHeadingName(title, keep)).toBe('…');
      }
      expect(fitNoteHeading(title, 120, (text) => text.length * 6)).not.toMatch(/……/);
    }
  });
});

// PR #202 review 1 NIT-5: the fold applies in every branch of the cut, so a
// kept part never shows a run of the name's own "…", and a cut that reaches
// the name's end shows it whole, with no truncation "…" after it.
describe('PR #202 review 1 NIT-5: the "…" fold in every branch of the cut', () => {
  it.each([
    ['“……”', 1, '“…”'],
    ['"……"x', 2, '"…"x'],
    ['a……b c d e f', 5, 'a…b…'],
    ['a…………b c d e f', 7, 'a…b…'],
    ['……a b', 1, '…a…'],
    ['…', 0, '…'],
  ])('%s cut at %i shows %s', (title, keep, shown) => {
    expect(noteHeadingName(title, keep)).toBe(shown);
  });

  it('no cut of any width leaves a run of "…", and the tooltip keeps the name whole', () => {
    for (const title of ['“……”', '"……"x', 'a……b c d e f', '…… a lighthouse …… prompt']) {
      for (let keep = 0; keep < [...title].length; keep += 1) expect(noteHeadingName(title, keep)).not.toMatch(/……/);
    }
    expect(noteHeading('a……b')).toBe('Note for agents on “a……b”');
  });
});
