import { create } from 'zustand';
import { AGENT_CURSOR_ACTIONS, type AgentCursorAction } from '../lib/agentPresenceActions';
import type { AgentAnchorNames, AgentCursorAnchor, AgentPresenceArrivalEvent, AgentPresenceEvent, AgentPresenceLeaveEvent, AgentPresenceRetargetEvent, AgentPresenceSession } from '../lib/wsClient';
import { attachPresenceSink } from './agentPresenceFeed';
import { cleanSession } from '../lib/agentCursorLabel';
import { AGENT_FALLBACK_COLOR } from '../lib/agentCursorColor';

/** Cursors dim after this long without news, and disappear after AGENT_CURSOR_EXPIRE_MS. */
export const AGENT_CURSOR_IDLE_MS = 20_000;
export const AGENT_CURSOR_EXPIRE_MS = 120_000;
// Narration's 3 s (GM - Design, round 19) lives with the cursor's label, which
// the Agent log shares.
export { AGENT_SAY_MS } from '../lib/agentCursorLabel';
/** The bubble's fade: the length of --agent-cursor-say-fade in agentCursor.css. */
export const AGENT_SAY_FADE_MS = 320;
/** Live cursors one agent can have at once, one per session (the backend's
 * SESSIONS_PER_AGENT): past it, the one heard from longest ago goes. */
export const AGENT_CURSOR_SESSIONS_PER_AGENT = 8;

export interface AgentCursor {
  /** The agent (its runner); AgentRoster merges on it. */
  id: string;
  /** This cursor's key in `agents`: `${id}#${session.key}` for a session, else `id`. */
  key: string;
  /** Which session of the agent, or null for its one cursor. */
  session: AgentPresenceSession | null;
  name: string;
  color: string;
  verified: boolean;
  target: AgentCursorAnchor;
  /** What a surface target is called (the board, the image's number, the
   *  control), for the cursor's line: absent for a canvas target. */
  anchorNames?: AgentAnchorNames;
  from?: AgentCursorAnchor;
  /** Normalised: an action this tab doesn't know is 'move'. */
  action: AgentCursorAction;
  say: string;
  /** Local receive time, so idle/expiry never depends on clock skew. */
  receivedAt: number;
  /** Increments per event so the same target can replay a gesture. */
  seq: number;
  /** What the last action was, for the Agents panel (Q125 item 2). */
  did: AgentCursorDid | null;
  /** From the replay a person tab gets on connect: drawn where it is, with no
   *  flight, until its next event. */
  replayed: boolean;
  /** The project open when it happened. */
  projectId: string | null;
  /** The proposal a `propose` cursor waits on, if its event named one. */
  proposalId: string | null;
  /** When it came to where it is, in the backend's clock (its `since`, else
   *  the event's `at`): the column order, the same in every tab and after a
   *  reload (GM - Design, PR #211 r21). */
  arrivedAt: number;
  /** Whether `arrivedAt` is the backend's own arrival (`since`): the same in
   *  every tab, so ties go by the cursor's key. Without it (an older event,
   *  the agents' form) the tab's landing order breaks them. */
  arrivalKnown: boolean;
}

export interface AgentCursorDid {
  verb: string;
  nodeId: string | null;
  label: string | null;
  /** When the action happened, in this tab's clock: a pointer gesture GM cut
   *  (a click, a drag) keeps the action before it, with its own time. */
  at: number;
}

