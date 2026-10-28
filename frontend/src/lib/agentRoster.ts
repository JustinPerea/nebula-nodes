import { apiFetch } from './backend';

/**
 * The roster read (Q125 item 2): who is around in the open project, with
 * each agent's status line, its cursor's last action and how many questions
 * and proposals wait (backend services/agent_status.build_roster, GET
 * /api/canvas/agents). The same read agents make (list_agents, `nebula
 * agents`). Counts only.
 */

export interface RosterEntryAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

export interface RosterEntry {
  agent: RosterEntryAgent;
  group: 'needsYou' | 'working';
  status: { text: string; nodeId: string | null; secondsAgo: number } | null;
  lastAction: { verb: string; nodeId: string | null; label: string | null; secondsAgo: number } | null;
  cursor: { nodeId: string | null; action: string; secondsAgo: number } | null;
  needsYou: { questions: number; proposals: number };
  waitingSeconds: number | null;
  activeSecondsAgo: number | null;
  /** Its placeholders on the open canvas (Q125 item 3). */
  pending?: string[];
  /** The nodes its runs are running now. */
  running?: Array<{ runId: string; nodeId: string; model: string | null; secondsAgo: number }>;
}

export interface RosterListing {
  projectId: string | null;
  agents: RosterEntry[];
  /** The status book's revision when read: events with a higher one are newer. */
  rev: number;
}

/** Throws on any failure: the panel then keeps what it has (no copy for it). */
export async function fetchAgentRoster(): Promise<RosterListing> {
  const response = await apiFetch('/api/canvas/agents');
  if (!response.ok) throw new Error(`roster read failed (${response.status})`);
  return (await response.json()) as RosterListing;
}
