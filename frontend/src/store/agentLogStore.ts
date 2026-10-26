import { create } from 'zustand';
import { wsClient, type AgentPresenceEvent } from '../lib/wsClient';
import { normalizeAgentEventSource, type AgentEventSource } from '../lib/agentEvents';

/** The Agent log keeps this many entries, oldest dropped first. Memory only. */
export const AGENT_LOG_MAX_ENTRIES = 50;

export interface AgentLogEntry {
  id: string;
  /** Wall-clock ms: the backend's for an agent's action, arrival for a chat line. */
  ts: number;
  source: AgentEventSource;
  /** Who acted, as their cursor names them. Absent on the chat's thinking lines. */
  agent?: { id: string; name: string; color: string };
  message: string;
}

interface AgentLogState {
  entries: AgentLogEntry[];
  add: (entry: Omit<AgentLogEntry, 'id'>) => void;
  clear: () => void;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLOR = '#E8825A';
let entrySeq = 0;

export const useAgentLogStore = create<AgentLogState>((set) => ({
  entries: [],
  add: (entry) => set((state) => ({
    entries: [...state.entries.slice(-(AGENT_LOG_MAX_ENTRIES - 1)), { ...entry, id: `log-${++entrySeq}` }],
  })),
  clear: () => set({ entries: [] }),
}));

/**
 * One agent action as a log entry, from the event that also moves its cursor
 * (agentPresenceStore): the same name, colour and words ("Added “Moodboard”",
 * "Running “Krea 2”", "Accepted"). A moodboard write comes without a target, so
 * it moves no cursor and is listed here only. Null for an event with nothing
 * to say, such as a bare cursor move.
 */
export function agentActionEntry(event: AgentPresenceEvent, now = Date.now()): Omit<AgentLogEntry, 'id'> | null {
  const agent = event.agent;
  if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string') return null;
  const message = typeof event.say === 'string' ? event.say.trim() : '';
  if (!message) return null;
  return {
    ts: Number.isFinite(event.at) && event.at > 0 ? event.at : now,
    source: 'agent',
    agent: { id: agent.id, name: agent.name, color: SAFE_COLOR.test(agent.color) ? agent.color : FALLBACK_COLOR },
    message,
  };
}

// Fed at load, not by the panel: AgentLog mounts on the main canvas only,
// and an agent working while the person is in a Studio still shows up when
// they come back.
wsClient.subscribe((event) => {
  if (event.type !== 'agentPresence') return;
  const entry = agentActionEntry(event);
  if (entry) useAgentLogStore.getState().add(entry);
});

// The in-app chat's thinking lines (ChatPanel), and any other component's
// line, arrive as window events.
if (typeof window !== 'undefined') {
  window.addEventListener('nebula:agent-log-entry', (e: Event) => {
    const detail = (e as CustomEvent).detail as { source?: unknown; message?: string } | undefined;
    const message = String(detail?.message ?? '').trim();
    if (!message) return;
    useAgentLogStore.getState().add({ ts: Date.now(), source: normalizeAgentEventSource(detail?.source), message });
  });
}
