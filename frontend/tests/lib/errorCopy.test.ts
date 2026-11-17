import { afterEach, describe, expect, it, vi } from 'vitest';
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

const LOST = "Nebula’s server isn’t answering. Make sure it’s running, then try again.";
const NO_ANSWER = "Nebula didn’t respond. Try again.";
const REFUSED = "Try again, or reload if it keeps happening.";
const ACCESS = "You don’t have access to this anymore. Reload to sign in again.";
const TOO_LARGE = "That’s too large to save.";

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
    // typeerror (2026-10-24): fetch's no-answer is classified where fetch is
    // called (apiFetch, fetchUrl); a TypeError that reaches here unclassified
    // is the browser's own failure, so GM's general line.
    ['a TypeError nothing classified, even with fetch\'s words', new TypeError('Failed to fetch'), undefined, REFUSED],
    ['Safari\'s words, unclassified', new TypeError('Load failed'), undefined, REFUSED],
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
    [409, 'Labels changed in another tab. Reload before saving.', 'Labels changed in another tab. Reload before saving.'],
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

/**
 * Round 2 (GM - Design, error-copy round 2): an error from a request carries
 * its parts. The heading names what failed ("Couldn't save the moodboard."), the
 * reason line says why (GM's lines, the backend's written reason, or GM's
 * fallback for the status), and its kind. `message` is the one-line form
 * "<heading> <reason>" for alerts, toasts and status text. GM's WRAP rule:
 * "when the surface already has a retry button, the reason line drops its
 * 'try again'. The button is the retry."
 */
describe('round 2: heading + reason + kind', async () => {
  const copy = await import('../../src/lib/errorCopy');
  const HEADING = "Couldn’t save the moodboard.";
  const WHAT = 'save the moodboard';
  const line = (clause: string) => `Nebula couldn’t ${WHAT} because ${clause}`;

  it('the other round 2 lines, verbatim', () => {
    expect(copy.BACKEND_NOT_RUNNING_COPY).toBe("Nebula’s backend isn’t running. Start it, then reload.");
  });

  // [status, detail, bare reason, the line on its own, the line beside a Try again button, kind]
  const table: Array<[number, unknown, string, string, string, string]> = [
    [0, undefined, LOST, line('the server isn’t answering. Check that Nebula is running, then try again.'),
      line('the server isn’t answering. Try again.'), 'connection'],
    [408, 'Request timed out', NO_ANSWER, line('the server didn’t respond. Try again.'), line('the server didn’t respond. Try again.'), 'no-response'],
    [429, undefined, NO_ANSWER, line('the server is busy. Try again in a moment.'), line('the server is busy. Try again.'), 'no-response'],
    [500, 'Internal Server Error', NO_ANSWER, line('the server hit an error. Try again.'), line('the server hit an error. Try again.'), 'no-response'],
    [503, undefined, NO_ANSWER, line('the server didn’t respond. Try again.'), line('the server didn’t respond. Try again.'), 'no-response'],
    [409, 'This moodboard changed in another tab.', 'This moodboard changed in another tab.',
      line('this moodboard changed in another tab.'), line('this moodboard changed in another tab.'), 'refused'],
    // The 4xx fallback keeps its "Try again, or reload" on its own and ends in the button's "Try again." beside one.
    [400, undefined, REFUSED, line('the server didn’t accept it. Try again, or reload if it keeps happening.'),
      line('the server didn’t accept it. Try again.'), 'refused'],
    [422, [{ loc: ['body', 'images', 0, 'url'], msg: 'field required' }], REFUSED,
      line('the server didn’t accept it. Try again, or reload if it keeps happening.'), line('the server didn’t accept it. Try again.'), 'refused'],
    [403, undefined, ACCESS, line('you don’t have access to this anymore. Reload to sign in again.'),
      line('you don’t have access to this anymore. Reload to sign in again.'), 'refused'],
    [413, undefined, TOO_LARGE, line('it’s too large.'), line('it’s too large.'), 'refused'],
  ];
  it.each(table)('HTTP %i (detail %j): heading, reason, the line alone and beside a button, kind', (status, detail, reason, alone, button, kind) => {
    const error = new copy.RequestFailedError(HEADING, status, { detail });
    expect(error.heading).toBe(HEADING);
    expect(error.reason).toBe(reason);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.detail).toEqual(detail);
    expect(error.message).toBe(alone);
    expect(copy.failureCopy(error)).toEqual({ heading: '', reason: alone, button, cause: reason, what: WHAT, status });
    expect(copy.failureCopy(error, { short: true })).toEqual({ heading: '', reason: button, button, cause: reason, what: WHAT, status });
  });

  it('a lost connection named by its action keeps the browser\'s error and stays a TypeError', () => {
    const original = new TypeError('Failed to fetch');
    const error = new copy.ConnectionLostError(original).withHeading("Couldn’t load your API keys.");
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(copy.ConnectionLostError);
    expect(error.cause).toBe(original);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Nebula couldn’t load your API keys because the server isn’t answering. Check that Nebula is running, then try again.');
    expect(copy.failureCopy(error, { short: true }).reason)
      .toBe('Nebula couldn’t load your API keys because the server isn’t answering. Try again.');
  });

  it('withHeading names a lost connection, and leaves anything else (the caller\'s abort) as it was', () => {
    const lost = copy.withHeading(new copy.ConnectionLostError(new TypeError('x')), "Couldn’t cancel the run.");
    expect((lost as Error).message).toBe('Nebula couldn’t cancel the run because the server isn’t answering. Check that Nebula is running, then try again.');
    const abort = new DOMException('aborted', 'AbortError');
    expect(copy.withHeading(abort, "Couldn’t cancel the run.")).toBe(abort);
  });

  it('a failure that isn\'t a request\'s says the general line under the heading the screen gives it', () => {
    const general = line('the server didn’t accept it. Try again, or reload if it keeps happening.');
    expect(copy.failureCopy(new Error('Unexpected token <'), { heading: HEADING })).toEqual({ heading: '', reason: general,
      button: line('the server didn’t accept it. Try again.'), cause: REFUSED, what: WHAT });
    expect(copy.failureCopy(new copy.ConnectionLostError(new TypeError('Failed to fetch')), { heading: HEADING, short: true }).reason)
      .toBe(line('the server isn’t answering. Try again.'));
    expect(copy.failureMessage(new Error('boom'), HEADING)).toBe(general);
    expect(copy.failureMessage(new copy.RequestFailedError(HEADING, 503), "Couldn’t do it.")).toBe(line('the server didn’t respond. Try again.'));
  });

  it('a reason with no heading stands alone', () => {
    expect(new copy.RequestFailedError('', 503).message).toBe(NO_ANSWER);
  });
});