interface AgentPresenceState {
  agents: Record<string, AgentCursor>;
  apply: (event: AgentPresenceEvent, now?: number) => void;
  /** Node moves carried these cursors in: each arrives now, by the backend. */
  arrive: (cursors: AgentPresenceArrivalEvent['cursors']) => void;
  /** The live cursors the backend replays to this tab on connect: they
   *  replace what the tab had, so a reconnect never doubles a cursor. */
  replay: (cursors: readonly AgentPresenceEvent[], now?: number) => void;
  /** The backend dropped these cursors (their board was deleted): they leave
   *  now, not at the 120 s prune, so a new session that takes the number
   *  never draws beside the old one. */
  leave: (cursors: AgentPresenceLeaveEvent['cursors']) => void;
  /** The backend moved these cursors to a board (their image was removed
   *  elsewhere): they go there now. Not a new event: no say, no new seq. */
  retarget: (cursors: AgentPresenceRetargetEvent['cursors']) => void;
  prune: (now?: number) => void;
  /** The server refused this tab's hello (a demoted tab): its numbered
   *  cursors are person-only and go, as any cursor leaves; the agents' form
   *  draws unnumbered cursors as events arrive (GM - Design, PR #211 r9 item 6). */
  demote: () => void;
  /** Drop node anchors when the whole graph is cleared or replaced: ids restart per graph. */
  forgetGraph: () => void;
  clear: () => void;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The last seq each cursor key had, kept after the cursor leaves: one that
 * comes back while the layer still fades it out (the presence exit) goes on
 * counting, so nothing keyed on its old seq (the say and idle timers, the
 * ripple) applies to its new event. Bounded; `clear` empties it.
 */
const lastSeq = new Map<string, number>();
const LAST_SEQ_MAX = 512;

function nextSeq(key: string, previous: number | undefined): number {
  const seq = Math.max(previous ?? 0, lastSeq.get(key) ?? 0) + 1;
  lastSeq.delete(key);
  lastSeq.set(key, seq);
  if (lastSeq.size > LAST_SEQ_MAX) lastSeq.delete(lastSeq.keys().next().value as string);
  return seq;
}

export function cursorAction(raw: unknown): AgentCursorAction {
  return AGENT_CURSOR_ACTIONS.includes(raw as AgentCursorAction) ? (raw as AgentCursorAction) : 'move';
}

// cleanSession lives with the cursor's label (agentCursorLabel), which the
// Agent log, loaded with the app, uses without pulling in this store.
export { cleanSession };

function cleanDid(raw: unknown, now: number): AgentCursorDid | null {
  if (!raw || typeof raw !== 'object') return null;
  const did = raw as Record<string, unknown>;
  if (typeof did.verb !== 'string' || !did.verb) return null;
  const ago = typeof did.secondsAgo === 'number' && Number.isFinite(did.secondsAgo) ? Math.max(0, did.secondsAgo) : 0;
  return {
    verb: did.verb,
    nodeId: typeof did.nodeId === 'string' ? did.nodeId : null,
    label: typeof did.label === 'string' && did.label ? did.label : null,
    at: now - ago * 1000,
  };
}

const ANCHOR_ITEM = /^[A-Za-z0-9_.-]{1,64}(\/[A-Za-z0-9_.-]{1,64})?$/;

/** The names beside a surface anchor: a board name, an image number, a control label. */
function cleanAnchorNames(raw: unknown, target: AgentCursorAnchor): AgentAnchorNames | undefined {
  if (!('surface' in target) || !raw || typeof raw !== 'object') return undefined;
  const names = raw as Record<string, unknown>;
  if (typeof names.board !== 'string' || !names.board) return undefined;
  return {
    board: names.board,
    ...(typeof names.image === 'number' && Number.isFinite(names.image) ? { image: names.image } : {}),
    ...(typeof names.part === 'string' && names.part ? { part: names.part } : {}),
  };
}

function isAnchor(value: unknown): value is AgentCursorAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as Record<string, unknown>;
  // A surface item: `itemId` is `<board>` or `<board>/<image>` (ids, 1-64 of the DOM attribute's characters).
  if (anchor.surface === 'moodboard') {
    return typeof anchor.itemId === 'string' && ANCHOR_ITEM.test(anchor.itemId)
      && (anchor.part === undefined || typeof anchor.part === 'string');
  }
  if (typeof anchor.nodeId === 'string') return anchor.handle === undefined || typeof anchor.handle === 'string';
  return Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
}

/** When a cursor came to where it is: the backend's `since` (person tabs),
 *  else, for an event without one, the arrival it had while its target
 *  stays the same, else the event's own time. */
function arrivalOf(event: AgentPresenceEvent, previous: AgentCursor | undefined): number {
  if (typeof event.since === 'number' && Number.isFinite(event.since)) return event.since;
  if (previous && JSON.stringify(previous.target) === JSON.stringify(event.target)) return previous.arrivedAt;
  return Number.isFinite(event.at) ? event.at : 0;
}

