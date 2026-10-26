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

const LOST = "Nebula's server isn't answering. Make sure it's running, then try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";
const REFUSED = "Try again, or reload if it keeps happening.";
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

/**
 * Round 2 (GM - Design, error-copy round 2): an error from a request carries
 * its parts. The heading names what failed ("Couldn't save the board."), the
 * reason line says why (GM's lines, the backend's written reason, or GM's
 * fallback for the status), and its kind. `message` is the one-line form
 * "<heading> <reason>" for alerts, toasts and status text. GM's WRAP rule:
 * "when the surface already has a retry button, the reason line drops its
 * 'try again'. The button is the retry."
 */
describe('round 2: heading + reason + kind', async () => {
  const copy = await import('../../src/lib/errorCopy');
  const LOST_SHORT = "Nebula's server isn't answering. Make sure it's running.";
  const NO_ANSWER_SHORT = "Nebula didn't respond.";
  const HEADING = "Couldn't save the board.";

  it('GM\'s short lines and the other round 2 lines, verbatim', () => {
    expect(copy.CONNECTION_LOST_SHORT_COPY).toBe(LOST_SHORT);
    expect(copy.NO_RESPONSE_SHORT_COPY).toBe(NO_ANSWER_SHORT);
    expect(copy.BACKEND_NOT_RUNNING_COPY).toBe("Nebula's backend isn't running. Start it, then reload.");
  });

  // [status, detail, reason, short reason, kind]
  const table: Array<[number, unknown, string, string, string]> = [
    [0, undefined, LOST, LOST_SHORT, 'connection'],
    [408, 'Request timed out', NO_ANSWER, NO_ANSWER_SHORT, 'no-response'],
    [429, undefined, NO_ANSWER, NO_ANSWER_SHORT, 'no-response'],
    [500, 'Internal Server Error', NO_ANSWER, NO_ANSWER_SHORT, 'no-response'],
    [503, undefined, NO_ANSWER, NO_ANSWER_SHORT, 'no-response'],
    [409, 'This board changed in another window.', 'This board changed in another window.', 'This board changed in another window.', 'refused'],
    // GM's 4xx fallback keeps its "Try again" on a retry surface too (listed for GM).
    [400, undefined, REFUSED, REFUSED, 'refused'],
    [422, [{ loc: ['body', 'images', 0, 'url'], msg: 'field required' }], REFUSED, REFUSED, 'refused'],
    [403, undefined, ACCESS, ACCESS, 'refused'],
    [413, undefined, TOO_LARGE, TOO_LARGE, 'refused'],
  ];
  it.each(table)('HTTP %i (detail %j): heading, reason, short reason, kind', (status, detail, reason, short, kind) => {
    const error = new copy.RequestFailedError(HEADING, status, { detail });
    expect(error.heading).toBe(HEADING);
    expect(error.reason).toBe(reason);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.detail).toEqual(detail);
    expect(error.message).toBe(`${HEADING} ${reason}`);
    expect(copy.failureCopy(error)).toEqual({ heading: HEADING, reason });
    expect(copy.failureCopy(error, { short: true })).toEqual({ heading: HEADING, reason: short });
  });

  it('a lost connection named by its action keeps the browser\'s error and stays a TypeError', () => {
    const original = new TypeError('Failed to fetch');
    const error = new copy.ConnectionLostError(original).withHeading("Couldn't load your API keys.");
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(copy.ConnectionLostError);
    expect(error.cause).toBe(original);
    expect(error.status).toBe(0);
    expect(error.message).toBe(`Couldn't load your API keys. ${LOST}`);
    expect(copy.failureCopy(error, { short: true })).toEqual({ heading: "Couldn't load your API keys.", reason: LOST_SHORT });
  });

  it('withHeading names a lost connection, and leaves anything else (the caller\'s abort) as it was', () => {
    const lost = copy.withHeading(new copy.ConnectionLostError(new TypeError('x')), "Couldn't cancel the run.");
    expect((lost as Error).message).toBe(`Couldn't cancel the run. ${LOST}`);
    const abort = new DOMException('aborted', 'AbortError');
    expect(copy.withHeading(abort, "Couldn't cancel the run.")).toBe(abort);
  });

  it('a failure that isn\'t a request\'s says GM\'s general line under the heading the screen gives it', () => {
    expect(copy.failureCopy(new Error('Unexpected token <'), { heading: HEADING })).toEqual({ heading: HEADING, reason: REFUSED });
    expect(copy.failureCopy(new copy.ConnectionLostError(new TypeError('Failed to fetch')), { heading: HEADING, short: true }))
      .toEqual({ heading: HEADING, reason: LOST_SHORT });
    expect(copy.failureMessage(new Error('boom'), HEADING)).toBe(`${HEADING} ${REFUSED}`);
    expect(copy.failureMessage(new copy.RequestFailedError(HEADING, 503), "Couldn't do it.")).toBe(`${HEADING} ${NO_ANSWER}`);
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
    const error = await copy.requestError("Couldn't save the board.",
      new Response(JSON.stringify({ detail: list }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
    expect(error.message).toBe(`Couldn't save the board. ${REFUSED}`);
    expect(error.detail).toEqual(list);
    const reasoned = await copy.requestError("Couldn't move the board.",
      new Response(JSON.stringify({ detail: 'That project is gone.' }), { status: 404 }));
    expect(reasoned.message).toBe("Couldn't move the board. That project is gone.");
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

describe('round 2: shortLine, the WRAP rule for a one-line string beside a retry button', () => {
  it('swaps a trailing "try again" line for its short form, and leaves anything else', async () => {
    const { shortLine } = await import('../../src/lib/errorCopy');
    expect(shortLine("Couldn't load your projects. Nebula didn't respond. Try again."))
      .toBe("Couldn't load your projects. Nebula didn't respond.");
    expect(shortLine("Couldn't load your projects. Nebula's server isn't answering. Make sure it's running, then try again."))
      .toBe("Couldn't load your projects. Nebula's server isn't answering. Make sure it's running.");
    // GM's 4xx fallback keeps its "Try again" (listed for GM).
    const refused = "Couldn't open the project. Try again, or reload if it keeps happening.";
    expect(shortLine(refused)).toBe(refused);
    expect(shortLine('Projects could not be loaded.')).toBe('Projects could not be loaded.');
  });
});
