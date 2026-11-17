import { describe, expect, it } from 'vitest';
import rules from '../../scripts/copy-lint-rules.json';
import { becauseLine } from '../src/lib/errorCopy';

/**
 * A reason that opens with a provider's or an app's name is a clause ("… because Krea is busy."); one that
 * opens with a plain capitalised word is a sentence of its own. errorCopy keeps its own short list of name
 * first words (the lint's list is too big for the startup bundle), so this test fails when the lint learns a
 * name that errorCopy doesn't know: add it to NAME_LEADS in src/lib/errorCopy.ts, or to the list below when it
 * is an option's label that no reason opens with.
 */
describe('a reason that opens with a known name follows "because"', () => {
  const names = (rules as { properNames: string[] }).properNames;
  /** Names that are option labels or list titles, never the subject of a reason. */
  const NEVER_LEAD_A_REASON = new Set(['Kodak Portra', 'Recently deleted', 'Illusio', 'Sharpy', 'Redefine only', 'English', 'Teal & Orange']);

  it('covers every name in the copy lint\'s proper names', () => {
    const missing = names.filter((name) => !NEVER_LEAD_A_REASON.has(name)
      && /^\p{Lu}/u.test(name)
      && !becauseLine({ heading: 'Couldn’t run the node.', reason: `${name} is busy.` }).includes(' because '));
    expect(missing).toEqual([]);
  });

  it('still treats a plain capitalised word as a sentence of its own', () => {
    expect(becauseLine({ heading: 'Couldn’t upload “a.png”.', reason: 'File exceeds 500 MB limit' }))
      .toBe('Nebula couldn’t upload “a.png”. File exceeds 500 MB limit.');
  });
});
