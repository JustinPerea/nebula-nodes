import { describe, expect, it } from 'vitest';
import {
  CONNECTION_LOST_COPY, ConnectionLostError, NO_RESPONSE_COPY, RequestFailedError, actionFailedLine, retryBecauseLine, shortLine,
} from '../../src/lib/errorCopy';

// GM 2026-11 copy sweep: a failure line shown with a Try again button ends in "Try again.", in the because form,
// and has no "Try again." when retrying cannot help.
describe('actionFailedLine', () => {
  const cases: [string, unknown, string, boolean][] = [
    ['no answer', new ConnectionLostError(new TypeError('Failed to fetch')),
      'Nebula couldn’t upload “a.png” because the server isn’t answering. Try again.', true],
    ['busy (429)', new RequestFailedError('', 429), 'Nebula couldn’t upload “a.png” because the server is busy. Try again.', true],
    ['an error (500)', new RequestFailedError('', 500), 'Nebula couldn’t upload “a.png” because the server hit an error. Try again.', true],
    ['no response (503)', new RequestFailedError('', 503), 'Nebula couldn’t upload “a.png” because the server didn’t respond. Try again.', true],
    ['a refusal', new RequestFailedError('', 415, { detail: 'Anything the backend said' }),
      'Nebula couldn’t upload “a.png” because the server didn’t accept it. Try again.', true],
    ['access lost (401)', new RequestFailedError('', 401),
      'Nebula couldn’t upload “a.png” because you don’t have access to this anymore. Reload to sign in again.', false],
  ];
  it.each(cases)('%s', (_name, error, line, retryable) => {
    expect(actionFailedLine('upload “a.png”', error)).toEqual({ line, retryable });
  });
});

describe('retryBecauseLine', () => {
  it('puts the action in the because form beside a retry', () => {
    expect(retryBecauseLine(`Couldn't open the project. ${CONNECTION_LOST_COPY}`))
      .toBe('Nebula couldn’t open the project because the server isn’t answering. Try again.');
    expect(retryBecauseLine(`Nebula couldn’t restore “Shore”. ${NO_RESPONSE_COPY}`))
      .toBe('Nebula couldn’t restore “Shore” because the server didn’t respond. Try again.');
  });

  it('leaves any other line as shortLine does', () => {
    const own = 'Couldn’t delete “Shore”. “Shot 2” is still running.';
    expect(retryBecauseLine(own)).toBe(own);
    expect(retryBecauseLine(`Cannot clear the canvas. ${CONNECTION_LOST_COPY}`)).toBe(shortLine(`Cannot clear the canvas. ${CONNECTION_LOST_COPY}`));
  });
});
