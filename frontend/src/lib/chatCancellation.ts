import { REFUSED_FALLBACK_COPY, headedLine } from './errorCopy';

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

/** A failed Stop, GM's pattern (error-copy round 2): "Couldn't stop the
 * reply." then a written reason (the caller's), never "failed:" or raw text;
 * GM's general line when there is none. Through headedLine (review 5, L4):
 * a reason that already says "Couldn't stop the reply. …" shows once. */
export function chatCancellationNotice(
  status: 'requested' | 'confirmed' | 'failed',
  reason?: string,
): ChatCancellationNotice {
  if (status === 'requested') return { text: 'Cancellation requested…' };
  if (status === 'confirmed') return { text: 'Cancelled.' };
  return {
    text: headedLine("Couldn't stop the reply.", reason || REFUSED_FALLBACK_COPY),
    tone: 'error',
  };
}

export function chatCancellationDisconnectNotice(
  state: ChatCancellationState,
): ChatCancellationNotice | null {
  return state === 'requested'
    ? chatCancellationNotice(
        'failed',
        // GM, round 3: "People need to know it might still be spending."
        'The connection dropped before Nebula confirmed the stop. The reply may still be running.',
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
