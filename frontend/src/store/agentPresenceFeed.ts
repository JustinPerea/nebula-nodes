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
 * Bounded: a replay replaces every cursor, so what came before it goes, and
 * past AGENT_PRESENCE_FEED_MAX events the oldest go (a cursor that loses its
 * event shows again on its next one).
 */
export const AGENT_PRESENCE_FEED_MAX = 64;

export type PresenceFeedEvent = Extract<
  ExecutionEvent,
  { type: 'agentPresence' | 'agentPresenceReplay' | 'socketDemoted' | 'graphSync' }
>;
/** One event and when this tab heard it (ms), so a late drain keeps its age. */
export type PresenceSink = (event: PresenceFeedEvent, receivedAt: number) => void;

let sink: PresenceSink | null = null;
let held: { event: PresenceFeedEvent; at: number }[] = [];

function wanted(event: ExecutionEvent): event is PresenceFeedEvent {
  return event.type === 'agentPresence' || event.type === 'agentPresenceReplay' || event.type === 'socketDemoted'
    || (event.type === 'graphSync' && Boolean(event.graphReplaced || event.empty));
}

/** The store takes the feed: what is held first, in order, then each event as it comes. */
export function attachPresenceSink(next: PresenceSink): void {
  sink = next;
  const drained = held;
  held = [];
  for (const { event, at } of drained) next(event, at);
}

/** What is held for the store (tests). */
export function heldPresenceEvents(): readonly PresenceFeedEvent[] {
  return held.map(({ event }) => event);
}

wsClient.subscribe((event) => {
  if (!wanted(event)) return;
  const at = Date.now();
  if (sink) {
    sink(event, at);
    return;
  }
  if (event.type === 'agentPresenceReplay') held = [];
  held.push({ event, at });
  if (held.length > AGENT_PRESENCE_FEED_MAX) held.shift();
});
