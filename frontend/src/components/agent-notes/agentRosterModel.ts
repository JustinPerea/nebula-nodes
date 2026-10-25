import type { QuestionSetView } from '../../lib/agentQuestions';
import type { AssetProposalKind, AssetProposalView } from '../../lib/assetProposals';
import type { ProposalView } from '../../lib/wsClient';

/**
 * The Agents panel's rows (Q125 item 2, Justin 2026-10-24: "Yes, all four, in
 * that order"), derived from what the stores already hold: each agent's
 * status line and cursor (agentRosterStore, agentPresenceStore), and the open
 * question sets and proposals this tab may answer (their own stores). Pure,
 * so the rules are tested apart from the corner. Copy is GM - Design's,
 * 2026-10-25, verbatim.
 */

export const AGENTS_HEADING = 'Agents';
export const NEEDS_YOU = 'Needs you';
export const WORKING = 'Working';
export const SHOW_ON_CANVAS = 'Show on canvas';
export const OPEN_QUESTIONS = 'Open questions';
export const OPEN_PROPOSAL = 'Open proposal';
export const OPEN_NEXT = 'Open next';
/** Needs you after a restart (no status, no recent action). */
export const WAITING_ANSWER = 'Waiting for your answer.';
export const WAITING_OK = 'Waiting for your OK.';
/** Only when the panel is open as the last agent leaves. */
export const NO_AGENTS = 'No agents are connected right now.';

/** A cursor counts as "around" this long, like the canvas cursor (AGENT_CURSOR_EXPIRE_MS). */
export const ROSTER_CURSOR_MS = 120_000;

export interface RosterAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

/** One agent's status line, `at` in this tab's clock. */
export interface RosterStatus {
  agent: RosterAgent;
  text: string;
  nodeId: string | null;
  projectId: string | null;
  at: number;
}

/** What the agent's last action was (backend agent_presence `did`). */
export interface RosterDid {
  verb: string;
  nodeId: string | null;
  label: string | null;
}

/** One agent's cursor, `at` in this tab's clock. */
export interface RosterCursor {
  agent: RosterAgent;
  nodeId: string | null;
  did: RosterDid | null;
  projectId: string | null;
  at: number;
}

export interface RosterInput {
  /** The open project: only its agents are listed. */
  projectId: string | null;
  now: number;
  statuses: RosterStatus[];
  cursors: RosterCursor[];
  questions: QuestionSetView[];
  canvasProposals: ProposalView[];
  assetProposals: AssetProposalView[];
  /** A node's name on the canvas now (its label, else its type's name), or null when it isn't there. */
  nodeLabel: (nodeId: string) => string | null;
}

export interface RosterCounts {
  questions: number;
  proposals: number;
}

/** What a Needs-you row opens: the oldest open item by creation time. */
export type RosterNext =
  | { kind: 'questions'; setId: string; createdAt: number }
  | { kind: 'proposal'; proposalId: string; target: 'canvas' | AssetProposalKind; targetId: string | null;
    createdAt: number };

export interface RosterRow {
  agent: RosterAgent;
  group: 'needsYou' | 'working';
  counts: RosterCounts;
  /** "1 question, 1 proposal"; empty in Working. */
  countLine: string;
  /** The agent's own status, if it set one. */
  statusText: string | null;
  /** The detail line: the status, else the last action, else (Needs you) the waiting line. */
  line: string;
  /** The node a click brings into view; null when the row has no place on the canvas. */
  flyTo: string | null;
  next: RosterNext | null;
  /** GM's tooltip; null when the row is not a button. */
  tooltip: string | null;
  ariaLabel: string | null;
  /** Needs you: since when it waits (oldest item). Working: last activity. */
  sortAt: number;
}

export function countLine({ questions, proposals }: RosterCounts): string {
  const parts: string[] = [];
  if (questions > 0) parts.push(`${questions} ${questions === 1 ? 'question' : 'questions'}`);
  if (proposals > 0) parts.push(`${proposals} ${proposals === 1 ? 'proposal' : 'proposals'}`);
  return parts.join(', ');
}

export function agoLine(ms: number): string {
  if (ms < 60_000) return 'just now';
  return `${Math.floor(ms / 60_000)} min ago`;
}

/** "Moved “Hero shots” · 2 min ago"; an action on no node is the verb and the time. */
export function actionLine(did: RosterDid, at: number, now: number, nodeLabel: (id: string) => string | null): string {
  const live = did.nodeId ? nodeLabel(did.nodeId) : null;
  const label = live ?? did.label;
  const ago = agoLine(Math.max(0, now - at));
  return label ? `${did.verb} “${label}” · ${ago}` : `${did.verb} · ${ago}`;
}

interface Gathered {
  agent: RosterAgent;
  status: RosterStatus | null;
  cursor: RosterCursor | null;
  questions: QuestionSetView[];
  proposals: Array<{ id: string; target: 'canvas' | AssetProposalKind; targetId: string | null; createdAt: number }>;
}

