import { create } from 'zustand';
import { wsClient, type AgentCursorAnchor, type AgentPresenceEvent } from '../lib/wsClient';

/** Cursors dim after this long without news, and disappear after AGENT_CURSOR_EXPIRE_MS. */
export const AGENT_CURSOR_IDLE_MS = 20_000;
export const AGENT_CURSOR_EXPIRE_MS = 120_000;
/** Narration stays beside the cursor this long. */
export const AGENT_SAY_MS = 6_000;

export interface AgentCursor {
  id: string;
  name: string;
  color: string;
  verified: boolean;
  target: AgentCursorAnchor;
  from?: AgentCursorAnchor;
  action: AgentPresenceEvent['action'];
  say: string;
  /** Local receive time, so idle/expiry never depends on clock skew. */
  receivedAt: number;
  /** Increments per event so the same target can replay a gesture. */
  seq: number;
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
    if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string' || !isAnchor(event.target)) return;
    set((state) => {
      const previous = state.agents[agent.id];
      return {
        agents: {
          ...state.agents,
          [agent.id]: {
            id: agent.id,
            name: agent.name,
            color: SAFE_COLOR.test(agent.color) ? agent.color : '#E8825A',
            verified: Boolean(agent.verified),
            target: event.target,
            from: isAnchor(event.from) ? event.from : undefined,
            action: event.action,
            say: typeof event.say === 'string' ? event.say : '',
            receivedAt: now,
            seq: (previous?.seq ?? 0) + 1,
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
    for (const [id, cursor] of Object.entries(state.agents)) {
      if ('nodeId' in cursor.target) continue;
      kept[id] = cursor.from && 'nodeId' in cursor.from ? { ...cursor, from: undefined } : cursor;
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
