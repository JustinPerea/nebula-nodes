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
