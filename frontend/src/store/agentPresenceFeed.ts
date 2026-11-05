import { wsClient, type ExecutionEvent } from '../lib/wsClient';

/**
 * The agent cursors' socket feed, in the startup entry (review 3, N3).
 *
 * Presence that arrives before the cursor chunk loads must not be missed: a
 * person tab's replay comes right after its hello, before any agent acts. So
 * this subscribes at import and keeps what arrives, raw, until the presence
 * store (store/agentPresenceStore.ts, deferred with its only readers, the
 * cursor layer and the Agents panel) attaches and takes it in order. The
 * normalising, the numbering rules and the replay itself stay in the chunk.
 *
 * Bounded: a replay replaces every cursor, so what came before it goes. The
 * latest replay is kept apart, and past AGENT_PRESENCE_FEED_MAX events after
 * it the oldest of those go (a cursor that loses its event shows again on
 * its next one), never the replay itself (review 4, NIT-3).
 */
export const AGENT_PRESENCE_FEED_MAX = 64;

export type PresenceFeedEvent = Extract<
  ExecutionEvent,
  { type: 'agentPresence' | 'agentPresenceReplay' | 'agentPresenceArrival' | 'socketDemoted' | 'graphSync' }
>;
/** One event and when this tab heard it (ms), so a late drain keeps its age. */
export type PresenceSink = (event: PresenceFeedEvent, receivedAt: number) => void;

type Held = { event: PresenceFeedEvent; at: number };

let sink: PresenceSink | null = null;
let replay: Held | null = null;
let held: Held[] = [];

function wanted(event: ExecutionEvent): event is PresenceFeedEvent {
  return event.type === 'agentPresence' || event.type === 'agentPresenceReplay' || event.type === 'agentPresenceArrival'
    || event.type === 'socketDemoted'
    || (event.type === 'graphSync' && Boolean(event.graphReplaced || event.empty));
}

/** The store takes the feed: what is held first, in order, then each event as it comes. */
export function attachPresenceSink(next: PresenceSink): void {
  sink = next;
  const drained = replay ? [replay, ...held] : held;
  replay = null;
  held = [];
  for (const { event, at } of drained) next(event, at);
}

/** What is held for the store, in order (tests). */
export function heldPresenceEvents(): readonly PresenceFeedEvent[] {
  return (replay ? [replay, ...held] : held).map(({ event }) => event);
}

wsClient.subscribe((event) => {
  if (!wanted(event)) return;
  const at = Date.now();
  if (sink) {
    sink(event, at);
    return;
  }
  if (event.type === 'agentPresenceReplay') {
    replay = { event, at };
    held = [];
    return;
  }
  held.push({ event, at });
  if (held.length > AGENT_PRESENCE_FEED_MAX) held.shift();
});
