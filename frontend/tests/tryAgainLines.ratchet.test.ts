import { describe, expect, it } from 'vitest';
import { PALETTE_CANT_RUN } from '../src/lib/paletteNotice';
import { CLOSE_NO_RESPONSE, closeBatchFailedLine, closeLineRetries, copyForStatus } from '../src/lib/errorCopy';
import { CommonsRequestError } from '../src/lib/commonsRequestError';
import { CLOSE_LINES } from './helpers/commonsCloseLines';

/** A close-batch failure as lib/commonsApi throws it (#204): its status and the backend's detail. */
const closeFailed = (status: number, detail?: string) => new CommonsRequestError(
  status === 0 ? "Nebula's server isn't answering. Make sure it's running, then try again." : copyForStatus(status, detail), status,
  { detail, heading: 'Couldn’t close the batch.' });
/** #204's close lines whose step is a retry: the close button beside them is that retry (GM r41).
 * Round 18o (review 18 logic LOW-6): taken from #204's own table (tests/helpers/commonsCloseLines),
 * every live row, each line as closeBatchFailedLine words it, plus the 30 s no-answer line; a new
 * live row is a row here with nothing to add by hand. The 429 line ends "Try again in a moment."
 * and stays in tests/commonsCopy.ratchet, outside this house form. */
const RETRY_IN_A_MOMENT = /Try again in a moment\.$/;
const LIVE_CLOSE_LINES = CLOSE_LINES.filter(([, , , , state]) => state === 'live');
const CLOSE_ROWS: [where: string, line: string][] = [
  ...LIVE_CLOSE_LINES.filter(([, , , line]) => !RETRY_IN_A_MOMENT.test(line))
    .map(([why, status, detail]): [string, string] => [`the close, ${why} (#204)`, closeBatchFailedLine(closeFailed(status, detail))]),
  ['the close, 30 s with no answer and the batch still open (#204)', CLOSE_NO_RESPONSE],
];
import { SERVER_FAILED_LINE } from '../src/lib/personThreadBox';
import { projectRestoreFailedLine } from '../src/components/moodboard-studio/boardSaveLine';
import { endsInTryAgain, expectTryAgainLine } from './helpers/tryAgainLine';

// GM r23 on #208: a line shown with a [Try again] button ends in "Try
// again." (tests/helpers/tryAgainLine.ts, the shared assert). One row per
// line; a new line shown beside Try again adds its row here.
const ROWS: [where: string, line: string][] = [
  ["the Inspector palette's can't-run line (#208)", PALETTE_CANT_RUN],
  ...CLOSE_ROWS,
  ["the Message box's send that the server didn't answer (GM r50)", SERVER_FAILED_LINE],
  // #210 round 6m (GM r53 Q1): Restore project's neutral failures, each beside its Try again.
  ["Restore project, the server isn't answering (#210)", projectRestoreFailedLine('Shore', 'noAnswer').text],
  ["Restore project, the server didn't accept it (#210)", projectRestoreFailedLine('Shore', 'refused').text],
];

describe('every line shown with Try again ends in "Try again."', () => {
  it.each(ROWS)('%s', (where, line) => {
    expectTryAgainLine(line, where);
  });

  it('#204: each close row is a retry line that leaves the close live (the lock rule stays in commonsCopy.ratchet)', () => {
    expect(CLOSE_ROWS.length).toBeGreaterThanOrEqual(11);
    // Every live row of #204's table is here but the 429's, worded as the table says.
    expect(LIVE_CLOSE_LINES.filter(([, , , line]) => RETRY_IN_A_MOMENT.test(line)).map(([, status]) => status)).toEqual([429]);
    for (const [why, status, detail, line] of LIVE_CLOSE_LINES) {
      if (status !== 429) expect(CLOSE_ROWS, why).toContainEqual([`the close, ${why} (#204)`, line]);
      expect(closeBatchFailedLine(closeFailed(status, detail)), why).toBe(line);
    }
    for (const [where, line] of CLOSE_ROWS) {
      expect(line.startsWith('Nebula couldn’t close the batch because '), where).toBe(true);
      expect(closeLineRetries(line), where).toBe(true);
    }
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
