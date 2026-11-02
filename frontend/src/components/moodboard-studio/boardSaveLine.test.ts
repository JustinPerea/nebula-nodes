import { describe, expect, it } from 'vitest';
import { ConnectionLostError, RequestFailedError } from '../../lib/errorCopy';
import { MoodboardVersionConflict } from '../../lib/moodboardEdits';
import type { Moodboard } from '../../types';
import { boardNotSavedLine, boardSaveCause, isBoardNotSavedLine } from './boardSaveLine';

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
