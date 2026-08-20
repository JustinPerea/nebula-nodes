export type ChatCancellationState = 'idle' | 'requested' | 'failed';

export type ChatCancellationEvent =
  | { type: 'send' }
  | { type: 'request' }
  | { type: 'confirmed' }
  | { type: 'failed'; active: boolean }
  | { type: 'done' }
  | { type: 'disconnect' };

export interface ChatCancellationTransition {
  state: ChatCancellationState;
  busy: boolean;
}

export interface ChatCancellationNotice {
  text: string;
  tone?: 'error';
}

export function chatCancellationNotice(
  status: 'requested' | 'confirmed' | 'failed',
  message?: string,
): ChatCancellationNotice {
  if (status === 'requested') return { text: 'Cancellation requested…' };
  if (status === 'confirmed') return { text: 'Cancelled.' };
  return {
    text: `Warning: Cancellation failed: ${message || 'unknown error'}`,
    tone: 'error',
  };
}

export function chatCancellationDisconnectNotice(
  state: ChatCancellationState,
): ChatCancellationNotice | null {
  return state === 'requested'
    ? chatCancellationNotice(
        'failed',
        'connection closed before backend cleanup was confirmed.',
      )
    : null;
}

/**
 * Truth table for chat cancellation UI. A request deliberately remains busy;
 * only backend confirmation (or a terminal failure/disconnect) closes it.
 */
export function transitionChatCancellation(
  state: ChatCancellationState,
  event: ChatCancellationEvent,
): ChatCancellationTransition {
  switch (event.type) {
    case 'send':
      return { state: 'idle', busy: true };
    case 'request':
      return { state: 'requested', busy: true };
    case 'confirmed':
      return { state: 'idle', busy: false };
    case 'failed':
      return { state: 'failed', busy: event.active };
    case 'done':
      return state === 'requested'
        ? { state: 'requested', busy: true }
        : { state: 'idle', busy: false };
    case 'disconnect':
      return {
        state: state === 'requested' ? 'failed' : state,
        busy: false,
      };
  }
}
