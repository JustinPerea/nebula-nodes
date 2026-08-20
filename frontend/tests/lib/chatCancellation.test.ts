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
    expect(chatCancellationDisconnectNotice('requested')).toEqual({
      text: 'Warning: Cancellation failed: connection closed before backend cleanup was confirmed.',
      tone: 'error',
    });
    expect(chatCancellationDisconnectNotice('idle')).toBeNull();
  });
});