function agentOf(raw: { id: string; name: string; color: string; verified?: boolean }): RosterAgent {
  return { id: raw.id, name: raw.name, color: raw.color, verified: Boolean(raw.verified) };
}

export function buildRosterRows(input: RosterInput): RosterRow[] {
  const { projectId, now, nodeLabel } = input;
  const byAgent = new Map<string, Gathered>();
  const gather = (agent: RosterAgent): Gathered => {
    let found = byAgent.get(agent.id);
    if (!found) {
      found = { agent, status: null, cursor: null, questions: [], proposals: [] };
      byAgent.set(agent.id, found);
    }
    return found;
  };

  for (const status of input.statuses) {
    if (status.projectId !== projectId || !status.text) continue;
    gather(status.agent).status = status;
  }
  for (const cursor of input.cursors) {
    if (cursor.projectId !== projectId || now - cursor.at >= ROSTER_CURSOR_MS) continue;
    const entry = gather(cursor.agent);
    if (!entry.cursor || entry.cursor.at < cursor.at) entry.cursor = cursor;
  }
  for (const set of input.questions) {
    if (set.status !== 'open' || set.projectId !== projectId) continue;
    gather(agentOf(set.agent)).questions.push(set);
  }
  for (const proposal of input.canvasProposals) {
    if (proposal.status !== 'open' || proposal.projectId !== projectId) continue;
    gather(agentOf(proposal.agent)).proposals.push({ id: proposal.id, target: 'canvas', targetId: null,
      createdAt: proposal.createdAt });
  }
  for (const proposal of input.assetProposals) {
    // Kept with the project its Update went to; one with no Update (made with no
    // project open) counts where the person is now, as the roster read does (main._waiting_in).
    const where = proposal.update?.projectId ?? projectId;
    if (proposal.status !== 'open' || where !== projectId) continue;
    gather(agentOf(proposal.agent)).proposals.push({ id: proposal.id, target: proposal.target.kind,
      targetId: proposal.target.id, createdAt: proposal.createdAt });
  }

  const rows: RosterRow[] = [];
  for (const entry of byAgent.values()) rows.push(rowFor(entry, now, nodeLabel));
  rows.sort((a, b) => {
    if (a.group !== b.group) return a.group === 'needsYou' ? -1 : 1;
    if (a.group === 'needsYou') return a.sortAt - b.sortAt || a.agent.name.localeCompare(b.agent.name);
    return b.sortAt - a.sortAt || a.agent.name.localeCompare(b.agent.name);
  });
  return rows;
}

function rowFor(entry: Gathered, now: number, nodeLabel: (id: string) => string | null): RosterRow {
  const { agent, status, cursor } = entry;
  // Questions, not sets: a set of two reads "2 questions", as its Update does.
  const counts = { questions: entry.questions.reduce((n, set) => n + set.questions.length, 0),
    proposals: entry.proposals.length };
  const needsYou = counts.questions + counts.proposals > 0;
  const statusText = status?.text ?? null;
  const action = cursor?.did?.verb ? actionLine(cursor.did, cursor.at, now, nodeLabel) : null;
  const onCanvas = (id: string | null | undefined) => (id && nodeLabel(id) !== null ? id : null);
  const flyTo = onCanvas(status?.nodeId) ?? onCanvas(cursor?.nodeId);
  const who = agent.verified ? agent.name : `${agent.name}, unverified`;

  if (needsYou) {
    const items: RosterNext[] = [
      ...entry.questions.map((set): RosterNext => ({ kind: 'questions', setId: set.id, createdAt: set.createdAt })),
      ...entry.proposals.map((p): RosterNext => ({ kind: 'proposal', proposalId: p.id, target: p.target,
        targetId: p.targetId, createdAt: p.createdAt })),
    ].sort((a, b) => a.createdAt - b.createdAt);
    const next = items[0];
    const tooltip = counts.questions > 0 && counts.proposals > 0
      ? OPEN_NEXT : counts.questions > 0 ? OPEN_QUESTIONS : OPEN_PROPOSAL;
    const counted = countLine(counts);
    return {
      agent, group: 'needsYou', counts, countLine: counted, statusText,
      line: statusText ?? action ?? (counts.questions > 0 ? WAITING_ANSWER : WAITING_OK),
      flyTo, next, tooltip, ariaLabel: `${who}, ${counted}. ${tooltip}`, sortAt: next.createdAt,
    };
  }

  const line = statusText ?? action ?? '';
  const lastActive = Math.max(status?.at ?? -Infinity, cursor?.at ?? -Infinity);
  return {
    agent, group: 'working', counts, countLine: '', statusText, line, flyTo, next: null,
    tooltip: flyTo ? SHOW_ON_CANVAS : null,
    ariaLabel: flyTo ? `${who}${line ? `, ${line}` : ''}. ${SHOW_ON_CANVAS}` : null,
    sortAt: lastActive,
  };
}
