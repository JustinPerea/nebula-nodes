import { describe, expect, it } from 'vitest';
import { ConnectionLostError, RequestFailedError } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';
import type { Moodboard } from '../../types';
import { boardSaveCause, boardSaveFailure, boardSaveLine, isBoardNotSavedLine, isCreateIdRefusal, joinWithAnd, keptFromBoardLine,
  lostAddLine } from './boardSaveLine';

const failed = (status: number, options: ConstructorParameters<typeof RequestFailedError>[2] = {}) =>
  new RequestFailedError("Couldn't save the board.", status, { reason: 'x', ...options });
const offline = () => new ConnectionLostError(new TypeError('Failed to fetch'));

// GM r16 (7a, 7b), verbatim.
const LINES = {
  noAnswer: 'Nebula couldn’t save the board because the server isn’t answering. Try again.',
  busy: 'Nebula couldn’t save the board because the server is busy. Try again.',
  noResponse: 'Nebula couldn’t save the board because the server didn’t respond. Try again.',
  serverError: 'Nebula couldn’t save the board because the server hit an error. Try again.',
  diskFull: 'Nebula couldn’t save the board because the disk is full. Free up some space, then try again.',
  tooLarge: 'Nebula couldn’t save the board because it’s too large. Remove some images, then try again.',
  signedOut: 'Nebula couldn’t save the board because you’re signed out. Reload to sign in again.',
  changed: 'Nebula couldn’t save the board because it changed somewhere else. Reload to get the latest version.',
  refused: 'Nebula couldn’t save the board because the server didn’t accept this save. Try again.',
};

describe('a board save that failed (GM r16 7a): the because form, ending with the step that works', () => {
  it.each([
    ['no answer', offline(), LINES.noAnswer, 'save'],
    ['a gateway with no backend behind it', failed(502), LINES.noAnswer, 'save'],
    ['429', failed(429), LINES.busy, 'save'],
    ['408', failed(408), LINES.noResponse, 'save'],
    ['503 with words', failed(503, { detail: 'Busy restarting' }), LINES.noResponse, 'save'],
    ['500', failed(500), LINES.serverError, 'save'],
    ['a 507 that is not the disk', failed(507, { detail: 'store unreadable', code: 'project_store' }), LINES.serverError, 'save'],
    ['a full disk', failed(507, { detail: 'No space left on device', storageFull: true, code: 'project_store' }), LINES.diskFull, 'save'],
    ['413', failed(413, { detail: 'Too big', storageLimit: 'storage' }), LINES.tooLarge, 'save'],
    ['403 (the person gate)', failed(403, { detail: 'This tab is not connected as the person.', code: 'person_required' }), LINES.signedOut, 'reload'],
    ['401', failed(401), LINES.signedOut, 'reload'],
    ['a conflict the rebase gave up on', new MoodboardVersionConflict({ version: 3 } as Moodboard), LINES.changed, 'reload'],
    ['a 409 version_conflict with no board', failed(409, { detail: 'Version 2 is behind 3', code: 'version_conflict' }), LINES.changed, 'reload'],
    ['422', failed(422, { detail: 'name must be a string' }), LINES.refused, 'save'],
    ['404 in the trash', failed(404, { detail: 'Moodboard x is in Recently deleted', code: 'in_trash' }), LINES.refused, 'save'],
    ['any other 409', failed(409, { detail: 'locked' }), LINES.refused, 'save'],
    ['an error that is not a request', new Error('anything'), LINES.refused, 'save'],
  ])('%s', (_label, error, reason, retry) => {
    expect(boardSaveLine(error)).toEqual({ failure: { heading: '', reason }, retry });
    expect(boardSaveFailure(error)).toEqual({ heading: '', reason });
    expect(reason.startsWith(`Nebula couldn’t save the board because ${boardSaveCause(error)}. `)).toBe(true);
    // Neutral: nothing is lost.
    expect(isBoardNotSavedLine(boardSaveFailure(error))).toBe(true);
    expect(reason).not.toMatch(/creat/i);
  });

  it('offers no Try again where the step is a reload, and a Try again everywhere else', () => {
    for (const [, reason] of Object.entries(LINES)) {
      expect(reason.includes('Reload')).toBe(!/[Tt]ry again/.test(reason));
    }
  });

  // GM r16: backend wording never reaches the person.
  it('never renders the server\'s own detail or reason, for any status or code (ratchet)', () => {
    const known = new Set(Object.values(LINES));
    const codes = [null, 'version_conflict', 'request_id_scope', 'in_trash', 'person_required', 'agent_refused', 'project_store', 'brief_override_protected', 'other'];
    for (let status = 400; status < 600; status += 1) {
      for (const code of codes) {
        for (const storageFull of [false, true]) {
          const error = failed(status, { detail: 'SENTINEL-DETAIL', reason: 'SENTINEL-REASON', code, storageFull });
          const { failure } = boardSaveLine(error);
          expect(JSON.stringify(failure)).not.toMatch(/SENTINEL/);
          expect(known.has(failure.reason)).toBe(true);
          expect(failure.heading).toBe('');
        }
      }
    }
    expect(JSON.stringify(boardSaveLine(new Error('SENTINEL-MESSAGE')))).not.toMatch(/SENTINEL/);
  });
});

