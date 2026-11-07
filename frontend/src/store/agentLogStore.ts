import { create } from 'zustand';
import { wsClient, type AgentPresenceEvent } from '../lib/wsClient';
import { normalizeAgentEventSource, type AgentEventSource } from '../lib/agentEvents';
import { AGENT_SAY_MS, cleanSession, cursorLabel } from '../lib/agentCursorLabel';
import { AGENT_FALLBACK_COLOR, agentLogTones } from '../lib/agentCursorColor';

/** The Agent log keeps this many entries, oldest dropped first. Memory only. */
export const AGENT_LOG_MAX_ENTRIES = 50;

export interface AgentLogEntry {
  id: string;
  /** Wall-clock ms: the backend's for an agent's action, arrival for a chat line. */
  ts: number;
  source: AgentEventSource;
  /** Who acted, as their cursor's pill names them (cursorLabel), in their cursor's shade (`color`,
   *  the dot) and that shade's readable tone (`ink`, the name text). Absent on the chat's thinking lines. */
  agent?: { id: string; name: string; color: string; ink?: string };
  message: string;
  /** Shown neutral, in the muted colour (an event's `tone`). */
  tone?: 'muted';
}

interface AgentLogState {
  entries: AgentLogEntry[];
  add: (entry: Omit<AgentLogEntry, 'id'>) => void;
  clear: () => void;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
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
 * "Running “Krea 2”", "Accepted"), or the event's own `log` line when the
 * bubble says nothing (PR #198 r1: "Changed a setting on “Hero still”"), so
 * no action is left out. A moodboard write comes without a target, so it
 * moves no cursor and is listed here only. Null for an event with nothing to
 * say or log, such as a bare cursor move.
 */
export function agentActionEntry(event: AgentPresenceEvent, now = Date.now()): Omit<AgentLogEntry, 'id'> | null {
  const agent = event.agent;
  if (!agent || typeof agent.id !== 'string' || typeof agent.name !== 'string') return null;
  // The log's own words when the bubble's leave something out (round 16 of
  // PR #195; PR #198 r1).
  const said = typeof event.say === 'string' ? event.say.trim() : '';
  const message = (typeof event.log === 'string' ? event.log.trim() : '') || said;
  if (!message) return null;
  const session = cleanSession(event.session);
  const tones = agentLogTones(SAFE_COLOR.test(agent.color) ? agent.color : AGENT_FALLBACK_COLOR, session);
  return {
    ts: Number.isFinite(event.at) && event.at > 0 ? event.at : now,
    source: 'agent',
    // Named as its cursor's pill names it ("Pair · 3"), from the same
    // helper, so two sessions of one agent read apart (GM - Design, PR #211
    // r19). Person UI only.
    // In its cursor's own shade, the dot exactly and the name readable on
    // the log (GM - Design, PR #211 r20).
    agent: { id: agent.id, name: cursorLabel(agent.name, session), color: tones.dot, ink: tones.name },
    message,
    ...(event.tone === 'muted' ? { tone: 'muted' as const } : {}),
  };
}

// Fed at load, not by the panel: AgentLog mounts on the main canvas only,
// and an agent working while the person is in a Studio still shows up when
// they come back.
//
// A replay (a tab that just connected, or reconnected) adds a cursor's say
// that is still current, so a say this tab can't show on the canvas (a
// folded member's, or one held for room) still reaches the log (GM - Design,
// PR #211 r21). Each action is listed once, by the backend's id for the
// event (`eventId`, person tabs only): a live event and its replay carry the
// same one, and two real actions never do, even with the same words in the
// same millisecond (#211 review 9, LOW-5). An event without one (an older
// backend, a line with no cursor) is always listed.
const listed = new Set<string>();
const LISTED_MAX = 4 * AGENT_LOG_MAX_ENTRIES;

/** Lists one action, once. */
export function listAgentAction(event: AgentPresenceEvent): void {
  const entry = agentActionEntry(event);
  if (!entry) return;
  const id = typeof event.eventId === 'string' && event.eventId ? event.eventId : null;
  if (id !== null) {
    if (listed.has(id)) return;
    listed.add(id);
    if (listed.size > LISTED_MAX) listed.delete(listed.values().next().value as string);
  }
  useAgentLogStore.getState().add(entry);
}

/** A replayed cursor's say, still current: its line, unless already listed. */
export function listReplayedSay(cursor: AgentPresenceEvent & { secondsAgo?: number }): void {
  const said = typeof cursor.say === 'string' ? cursor.say.trim() : '';
  const age = typeof cursor.secondsAgo === 'number' && Number.isFinite(cursor.secondsAgo) ? cursor.secondsAgo * 1000 : Infinity;
  if (!said || age >= AGENT_SAY_MS) return;
  listAgentAction(cursor);
}

wsClient.subscribe((event) => {
  if (event.type === 'agentPresence') listAgentAction(event);
  else if (event.type === 'agentPresenceReplay') for (const cursor of event.cursors) listReplayedSay(cursor);
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
