import { describe, expect, it } from 'vitest';
import { ConnectionLostError, RequestFailedError } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';
import type { Moodboard } from '../../types';
import { CREATE_ID_REFUSED_LINE, boardNotSavedLine, boardSaveCause, boardSaveFailure, isBoardNotSavedLine, isCreateIdRefusal } from './boardSaveLine';

const failed = (status: number, detail?: unknown) => new RequestFailedError("Couldn't save the board.", status, { reason: 'x', detail });

describe('a background send that failed again on reconnect (GM r11 4)', () => {
  it('says the line verbatim, as one reason with no heading', () => {
    expect(boardNotSavedLine(failed(429))).toEqual({ heading: '',
      reason: 'Nebula couldn’t save the board because the server is busy. Try again.' });
  });

  it('names the cause with the server as its subject', () => {
    expect(boardSaveCause(new ConnectionLostError(new TypeError('Failed to fetch')))).toBe('the server isn’t answering');
    expect(boardSaveCause(failed(502))).toBe('the server isn’t answering');
    expect(boardSaveCause(failed(503, 'Busy restarting'))).toBe('the server didn’t respond');
    expect(boardSaveCause(failed(408))).toBe('the server didn’t respond');
    expect(boardSaveCause(failed(429))).toBe('the server is busy');
    expect(boardSaveCause(failed(500))).toBe('the server hit an error');
    expect(boardSaveCause(failed(403))).toBe('you don’t have access to this anymore');
    expect(boardSaveCause(failed(422))).toBe('the server didn’t accept it');
    expect(boardSaveCause(new MoodboardVersionConflict({ version: 3 } as Moodboard))).toBe('the board changed in another window');
    expect(boardSaveCause(new Error('anything'))).toBe('the server didn’t accept it');
  });
});

describe('which line is the neutral one (GM r12 1)', () => {
  it('is boardNotSavedLine\'s line only: any other failure keeps the error look', () => {
    expect(isBoardNotSavedLine(boardNotSavedLine(failed(429)))).toBe(true);
    expect(isBoardNotSavedLine(boardNotSavedLine(new ConnectionLostError(new TypeError('Failed to fetch'))))).toBe(true);
    expect(isBoardNotSavedLine({ heading: '', reason: 'Nebula didn’t respond. Try again.' })).toBe(false);
    expect(isBoardNotSavedLine({ heading: "Couldn't save the board.", reason: 'Nebula couldn’t save the board because the server is busy. Try again.' })).toBe(false);
    expect(isBoardNotSavedLine({ heading: '', reason: '' })).toBe(false);
    expect(isBoardNotSavedLine('Nebula couldn’t save the board because the server is busy. Try again.')).toBe(false);
    expect(isBoardNotSavedLine(null)).toBe(false);
  });
});

describe('a failed create (round 6f, GM r14)', () => {
  it('is the save line: the same words, never "create"', () => {
    for (const error of [new ConnectionLostError(new TypeError('Failed to fetch')), failed(429), failed(500), failed(503, 'Busy'),
      failed(400, 'Bad board'), failed(422, 'name must be a string'), failed(401), new Error('offline')]) {
      expect(boardSaveFailure(error)).toEqual(boardNotSavedLine(error));
      expect(isBoardNotSavedLine(boardSaveFailure(error))).toBe(true);
      expect(JSON.stringify(boardSaveFailure(error))).not.toMatch(/creat/i);
    }
  });

  it('keeps the error look for a 422 that refused the create\'s id: sent again, it fails the same way', () => {
    const refusal = failed(422, "requestId must be 8 to 128 letters, digits, '-' or '_'");
    expect(isCreateIdRefusal(refusal)).toBe(true);
    expect(isBoardNotSavedLine(boardSaveFailure(refusal))).toBe(false);
    expect(boardSaveFailure(refusal)).toEqual({ heading: '', reason: CREATE_ID_REFUSED_LINE });
    // The because form, no "Try again" (round 6g, 7b).
    expect(CREATE_ID_REFUSED_LINE).toMatch(/^Nebula couldn’t save the board because /);
    expect(CREATE_ID_REFUSED_LINE).not.toMatch(/Try again/);
    // FastAPI's own field list naming it counts too; a 422 on anything else, or another status naming it, doesn't.
    expect(isCreateIdRefusal(failed(422, [{ loc: ['body', 'requestId'], msg: 'bad' }]))).toBe(true);
    expect(isCreateIdRefusal(failed(422, 'name must be a string'))).toBe(false);
    expect(isCreateIdRefusal(failed(400, 'requestId is wrong'))).toBe(false);
    expect(isCreateIdRefusal(failed(422, 'requestIdentity'))).toBe(false);
    expect(isCreateIdRefusal(new Error('requestId'))).toBe(false);
    // An id another project's board was made with: the backend's 409 with its code (round 6g); any other 409 isn't.
    const scope = new RequestFailedError("Couldn't save the board.", 409, { detail: 'This request id already made a board in another project (or in Global). Use a new request id for this board.', code: 'request_id_scope' });
    expect(isCreateIdRefusal(scope)).toBe(true);
    expect(boardSaveFailure(scope)).toEqual({ heading: '', reason: CREATE_ID_REFUSED_LINE });
    expect(isCreateIdRefusal(new RequestFailedError("Couldn't save the board.", 409, { detail: 'requestId', code: 'version_conflict' }))).toBe(false);
    expect(isCreateIdRefusal(new RequestFailedError("Couldn't save the board.", 409, { detail: 'locked' }))).toBe(false);
  });
});
