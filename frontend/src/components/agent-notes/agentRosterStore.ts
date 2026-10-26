import { create } from 'zustand';
import { fetchAgentRoster, type RosterListing } from '../../lib/agentRoster';
import { wsClient, type AgentRunEvent, type AgentStatusEvent } from '../../lib/wsClient';
import type { RosterAgent, RosterCursor, RosterRun, RosterStatus } from './agentRosterModel';

/**
 * What the Agents panel (Q125 item 2) knows that no other store holds: each
 * agent's status line, and the cursors the roster read reported (a cursor
 * that moved before this tab loaded has no event here). Kept live from the
 * `agentStatus` socket events, read again when the socket reconnects (a
 * restart clears every status) and when the canvas's graph is replaced (a
 * project switch). No polling.
 *
 * It also keeps the nodes agents' runs are running now (Q125 item 3), from
 * `agentRun` events and the roster's `running`, for the mark on each node
 * (components/canvas/AgentNodeMarkLayer.tsx, which reads the roster when it
 * mounts, so a tab that loads mid-run has them).
 *
 * In the panel's chunk: it loads with the Updates corner, and the panel reads
 * the roster each time it mounts, so nothing sent before is missed.
 */

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

interface AgentRosterState {
  statuses: Record<string, RosterStatus>;
  /** Cursors as the last read reported them; the live ones are agentPresenceStore's. */
  cursors: Record<string, RosterCursor>;
  /** Nodes agents' runs are running now, by `${runId}:${nodeId}`. */
  runs: Record<string, RosterRun>;
  /** When the last applied read was asked for: it reports every cursor the
   *  backend still had then, so a live cursor heard before it (one a restart
   *  cleared) no longer counts. */
  readAt: number;
  /** The panel is open (the person opened it; nothing else opens it). */
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  applyStatus: (event: AgentStatusEvent, now?: number) => void;
  applyRun: (event: AgentRunEvent, now?: number) => void;
  applyRoster: (listing: RosterListing, fetchedAt?: number) => void;
  reset: () => void;
}

function cleanAgent(raw: unknown): RosterAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const agent = raw as Record<string, unknown>;
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string') return null;
  return {
    id: agent.id,
    name: agent.name,
    color: typeof agent.color === 'string' && SAFE_COLOR.test(agent.color) ? agent.color : '#E8825A',
    verified: agent.verified === true,
  };
}

const seconds = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0);

