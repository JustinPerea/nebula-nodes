import { describe, expect, it } from 'vitest';
import {
  ACCESS_LOST_COPY, CONNECTION_LOST_COPY, ConnectionLostError, NO_RESPONSE_COPY, REFUSED_FALLBACK_COPY, TOO_LARGE_COPY,
  canTryAgain, copyForError, copyForStatus, failureKind, isConnectionFailure,
} from '../../src/lib/errorCopy';

/**
 * GM - Design (error-copy, 2026-10-22): "Never show raw error.message strings
 * in UI." A request that fails says one of GM's written lines, or the
 * backend's own 4xx `detail` (written copy). A 4xx with no detail says GM's
 * line for its status (the fallbacks GM wrote after the first build). The
 * table is GM's suggestion: error kind -> the line the person reads.
 */

const LOST = "Couldn't reach Nebula. Check your connection and try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";
const REFUSED = "That didn't work. Try again, or reload if it keeps happening.";
const ACCESS = "You don't have access to this anymore. Reload to sign in again.";
const TOO_LARGE = "That's too large to save.";

describe('the lines are GM\'s, verbatim', () => {
  it('lost connection and no response', () => {
    expect(CONNECTION_LOST_COPY).toBe(LOST);
    expect(NO_RESPONSE_COPY).toBe(NO_ANSWER);
  });
  it('a 4xx with no detail, 401/403 with no detail, 413 with no detail', () => {
    expect(REFUSED_FALLBACK_COPY).toBe(REFUSED);
    expect(ACCESS_LOST_COPY).toBe(ACCESS);
    expect(TOO_LARGE_COPY).toBe(TOO_LARGE);
  });
});

describe('error kind -> line', () => {
  const caller = new AbortController();
  caller.abort();
  const thrown: Array<[string, unknown, AbortSignal | undefined, string]> = [
    ['a fetch TypeError (no answer at all)', new TypeError('Failed to fetch'), undefined, LOST],
    ['Safari\'s fetch TypeError', new TypeError('Load failed'), undefined, LOST],
    ['an AbortError the caller didn\'t ask for', new DOMException('The operation was aborted.', 'AbortError'), undefined, LOST],
    ['a ConnectionLostError from apiFetch', new ConnectionLostError(new TypeError('Failed to fetch')), undefined, LOST],
    ['anything else says GM\'s general line, never its own message', new Error('Unexpected token < in JSON'), undefined, REFUSED],
    ['a thrown non-Error says it too', 'boom', undefined, REFUSED],
    ['the caller\'s own abort is not a lost connection either', new DOMException('aborted', 'AbortError'), caller.signal, REFUSED],
  ];
  it.each(thrown)('%s', (_name, error, signal, line) => {
    expect(copyForError(error, signal)).toBe(line);
  });

  it('the caller\'s own abort is not a lost connection', () => {
    expect(isConnectionFailure(new DOMException('aborted', 'AbortError'), caller.signal)).toBe(false);
  });

  const answered: Array<[number, unknown, string]> = [
    [0, undefined, LOST],
    [408, 'Request timed out', NO_ANSWER],
    [429, 'Too many requests', NO_ANSWER],
    [500, 'Internal Server Error', NO_ANSWER],
    [502, undefined, NO_ANSWER],
    [503, 'Commons request failed (503)', NO_ANSWER],
    [504, undefined, NO_ANSWER],
    [409, 'Labels changed in another window. Reload before saving.', 'Labels changed in another window. Reload before saving.'],
    [404, 'This batch is closed.', 'This batch is closed.'],
    [403, 'only the human UI session can do this', 'only the human UI session can do this'],
    [400, undefined, REFUSED],
    [400, '   ', REFUSED],
    [404, undefined, REFUSED],
    [409, '', REFUSED],
    [422, [{ loc: ['body', 'labels'], msg: 'field required', type: 'missing' }], REFUSED],
    [401, undefined, ACCESS],
    [403, undefined, ACCESS],
    [403, '  ', ACCESS],
    [413, undefined, TOO_LARGE],
    [413, [{ msg: 'too big' }], TOO_LARGE],
  ];
  it.each(answered)('HTTP %i (detail %j)', (status, detail, line) => {
    expect(copyForStatus(status, detail)).toBe(line);
  });
});

describe('what a second try can get past', () => {
  it.each([[0, 'connection'], [408, 'no-response'], [429, 'no-response'], [500, 'no-response'], [503, 'no-response']] as const)(
    'HTTP %i is %s and can be tried again', (status, kind) => {
      expect(failureKind(status)).toBe(kind);
      expect(canTryAgain(status)).toBe(true);
    });
  it.each([400, 401, 403, 404, 409, 422])('HTTP %i is a refusal the same request would get again', (status) => {
    expect(failureKind(status)).toBe('refused');
    expect(canTryAgain(status)).toBe(false);
  });
});

describe('ConnectionLostError keeps the original for debugging', () => {
  it('is still a TypeError, says the line, and carries the browser\'s error as its cause', () => {
    const original = new TypeError('Failed to fetch');
    const error = new ConnectionLostError(original);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(LOST);
    expect(error.status).toBe(0);
    expect(error.cause).toBe(original);
  });
});
