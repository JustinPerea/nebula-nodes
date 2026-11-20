import { describe, expect, it } from 'vitest';

import {
  chatCancellationDisconnectNotice,
  chatCancellationNotice,
  transitionChatCancellation,
} from '../../src/lib/chatCancellation';

describe('chat cancellation truth state', () => {
  it('keeps the response busy after Stop until the backend confirms cleanup', () => {
    expect(transitionChatCancellation('idle', { type: 'request' })).toEqual({
      state: 'requested',
      busy: true,
    });
    expect(transitionChatCancellation('requested', { type: 'done' })).toEqual({
      state: 'requested',
      busy: true,
    });
    expect(transitionChatCancellation('requested', { type: 'confirmed' })).toEqual({
      state: 'idle',
      busy: false,
    });
  });

  it('does not label a request as canceled before confirmation', () => {
    expect(chatCancellationNotice('requested')).toEqual({
      text: 'Cancellation requested…',
    });
    expect(chatCancellationNotice('requested').text).not.toBe('Canceled.');
    expect(chatCancellationNotice('confirmed')).toEqual({ text: 'Canceled.' });
  });

  it('represents failed cancellation without calling it canceled', () => {
    expect(transitionChatCancellation('requested', { type: 'failed', active: true })).toEqual({
      state: 'failed',
      busy: true,
    });
    expect(transitionChatCancellation('requested', { type: 'failed', active: false })).toEqual({
      state: 'failed',
      busy: false,
    });
  });

  it('turns a disconnect during cancellation into an explicit failure', () => {
    expect(transitionChatCancellation('requested', { type: 'disconnect' })).toEqual({
      state: 'failed',
      busy: false,
    });
    // error-copy (design): "Couldn't {verb} {object}." then the reason,
    // never "failed:".
    expect(chatCancellationDisconnectNotice('requested')).toEqual({
      // Design, verbatim: "People need to know it might still be spending."
      text: "Nebula couldn’t stop the reply because the connection dropped before Nebula confirmed the stop. The reply may still be running.",
      tone: 'error',
      neutralInk: true,
    });
    expect(chatCancellationDisconnectNotice('idle')).toBeNull();
  });

  it('a failed stop names the action and a written reason (error-copy)', () => {
    expect(chatCancellationNotice('failed', "Nebula's server isn't answering. Make sure it's running, then try again.")).toEqual({
      text: "Nebula couldn’t stop the reply because the server isn’t answering. Check that Nebula is running, then try again.",
      tone: 'error',
      neutralInk: true,
    });
    expect(chatCancellationNotice('failed').text)
      .toBe("Nebula couldn’t stop the reply because the server didn’t accept it. Try again, or reload if it keeps happening.");
  });
});
