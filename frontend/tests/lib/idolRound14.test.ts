// PR #203 round 14: GM r27 items 4 and 7, review 13 copy NIT-3.
import { describe, expect, it } from 'vitest';
import {
  DETAILS_DISCLOSURE,
  detailsDisclosure,
  NOT_READY_DISCLOSURE,
  mergedNotReadyLine,
  notReadyShown,
  type ProposalNotReady,
} from '../../src/lib/canvasProposals';
import { reasonFor } from '../helpers/notReadyReasons';

const row = (ref: string, name: string, person: string, extra: Partial<ProposalNotReady & { routeKeyLine: true }> = {}) =>
  ({ ref, nodeId: null, name, missing: `needs X (${ref})`, person, reason: reasonFor(person), ...extra });

const KREA = '“Krea 2” needs your Krea plan. Sign in to Krea in Settings.';

describe('same-named nodes say one line (GM, PR #203 r27 item 7)', () => {
  it('puts the count in front, with the reason’s own plural (round 15: from the backend’s table)', () => {
    expect(mergedNotReadyLine(['Krea 2', 'Krea 2'], reasonFor(KREA)!))
      .toBe('2 “Krea 2” nodes need your Krea plan. Sign in to Krea in Settings.');
    const notSetUp = { one: 'isn’t set up to run here yet. Check its provider in Settings.',
      many: 'aren’t set up to run here yet. Check their provider in Settings.' };
    expect(mergedNotReadyLine(['Idol', 'Idol', 'Idol'], notSetUp))
      .toBe('3 “Idol” nodes aren’t set up to run here yet. Check their provider in Settings.');
    // A route's own line has no reason: no merge.
    expect(reasonFor('You can run “Idol” after you add your Hugging Face token in Settings.')).toBeUndefined();
  });

  it('merges only the same name and the same reason, and keeps a line each otherwise', () => {
    const rows = [row('+a', 'Krea 2', KREA), row('+b', 'Krea 2', KREA),
      row('+c', 'Claude', '“Claude” needs your Anthropic API key. Add it in Settings.'),
      row('+d', 'Krea 2', '“Krea 2” needs your Krea API key. Add it in Settings.'),
      row('+e', 'Odd', 'Something else went wrong.'), row('+f', 'Odd', 'Something else went wrong.')];
    const { lines, inDetails } = notReadyShown(rows.slice(0, 3), null);
    expect(inDetails).toEqual([]);
    expect(lines.map((line) => line.text)).toEqual([
      '2 “Krea 2” nodes need your Krea plan. Sign in to Krea in Settings.',
      '“Claude” needs your Anthropic API key. Add it in Settings.',
    ]);
    const all = notReadyShown(rows, null);
    expect(all.lines.map((line) => line.text)).toEqual(['6 nodes can’t run here yet.']);
    expect(all.inDetails.map((line) => line.text)).toEqual([
      '2 “Krea 2” nodes need your Krea plan. Sign in to Krea in Settings.',
      '“Claude” needs your Anthropic API key. Add it in Settings.',
      '“Krea 2” needs your Krea API key. Add it in Settings.',
      'Something else went wrong.',
      'Something else went wrong.',
    ]);
  });
});

describe('the Accept line stays whatever the count (review 13, copy NIT-3)', () => {
  const ACCEPT = 'You can accept this after you add your Hugging Face token in Settings.';
  it.each([3, 4, 5])('keeps it in view with %i nodes', (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      row(`+${index}`, 'Idol', 'You can run “Idol” after you add your Hugging Face token in Settings.', { routeKeyLine: true }));
    const { lines } = notReadyShown(rows, ACCEPT);
    expect(lines.map((line) => line.text)).toEqual(count > 3 ? [`${count} nodes can’t run here yet.`, ACCEPT] : [ACCEPT]);
  });
});

describe('the details toggle (GM, PR #203 r26; r27 item 4)', () => {
  it.each([
    [{ list: true, changes: false, note: false }, NOT_READY_DISCLOSURE],
    [{ list: true, changes: true, note: false }, DETAILS_DISCLOSURE],
    [{ list: true, changes: false, note: true }, DETAILS_DISCLOSURE],
    [{ list: false, changes: true, note: false }, { closed: 'See what Accept writes', open: 'Hide what Accept writes' }],
    [{ list: false, changes: false, note: true }, { closed: 'Read the whole note', open: 'Hide the note' }],
  ])('names %j by what it holds', (holds, names) => {
    expect([detailsDisclosure(holds, false), detailsDisclosure(holds, true)]).toEqual([names.closed, names.open]);
  });

  it('says "Show the details" / "Hide the details" when it holds both', () => {
    expect(DETAILS_DISCLOSURE).toEqual({ closed: 'Show the details', open: 'Hide the details' });
  });
});