/** `agents` with one event applied (a new object), or `agents` itself when
 *  the event has no cursor. */
function withEvent(
  agents: Record<string, AgentCursor>,
  event: AgentPresenceEvent & { replay?: unknown; secondsAgo?: unknown },
  now: number,
): Record<string, AgentCursor> {
  const agent = event.agent;
  // No target: an action with no place on the canvas, for the Agent log only (agentLogStore).
  const target = event.target;
  if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string' || !isAnchor(target)) return agents;
  const session = cleanSession(event.session);
  const key = session ? `${agent.id}#${session.key}` : agent.id;
  const replayed = event.replay === true;
  const ago = replayed && typeof event.secondsAgo === 'number' && Number.isFinite(event.secondsAgo)
    ? Math.min(Math.max(0, event.secondsAgo), AGENT_CURSOR_EXPIRE_MS / 1000) : 0;
  const receivedAt = now - ago * 1000;
  const previous = agents[key];
  const next = { ...agents };
  if (session && (!previous || previous.session?.ordinal !== session.ordinal)) {
    // Only the backend numbers, and this tab shows its number as given. A new
    // cursor with a number another cursor of this agent still shows means
    // that one has left the backend (it went quiet for
    // AGENT_CURSOR_EXPIRE_MS, or the cap pushed it out): it goes here too,
    // so two cursors never read the same name. The same holds when a cursor
    // the tab already shows comes with a new number (review 2, LOW-2).
    for (const other of Object.values(next)) {
      if (other.id === agent.id && other.session?.ordinal === session.ordinal) delete next[other.key];
    }
  }
  if (!previous) {
    // One agent can't flood the canvas: past the cap, its cursor heard
    // from longest ago goes.
    const mine = Object.values(next).filter((cursor) => cursor.id === agent.id);
    mine.sort((a, b) => a.receivedAt - b.receivedAt);
    for (const old of mine.slice(0, Math.max(0, mine.length + 1 - AGENT_CURSOR_SESSIONS_PER_AGENT))) {
      delete next[old.key];
    }
  }
  next[key] = {
    id: agent.id,
    key,
    session,
    name: agent.name,
    color: SAFE_COLOR.test(agent.color) ? agent.color : AGENT_FALLBACK_COLOR,
    verified: Boolean(agent.verified),
    target,
    anchorNames: cleanAnchorNames(event.anchorNames, target),
    from: !replayed && isAnchor(event.from) ? event.from : undefined,
    action: cursorAction(event.action),
    say: typeof event.say === 'string' ? event.say : '',
    receivedAt,
    seq: nextSeq(key, previous?.seq),
    did: cleanDid(event.did, now),
    projectId: typeof event.projectId === 'string' ? event.projectId : null,
    proposalId: typeof event.proposalId === 'string' && event.proposalId && event.proposalId.length <= 128
      ? event.proposalId : null,
    replayed,
    arrivedAt: arrivalOf(event, previous),
    arrivalKnown: typeof event.since === 'number' && Number.isFinite(event.since)
      || Boolean(previous?.arrivalKnown && JSON.stringify(previous.target) === JSON.stringify(event.target)),
  };
  return next;
}