describe('which line is the neutral one (GM r12 1, r16)', () => {
  it('is a board save line only: the lost add and any other line keep the error look', () => {
    expect(isBoardNotSavedLine(boardSaveFailure(failed(403)))).toBe(true);
    expect(isBoardNotSavedLine(lostAddLine(['a.png']))).toBe(false);
    expect(isBoardNotSavedLine({ heading: '', reason: 'Nebula didn’t respond. Try again.' })).toBe(false);
    expect(isBoardNotSavedLine({ heading: "Couldn't save the board.", reason: LINES.busy })).toBe(false);
    expect(isBoardNotSavedLine({ heading: '', reason: '' })).toBe(false);
    expect(isBoardNotSavedLine(LINES.busy)).toBe(false);
    expect(isBoardNotSavedLine(null)).toBe(false);
  });
});

describe('a create refused for its id (round 6g, GM r16 7b)', () => {
  it('says 7(b)\'s neutral line, the 409 for another project\'s id included', () => {
    const refusal = failed(422, { detail: "requestId must be 8 to 128 letters, digits, '-' or '_'" });
    expect(isCreateIdRefusal(refusal)).toBe(true);
    expect(boardSaveLine(refusal)).toEqual({ failure: { heading: '', reason: LINES.refused }, retry: 'save' });
    const scope = failed(409, { detail: 'This request id already made a board in another project (or in Global). Use a new request id for this board.', code: 'request_id_scope' });
    expect(isCreateIdRefusal(scope)).toBe(true);
    expect(boardSaveLine(scope)).toEqual({ failure: { heading: '', reason: LINES.refused }, retry: 'save' });
  });

  it('is only a 422 naming requestId or the 409 with its code', () => {
    expect(isCreateIdRefusal(failed(422, { detail: [{ loc: ['body', 'requestId'], msg: 'bad' }] }))).toBe(true);
    expect(isCreateIdRefusal(failed(422, { detail: 'name must be a string' }))).toBe(false);
    expect(isCreateIdRefusal(failed(400, { detail: 'requestId is wrong' }))).toBe(false);
    expect(isCreateIdRefusal(failed(422, { detail: 'requestIdentity' }))).toBe(false);
    expect(isCreateIdRefusal(new Error('requestId'))).toBe(false);
    expect(isCreateIdRefusal(failed(409, { detail: 'requestId', code: 'version_conflict' }))).toBe(false);
    expect(isCreateIdRefusal(failed(409, { detail: 'locked' }))).toBe(false);
  });
});

describe('joining names (GM r16): "and", no serial comma', () => {
  it('joins 0 to 4', () => {
    expect(joinWithAnd([])).toBe('');
    expect(joinWithAnd(['a'])).toBe('a');
    expect(joinWithAnd(['a', 'b'])).toBe('a and b');
    expect(joinWithAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinWithAnd(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
  });
});

describe('the red line for a truly lost add (GM r16 7a)', () => {
  it('names up to three files, then counts them', () => {
    expect(lostAddLine(['river.png'])).toEqual({ heading: '',
      reason: 'Nebula couldn’t add “river.png” because the board hadn’t loaded. Add it again.' });
    expect(lostAddLine(['river.png', 'dune.jpg']).reason)
      .toBe('Nebula couldn’t add “river.png” and “dune.jpg” because the board hadn’t loaded. Add them again.');
    expect(lostAddLine(['a.png', 'b.png', 'c.png']).reason)
      .toBe('Nebula couldn’t add “a.png”, “b.png” and “c.png” because the board hadn’t loaded. Add them again.');
    expect(lostAddLine(['a.png', 'b.png', 'c.png', 'd.png']).reason)
      .toBe('Nebula couldn’t add 4 images because the board hadn’t loaded. Add them again.');
    expect(lostAddLine([]).reason).toBe('Nebula couldn’t add the image because the board hadn’t loaded. Add it again.');
  });
});

describe('the "Kept …" line (round 6g, GM r16)', () => {
  it('names up to three fields joined with "and", then counts them', () => {
    expect(keptFromBoardLine([])).toBeNull();
    expect(keptFromBoardLine(['name'])).toBe('Kept the name from the board.');
    expect(keptFromBoardLine(['name', 'notes'])).toBe('Kept the name and notes from the board.');
    expect(keptFromBoardLine(['name', 'notes', 'mode'])).toBe('Kept the name, notes and mode from the board.');
    expect(keptFromBoardLine(['name', 'notes', 'mode', 'strength'])).toBe('Kept 4 changes from the board.');
  });

  it('names every board field as a noun after its one "the"', () => {
    expect(keptFromBoardLine(['direction', 'avoid', 'pinnedColors'])).toBe('Kept the direction, avoid list and pinned colors from the board.');
    expect(keptFromBoardLine(['briefOverride', 'clashMode', 'colorChoices'])).toBe('Kept the brief, clash setting and color choices from the board.');
    expect(keptFromBoardLine(['sendNotes', 'strength'])).toBe('Kept the notes setting and strength from the board.');
  });
});
