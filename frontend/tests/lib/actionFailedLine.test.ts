import { describe, expect, it } from 'vitest';
import {
  CONNECTION_LOST_COPY, ConnectionLostError, NO_RESPONSE_COPY, RequestFailedError, actionFailedLine, becauseLine,
} from '../../src/lib/errorCopy';

// Design 2026-11 copy sweep: a failure line shown with a Try again button ends in "Try again.", in the because form,
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

// retryBecauseLine and shortLine are gone: becauseLine takes the line's parts and the button beside it.
describe('becauseLine beside a retry button', () => {
  it('puts the action in the because form, ending in the button\'s words', () => {
    expect(becauseLine({ heading: 'Couldn’t open the project.', reason: CONNECTION_LOST_COPY }, 'button'))
      .toBe('Nebula couldn’t open the project because the server isn’t answering. Try again.');
    expect(becauseLine({ heading: 'Nebula couldn’t restore “Shore”.', reason: NO_RESPONSE_COPY }, 'button'))
      .toBe('Nebula couldn’t restore “Shore” because the server didn’t respond. Try again.');
  });

  it('a reason that is a sentence becomes the clause (a quoted name stays); a heading that is not “Couldn’t …” keeps its own words', () => {
    expect(becauseLine({ heading: 'Couldn’t delete “Shore”.', reason: '“Shot 2” is still running.' }, 'button'))
      .toBe('Nebula couldn’t delete “Shore” because “Shot 2” is still running.');
    expect(becauseLine({ heading: 'Cannot clear the canvas.', reason: CONNECTION_LOST_COPY }, 'button'))
      .toBe('Cannot clear the canvas. Nebula’s server isn’t answering. Make sure it’s running, then try again.');
  });
});
