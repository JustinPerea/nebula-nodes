import { describe, expect, it } from 'vitest';
import { PALETTE_CANT_RUN } from '../src/lib/paletteNotice';
import { SERVER_FAILED_LINE } from '../src/lib/personThreadBox';
import { projectRestoreFailedLine } from '../src/components/moodboard-studio/boardSaveLine';
import { endsInTryAgain, expectTryAgainLine } from './helpers/tryAgainLine';

// GM r23 on #208: a line shown with a [Try again] button ends in "Try
// again." (tests/helpers/tryAgainLine.ts, the shared assert). One row per
// line; a new line shown beside Try again adds its row here.
const ROWS: [where: string, line: string][] = [
  ["the Inspector palette's can't-run line (#208)", PALETTE_CANT_RUN],
  ["the Message box's send that the server didn't answer (GM r50)", SERVER_FAILED_LINE],
  // #210 round 6m (GM r53 Q1): Restore project's neutral failures, each beside its Try again.
  ["Restore project, the server isn't answering (#210)", projectRestoreFailedLine('Shore', 'noAnswer').text],
  ["Restore project, the server didn't accept it (#210)", projectRestoreFailedLine('Shore', 'refused').text],
];

describe('every line shown with Try again ends in "Try again."', () => {
  it.each(ROWS)('%s', (where, line) => {
    expectTryAgainLine(line, where);
  });

  it('pins the palette line', () => {
    expect(PALETTE_CANT_RUN).toBe('Nebula couldn’t extract the colors because the server isn’t answering. Try again.');
  });

  it('pins the Restore project lines; the red one (deleted for good) has no Try again, so it never ends in it', () => {
    expect(projectRestoreFailedLine('Shore', 'noAnswer').text).toBe('Nebula couldn’t restore “Shore” because the server isn’t answering. Try again.');
    expect(projectRestoreFailedLine('Shore', 'refused').text)
      .toBe('Nebula couldn’t restore “Shore” because the server didn’t accept the request. Try again.');
    expect(endsInTryAgain(projectRestoreFailedLine('Shore', 'purged', ['Rivers']).text)).toBe(false);
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