export const useAgentRosterStore = create<AgentRosterState>((set) => ({
  statuses: {},
  cursors: {},
  runs: {},
  readAt: 0,
  expanded: false,
  setExpanded: (expanded) => set({ expanded }),
  applyStatus: (event, now = Date.now()) => {
    const agent = cleanAgent(event.agent);
    if (!agent) return;
    set((state) => {
      const statuses = { ...state.statuses };
      const status = event.status;
      if (!status || typeof status.text !== 'string' || !status.text) {
        delete statuses[agent.id];
      } else {
        statuses[agent.id] = {
          agent,
          text: status.text,
          nodeId: typeof status.nodeId === 'string' ? status.nodeId : null,
          projectId: typeof status.projectId === 'string' ? status.projectId : null,
          // This tab's clock: the line's age never depends on clock skew.
          at: now - seconds(status.secondsAgo) * 1000,
        };
      }
      return { statuses };
    });
  },
  applyRun: (event, now = Date.now()) => {
    const agent = cleanAgent(event.agent);
    if (!agent || typeof event.runId !== 'string' || typeof event.nodeId !== 'string') return;
    const key = `${event.runId}:${event.nodeId}`;
    set((state) => {
      const runs = { ...state.runs };
      if (event.change === 'started') {
        runs[key] = {
          agent, runId: event.runId, nodeId: event.nodeId,
          model: typeof event.model === 'string' && event.model ? event.model : null,
          projectId: typeof event.projectId === 'string' ? event.projectId : null,
          at: now - seconds(event.secondsAgo) * 1000,
        };
      } else {
        delete runs[key];
      }
      return { runs };
    });
  },
  applyRoster: (listing, fetchedAt = Date.now()) => {
    const projectId = typeof listing.projectId === 'string' ? listing.projectId : null;
    const statuses: Record<string, RosterStatus> = {};
    const cursors: Record<string, RosterCursor> = {};
    const runs: Record<string, RosterRun> = {};
    for (const entry of Array.isArray(listing.agents) ? listing.agents : []) {
      const agent = cleanAgent(entry?.agent);
      if (!agent) continue;
      for (const running of Array.isArray(entry.running) ? entry.running : []) {
        if (!running || typeof running.runId !== 'string' || typeof running.nodeId !== 'string') continue;
        runs[`${running.runId}:${running.nodeId}`] = {
          agent, runId: running.runId, nodeId: running.nodeId, projectId,
          model: typeof running.model === 'string' && running.model ? running.model : null,
          at: fetchedAt - seconds(running.secondsAgo) * 1000,
        };
      }
      if (entry.status && typeof entry.status.text === 'string' && entry.status.text) {
        statuses[agent.id] = {
          agent, text: entry.status.text, projectId,
          nodeId: typeof entry.status.nodeId === 'string' ? entry.status.nodeId : null,
          at: fetchedAt - seconds(entry.status.secondsAgo) * 1000,
        };
      }
      if (entry.cursor) {
        const did = entry.lastAction && typeof entry.lastAction.verb === 'string' && entry.lastAction.verb
          ? {
            verb: entry.lastAction.verb,
            nodeId: typeof entry.lastAction.nodeId === 'string' ? entry.lastAction.nodeId : null,
            label: typeof entry.lastAction.label === 'string' && entry.lastAction.label ? entry.lastAction.label : null,
            // The action's own time, not the cursor's (GM's review: a click keeps the action before it).
            at: fetchedAt - seconds(entry.lastAction.secondsAgo) * 1000,
          }
          : null;
        cursors[agent.id] = {
          agent, did, projectId,
          nodeId: typeof entry.cursor.nodeId === 'string' ? entry.cursor.nodeId : null,
          at: fetchedAt - seconds(entry.cursor.secondsAgo) * 1000,
        };
      }
    }
    set({ statuses, cursors, runs, readAt: fetchedAt });
  },
  reset: () => {
    reading = null;
    pending.length = 0;
    set({ statuses: {}, cursors: {}, runs: {}, readAt: 0, expanded: false });
  },
}));

/** The read in flight, and the status events that arrived during it. */
let reading: Promise<void> | null = null;
let again = false;
const pending: AgentStatusEvent[] = [];

/**
 * Read the roster. Events that arrive during the read are applied at once
 * and again after it, when the read is older than they are (its `rev`), so
 * neither wins wrongly. A failed read keeps what the panel has.
 */
export function refreshAgentRoster(): Promise<void> {
  if (reading) {
    again = true;
    return reading;
  }
  pending.length = 0;
  const askedAt = Date.now();
  const run = fetchAgentRoster()
    .then((listing) => {
      if (reading !== run) return;
      const store = useAgentRosterStore.getState();
      store.applyRoster(listing, askedAt);
      const rev = typeof listing.rev === 'number' ? listing.rev : 0;
      for (const event of pending) if (event.rev > rev) store.applyStatus(event);
    })
    .catch(() => {})
    .finally(() => {
      if (reading !== run) return;
      reading = null;
      pending.length = 0;
      if (again) {
        again = false;
        void refreshAgentRoster();
      }
    });
  reading = run;
  return run;
}

wsClient.subscribe((event) => {
  if (event.type === 'agentStatus') {
    useAgentRosterStore.getState().applyStatus(event);
    if (reading) pending.push(event);
  } else if (event.type === 'agentRun') {
    useAgentRosterStore.getState().applyRun(event);
  } else if (event.type === 'socketReconnected' || (event.type === 'graphSync' && event.graphReplaced)) {
    void refreshAgentRoster();
  }
});
