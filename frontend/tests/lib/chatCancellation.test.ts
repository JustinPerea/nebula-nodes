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

  it('does not label a request as cancelled before confirmation', () => {
    expect(chatCancellationNotice('requested')).toEqual({
      text: 'Cancellation requested…',
    });
    expect(chatCancellationNotice('requested').text).not.toBe('Cancelled.');
    expect(chatCancellationNotice('confirmed')).toEqual({ text: 'Cancelled.' });
  });

  it('represents failed cancellation without calling it cancelled', () => {
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
    // error-copy round 2 (GM): "Couldn't {verb} {object}." then the reason,
    // never "failed:".
    expect(chatCancellationDisconnectNotice('requested')).toEqual({
      text: "Couldn't stop the reply. The connection closed before Nebula confirmed it stopped.",
      tone: 'error',
    });
    expect(chatCancellationDisconnectNotice('idle')).toBeNull();
  });

  it('a failed stop names the action and a written reason (error-copy round 2)', () => {
    expect(chatCancellationNotice('failed', "Couldn't reach Nebula. Check your connection and try again.")).toEqual({
      text: "Couldn't stop the reply. Couldn't reach Nebula. Check your connection and try again.",
      tone: 'error',
    });
    expect(chatCancellationNotice('failed').text)
      .toBe("Couldn't stop the reply. That didn't work. Try again, or reload if it keeps happening.");
  });
});
