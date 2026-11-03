import { describe, expect, it } from 'vitest';
import { PALETTE_CANT_RUN } from '../src/lib/paletteNotice';
import { SERVER_FAILED_LINE } from '../src/lib/personThreadBox';
import { endsInTryAgain, expectTryAgainLine } from './helpers/tryAgainLine';

// GM r23 on #208: a line shown with a [Try again] button ends in "Try
// again." (tests/helpers/tryAgainLine.ts, the shared assert). One row per
// line; a new line shown beside Try again adds its row here.
const ROWS: [where: string, line: string][] = [
  ["the Inspector palette's can't-run line (#208)", PALETTE_CANT_RUN],
  ["the Message box's send that the server didn't answer (GM r50)", SERVER_FAILED_LINE],
];

describe('every line shown with Try again ends in "Try again."', () => {
  it.each(ROWS)('%s', (where, line) => {
    expectTryAgainLine(line, where);
  });

  it('pins the palette line', () => {
    expect(PALETTE_CANT_RUN).toBe('Nebula couldn’t extract the colors because the server isn’t answering. Try again.');
  });

  it('the assert tells the house form apart', () => {
    expect(endsInTryAgain('Nebula couldn’t extract the colors because the server isn’t answering. Try again.')).toBe(true);
    expect(endsInTryAgain('Nebula couldn’t extract the colors because the server isn’t answering.')).toBe(false);
    expect(endsInTryAgain('Nebula couldn’t extract the colors. Try again later.')).toBe(false);
    expect(endsInTryAgain('Nebula couldn’t extract the colors. Try again')).toBe(false);
    expect(endsInTryAgain('Nebula couldn’t extract the colorsTry again.')).toBe(false);
    expect(() => expectTryAgainLine('No ending.')).toThrow(/must end in "Try again\."/);
  });
});