describe('round 2: requestError reads the answer and keeps the status in the console', async () => {
  const copy = await import('../../src/lib/errorCopy');
  afterEach(() => { vi.restoreAllMocks(); copy.resetFailureWarningsForTests(); });

  it('reads the backend\'s detail; a FastAPI field list is no reason (GM\'s fallback), kept in detail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = [{ loc: ['body', 'images', 0, 'url'], msg: 'field required' }];
    const error = await copy.requestError("Couldn't save the moodboard.",
      new Response(JSON.stringify({ detail: list }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
    expect(error.message).toBe('Nebula couldn’t save the moodboard because the server didn’t accept it. Try again, or reload if it keeps happening.');
    expect(error.detail).toEqual(list);
    const reasoned = await copy.requestError("Couldn't move the moodboard.",
      new Response(JSON.stringify({ detail: 'That project is gone.' }), { status: 404 }));
    expect(reasoned.message).toBe('Nebula couldn’t move the moodboard because that project is gone.');
  });

  it('warns once with the status and raw detail, not on every identical failure, and again after a success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fail = () => copy.requestError("Couldn't check Codex status.", new Response(JSON.stringify({ detail: 'boom' }), { status: 503 }));
    await fail(); await fail(); await fail();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/503/);
    expect(String(warn.mock.calls[0].join(' '))).toMatch(/boom/);
    copy.requestSucceeded("Couldn't check Codex status.");
    await fail();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// shortLine is gone: a line beside a Try again button is built as becauseLine(parts, 'button'), and besideButton
// swaps the ending of a line that is already in the because form.
describe('round 2: the ending beside a retry button', () => {
  it('swaps the closing step for the button\'s own, and leaves anything else', async () => {
    const { becauseLine, besideButton } = await import('../../src/lib/errorCopy');
    expect(becauseLine({ heading: "Couldn’t load your projects.", reason: NO_ANSWER }, 'button'))
      .toBe('Nebula couldn’t load your projects because the server didn’t respond. Try again.');
    expect(becauseLine({ heading: "Couldn’t load your projects.", reason: LOST }, 'button'))
      .toBe('Nebula couldn’t load your projects because the server isn’t answering. Try again.');
    expect(besideButton('Nebula couldn’t load your projects because the server isn’t answering. Check that Nebula is running, then try again.'))
      .toBe('Nebula couldn’t load your projects because the server isn’t answering. Try again.');
    // The 4xx fallback ends in the button's "Try again." too; a line with another ending is as it was.
    expect(besideButton('Nebula couldn’t open the project because the server didn’t accept it. Try again, or reload if it keeps happening.'))
      .toBe('Nebula couldn’t open the project because the server didn’t accept it. Try again.');
    expect(besideButton('Projects could not be loaded.')).toBe('Projects could not be loaded.');
  });
});
