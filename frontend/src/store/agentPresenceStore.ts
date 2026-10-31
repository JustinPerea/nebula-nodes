import { create } from 'zustand';
import { AGENT_CURSOR_ACTIONS, type AgentCursorAction } from '../lib/agentPresenceActions';
import {
  wsClient,
  type AgentCursorAnchor,
  type AgentPresenceEvent,
  type AgentPresenceSession,
} from '../lib/wsClient';

/** Cursors dim after this long without news, and disappear after AGENT_CURSOR_EXPIRE_MS. */
export const AGENT_CURSOR_IDLE_MS = 20_000;
export const AGENT_CURSOR_EXPIRE_MS = 120_000;
/** Narration stays beside the cursor this long after the agent's last event,
 * then fades (GM - Design, round 19: "fades out about 3 s after the agent's
 * last event"). */
export const AGENT_SAY_MS = 3_000;
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
  /** The project open when it happened. */
  projectId: string | null;
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
  prune: (now?: number) => void;
  /** Drop node anchors when the whole graph is cleared or replaced: ids restart per graph. */
  forgetGraph: () => void;
  clear: () => void;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const SESSION_KEY = /^[0-9a-f]{12}$/;
const MAX_SESSION_ORDINAL = 100_000;

export function cursorAction(raw: unknown): AgentCursorAction {
  return AGENT_CURSOR_ACTIONS.includes(raw as AgentCursorAction) ? (raw as AgentCursorAction) : 'move';
}

/** A session the backend gave, or null: anything malformed lands the event on
 *  the agent's own cursor. */
export function cleanSession(raw: unknown): AgentPresenceSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const session = raw as Record<string, unknown>;
  const { key, ordinal } = session;
  if (typeof key !== 'string' || !SESSION_KEY.test(key)) return null;
  if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_SESSION_ORDINAL) {
    return null;
  }
  return { key, ordinal };
}

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

function isAnchor(value: unknown): value is AgentCursorAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as Record<string, unknown>;
  if (typeof anchor.nodeId === 'string') return anchor.handle === undefined || typeof anchor.handle === 'string';
  return Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
}

export const useAgentPresenceStore = create<AgentPresenceState>((set) => ({
  agents: {},
  apply: (event, now = Date.now()) => {
    const agent = event.agent;
    // No target: an action with no place on the canvas, for the Agent log only (agentLogStore).
    const target = event.target;
    if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string' || !isAnchor(target)) return;
    const session = cleanSession(event.session);
    const key = session ? `${agent.id}#${session.key}` : agent.id;
    set((state) => {
      const previous = state.agents[key];
      const agents = { ...state.agents };
      if (!previous) {
        // One agent can't flood the canvas: past the cap, its cursor heard
        // from longest ago goes.
        const mine = Object.values(agents).filter((cursor) => cursor.id === agent.id);
        mine.sort((a, b) => a.receivedAt - b.receivedAt);
        for (const old of mine.slice(0, Math.max(0, mine.length + 1 - AGENT_CURSOR_SESSIONS_PER_AGENT))) {
          delete agents[old.key];
        }
      }
      return {
        agents: {
          ...agents,
          [key]: {
            id: agent.id,
            key,
            session,
            name: agent.name,
            color: SAFE_COLOR.test(agent.color) ? agent.color : '#E8825A',
            verified: Boolean(agent.verified),
            target,
            from: isAnchor(event.from) ? event.from : undefined,
            action: cursorAction(event.action),
            say: typeof event.say === 'string' ? event.say : '',
            receivedAt: now,
            seq: (previous?.seq ?? 0) + 1,
            did: cleanDid(event.did, now),
            projectId: typeof event.projectId === 'string' ? event.projectId : null,
          },
        },
      };
    });
  },
  prune: (now = Date.now()) => set((state) => {
    const kept = Object.fromEntries(
      Object.entries(state.agents).filter(([, cursor]) => now - cursor.receivedAt < AGENT_CURSOR_EXPIRE_MS),
    );
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
  clear: () => set({ agents: {} }),
}));

wsClient.subscribe((event) => {
  if (event.type === 'agentPresence') useAgentPresenceStore.getState().apply(event);
  else if (event.type === 'graphSync' && (event.graphReplaced || event.empty)) {
    useAgentPresenceStore.getState().forgetGraph();
  }
});
