import type { QuestionSetView } from '../../lib/agentQuestions';
import type { AssetProposalKind, AssetProposalView } from '../../lib/assetProposals';
import type { ProposalView } from '../../lib/wsClient';

/**
 * What needs the person, per agent: the open question sets and proposals of
 * the open project this tab can answer (Q125 item 2). One rule for the
 * Agents panel's Needs-you group (agentRosterModel) and the closed Updates
 * chip's badge (GM - Design's review of PR #193: "A waiting question blocks
 * an agent, so 'Updates 0' mustn't hide it"), so the two counts always
 * match. Pure, and in the corner's chunk (the chip reads it through
 * AgentNotesCorner's useNeedsYouCount); the panel's own chunk is never
 * pulled in for a count.
 */

export interface WaitingAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

export interface WaitingInput {
  /** The open project: only what waits there counts. */
  projectId: string | null;
  questions: QuestionSetView[];
  canvasProposals: ProposalView[];
  assetProposals: AssetProposalView[];
}

export interface WaitingProposal {
  id: string;
  target: 'canvas' | AssetProposalKind;
  targetId: string | null;
  createdAt: number;
}

export interface Waiting {
  agent: WaitingAgent;
  questions: QuestionSetView[];
  proposals: WaitingProposal[];
}

export function agentOf(raw: { id: string; name: string; color: string; verified?: boolean }): WaitingAgent {
  return { id: raw.id, name: raw.name, color: raw.color, verified: Boolean(raw.verified) };
}

/** Each agent's open sets and proposals in the open project, by agent id. */
export function waitingByAgent(input: WaitingInput): Map<string, Waiting> {
  const { projectId } = input;
  const byAgent = new Map<string, Waiting>();
  const entry = (raw: { id: string; name: string; color: string; verified?: boolean }): Waiting => {
    let found = byAgent.get(raw.id);
    if (!found) {
      found = { agent: agentOf(raw), questions: [], proposals: [] };
      byAgent.set(raw.id, found);
    }
    return found;
  };
  for (const set of input.questions) {
    if (set.status !== 'open' || set.projectId !== projectId) continue;
    entry(set.agent).questions.push(set);
  }
  for (const proposal of input.canvasProposals) {
    if (proposal.status !== 'open' || proposal.projectId !== projectId) continue;
    entry(proposal.agent).proposals.push({ id: proposal.id, target: 'canvas', targetId: null,
      createdAt: proposal.createdAt });
  }
  for (const proposal of input.assetProposals) {
    // Kept with the project its Update went to; one with no Update (made with no
    // project open) counts where the person is now, as the roster read does (main._waiting_in).
    const where = proposal.update?.projectId ?? projectId;
    if (proposal.status !== 'open' || where !== projectId) continue;
    entry(proposal.agent).proposals.push({ id: proposal.id, target: proposal.target.kind,
      targetId: proposal.target.id, createdAt: proposal.createdAt });
  }
  return byAgent;
}

/** How many questions an agent's open sets hold (a set of two reads "2 questions", as its Update does). */
export function questionCount(waiting: Waiting): number {
  return waiting.questions.reduce((n, set) => n + set.questions.length, 0);
}

export function isWaiting(waiting: Waiting): boolean {
  return questionCount(waiting) + waiting.proposals.length > 0;
}

/** How many agents need the person: the panel's Needs-you group. */
export function needsYouCount(input: WaitingInput): number {
  let count = 0;
  for (const waiting of waitingByAgent(input).values()) if (isWaiting(waiting)) count += 1;
  return count;
}

/** The sets and proposals this tab may act on: a set it holds the answer key for, a proposal not closing. */
export function answerableQuestions(sets: Record<string, { view: QuestionSetView; answerKey?: string }>): QuestionSetView[] {
  return Object.values(sets).filter((entry) => entry.answerKey).map((entry) => entry.view);
}

export function openViews<T>(entries: Record<string, { view: T; closing?: unknown }>): T[] {
  return Object.values(entries).filter((entry) => !entry.closing).map((entry) => entry.view);
}