export const useAgentPresenceStore = create<AgentPresenceState>((set) => ({
  agents: {},
  apply: (event, now = Date.now()) => set((state) => {
    const agents = withEvent(state.agents, event, now);
    return agents === state.agents ? state : { agents };
  }),
  arrive: (cursors) => set((state) => {
    let agents: Record<string, AgentCursor> | null = null;
    for (const c of Array.isArray(cursors) ? cursors : []) {
      if (!c || typeof c.agentId !== 'string' || typeof c.key !== 'string' || !Number.isFinite(c.since)) continue;
      const key = `${c.agentId}#${c.key}`;
      const cursor: AgentCursor | undefined = (agents ?? state.agents)[key];
      if (!cursor || (cursor.arrivedAt === c.since && cursor.arrivalKnown)) continue;
      // Not a new event: no seq, no say, no flight. Only its place in the column.
      agents = { ...(agents ?? state.agents), [key]: { ...cursor, arrivedAt: c.since, arrivalKnown: true } };
    }
    return agents ? { agents } : state;
  }),
  leave: (cursors) => set((state) => {
    const kept = { ...state.agents };
    for (const c of Array.isArray(cursors) ? cursors : []) {
      if (!c || typeof c.agentId !== 'string') continue;
      const key = typeof c.key === 'string' ? `${c.agentId}#${c.key}` : c.agentId;
      delete kept[key];
    }
    return Object.keys(kept).length === Object.keys(state.agents).length ? state : { agents: kept };
  }),
  retarget: (cursors) => set((state) => {
    let agents: Record<string, AgentCursor> | null = null;
    for (const c of Array.isArray(cursors) ? cursors : []) {
      if (!c || typeof c.agentId !== 'string' || !isAnchor(c.target)) continue;
      const key = typeof c.key === 'string' ? `${c.agentId}#${c.key}` : c.agentId;
      const cursor: AgentCursor | undefined = (agents ?? state.agents)[key];
      if (!cursor) continue;
      agents = { ...(agents ?? state.agents), [key]: { ...cursor, target: c.target, anchorNames: cleanAnchorNames(c.anchorNames, c.target) } };
    }
    return agents ? { agents } : state;
  }),
  replay: (cursors, now = Date.now()) => set(() => {
    // The backend's live set, as of this tab's hello. Cursors drawn from the
    // agents' form before the hello (no session) are the same cursors under
    // another key, so the replay replaces them; a cursor it doesn't list has
    // left. One kept with the same key keeps counting its seq (nextSeq).
    let agents: Record<string, AgentCursor> = {};
    for (const cursor of Array.isArray(cursors) ? cursors : []) {
      if (!cursor || typeof cursor !== 'object') continue;
      agents = withEvent(agents, { ...cursor, replay: true }, now);
    }
    return { agents };
  }),
  prune: (now = Date.now()) => set((state) => {
    const kept = Object.fromEntries(
      Object.entries(state.agents).filter(([, cursor]) => now - cursor.receivedAt < AGENT_CURSOR_EXPIRE_MS),
    );
    return Object.keys(kept).length === Object.keys(state.agents).length ? state : { agents: kept };
  }),
  demote: () => set((state) => {
    const kept = Object.fromEntries(Object.entries(state.agents).filter(([, cursor]) => cursor.session === null));
    return Object.keys(kept).length === Object.keys(state.agents).length ? state : { agents: kept };
  }),
  forgetGraph: () => set((state) => {
    const kept: Record<string, AgentCursor> = {};
    for (const [key, cursor] of Object.entries(state.agents)) {
      if ('nodeId' in cursor.target) continue;
      const unpinned = cursor.from && 'nodeId' in cursor.from ? { ...cursor, from: undefined } : cursor;
      // Its last action keeps the node's name, not the node (ids restart per graph).
      kept[key] = unpinned.did?.nodeId ? { ...unpinned, did: { ...unpinned.did, nodeId: null } } : unpinned;
    }
    return { agents: kept };
  }),
  clear: () => {
    lastSeq.clear();
    set({ agents: {} });
  },
}));

// The socket feed (agentPresenceFeed, in the startup entry) held whatever
// came before this chunk loaded; it hands that over now, with each event's
// receive time, then each event as it comes.
attachPresenceSink((event, receivedAt) => {
  const store = useAgentPresenceStore.getState();
  if (event.type === 'agentPresence') store.apply(event, receivedAt);
  else if (event.type === 'agentPresenceReplay') store.replay(event.cursors, receivedAt);
  else if (event.type === 'agentPresenceArrival') store.arrive(event.cursors);
  else if (event.type === 'agentPresenceLeave') store.leave(event.cursors);
  else if (event.type === 'agentPresenceRetarget') store.retarget(event.cursors);
  else if (event.type === 'socketDemoted') store.demote();
  else if (event.type === 'graphSync' && (event.graphReplaced || event.empty)) store.forgetGraph();
});
