import { describe, expect, it } from 'vitest';
import { PALETTE_CANT_RUN } from '../src/lib/paletteNotice';
import { CLOSE_NO_RESPONSE, closeBatchFailedLine, closeLineRetries, copyForStatus } from '../src/lib/errorCopy';
import { CommonsRequestError } from '../src/lib/commonsRequestError';

/** A close-batch failure as lib/commonsApi throws it (#204): its status and the backend's detail. */
const closeFailed = (status: number, detail?: string) => new CommonsRequestError(
  status === 0 ? "Nebula's server isn't answering. Make sure it's running, then try again." : copyForStatus(status, detail), status,
  { detail, heading: 'Couldn’t close the batch.' });
/** #204's close lines whose step is a retry: the close button beside them is that retry (GM r41).
 * The 429 line ends "Try again in a moment." and stays in tests/commonsCopy.ratchet, outside this
 * house form. */
const CLOSE_ROWS: [where: string, line: string][] = [
  ['the close, no answer in time (503) (#204)', closeBatchFailedLine(closeFailed(503))],
  ['the close, a gateway (502) (#204)', closeBatchFailedLine(closeFailed(502))],
  ['the close, a gateway timeout (504) (#204)', closeBatchFailedLine(closeFailed(504))],
  ['the close, a request timeout (408) (#204)', closeBatchFailedLine(closeFailed(408))],
  ['the close, the server\'s own error (500) (#204)', closeBatchFailedLine(closeFailed(500, 'Internal Server Error'))],
  ['the close, 501 (#204)', closeBatchFailedLine(closeFailed(501))],
  ['the close, no answer at all (#204)', closeBatchFailedLine(closeFailed(0))],
  ['the close, a 409 reason not listed (#204)', closeBatchFailedLine(closeFailed(409, 'Try again, or reload if it keeps happening.'))],
  ['the close, another 4xx (422) (#204)', closeBatchFailedLine(closeFailed(422))],
  ['the close, another 4xx (415) (#204)', closeBatchFailedLine(closeFailed(415, 'Content-Type must be application/json'))],
  ['the close, 30 s with no answer and the batch still open (#204)', CLOSE_NO_RESPONSE],
];
import { endsInTryAgain, expectTryAgainLine } from './helpers/tryAgainLine';

// GM r23 on #208: a line shown with a [Try again] button ends in "Try
// again." (tests/helpers/tryAgainLine.ts, the shared assert). One row per
// line; a new line shown beside Try again adds its row here.
const ROWS: [where: string, line: string][] = [
  ["the Inspector palette's can't-run line (#208)", PALETTE_CANT_RUN],
  ...CLOSE_ROWS,
];

describe('every line shown with Try again ends in "Try again."', () => {
  it.each(ROWS)('%s', (where, line) => {
    expectTryAgainLine(line, where);
  });

  it('#204: each close row is a retry line that leaves the close live (the lock rule stays in commonsCopy.ratchet)', () => {
    expect(CLOSE_ROWS.length).toBe(11);
    for (const [where, line] of CLOSE_ROWS) {
      expect(line.startsWith('Nebula couldn’t close the batch because '), where).toBe(true);
      expect(closeLineRetries(line), where).toBe(true);
    }
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
