import type { AgentNote } from '../../lib/agentNotes';
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
 *
 * GM, 2026-10-29 (the held needs-you count): a tab that isn't connected as
 * the person holds none of those (they go to the person's sockets only), yet
 * the agents still wait. So the open project's unresolved ask Updates come
 * into the same rule (`held`): each one stands for its ask until this tab
 * holds the ask itself (the person's sync after the promote), matched by id,
 * so the count and the rows never change on the promote. Only what the
 * Updates already carry: who asks, its kind and target, when (the ref's
 * `since`), and a question set's count; never their text.
 */

export interface WaitingAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

/** An ask known only from its Update (`heldAsks`): this tab can't act on it yet. */
export interface HeldAsk {
  agent: { id: string; name: string; color: string; verified?: boolean };
  kind: 'questions' | 'proposal';
  id: string;
  target: 'canvas' | AssetProposalKind | null;
  targetId: string | null;
  createdAt: number;
  /** How many questions a set asks (1 for a proposal). */
  count: number;
}

export interface WaitingInput {
  /** The open project: only what waits there counts. */
  projectId: string | null;
  questions: QuestionSetView[];
  canvasProposals: ProposalView[];
  assetProposals: AssetProposalView[];
  /** The open project's ask Updates whose asks this tab doesn't hold (heldAsks). */
  held?: HeldAsk[];
}

export interface WaitingProposal {
  id: string;
  target: 'canvas' | AssetProposalKind;
  targetId: string | null;
  createdAt: number;
  /** Known only from its Update: shown, not yet openable here. */
  held?: boolean;
}

export interface WaitingQuestions {
  id: string;
  /** How many questions the set asks. */
  count: number;
  createdAt: number;
  held?: boolean;
}

export interface Waiting {
  agent: WaitingAgent;
  questions: WaitingQuestions[];
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
  const known = new Set<string>();
  for (const set of input.questions) {
    if (set.status !== 'open' || set.projectId !== projectId) continue;
    known.add(set.id);
    entry(set.agent).questions.push({ id: set.id, count: set.questions.length, createdAt: set.createdAt });
  }
  for (const proposal of input.canvasProposals) {
    if (proposal.status !== 'open' || proposal.projectId !== projectId) continue;
    known.add(proposal.id);
    entry(proposal.agent).proposals.push({ id: proposal.id, target: 'canvas', targetId: null,
      createdAt: proposal.createdAt });
  }
  for (const proposal of input.assetProposals) {
    // Kept with the project its Update went to; one with no Update (made with no
    // project open) counts where the person is now, as the roster read does (main._waiting_in).
    const where = proposal.update?.projectId ?? projectId;
    if (proposal.status !== 'open' || where !== projectId) continue;
    known.add(proposal.id);
    entry(proposal.agent).proposals.push({ id: proposal.id, target: proposal.target.kind,
      targetId: proposal.target.id, createdAt: proposal.createdAt });
  }
  // Updates are the open project's own list, so they wait here.
  for (const ask of input.held ?? []) {
    if (known.has(ask.id)) continue;
    known.add(ask.id);
    if (ask.kind === 'questions') {
      entry(ask.agent).questions.push({ id: ask.id, count: ask.count, createdAt: ask.createdAt, held: true });
    } else if (ask.target) {
      entry(ask.agent).proposals.push({ id: ask.id, target: ask.target, targetId: ask.targetId,
        createdAt: ask.createdAt, held: true });
    }
  }
  return byAgent;
}

/** How many questions an agent's open sets hold (a set of two reads "2 questions", as its Update does). */
export function questionCount(waiting: Waiting): number {
  return waiting.questions.reduce((n, set) => n + set.count, 0);
}

const ASK_TARGETS = new Set(['canvas', 'project', 'moodboard', 'commons']);

/**
 * The open project's unresolved ask Updates (a proposal's or a question
 * set's, written by Nebula for an agent) whose ask isn't among `held`'s
 * ids: the asks this tab knows only from their Updates. When: the ref's
 * `since` (the ask's createdAt, as the views say), else the Update's time.
 */
export function heldAsks(notes: readonly AgentNote[], holds: (id: string) => boolean): HeldAsk[] {
  const asks: HeldAsk[] = [];
  for (const note of notes) {
    if (note.resolvedAt || note.source !== 'nebula' || note.author.kind !== 'agent') continue;
    const posted = Date.parse(note.at);
    const at = Number.isFinite(posted) ? posted : 0;
    const agent = { id: note.author.id, name: note.author.name, color: note.author.color,
      verified: note.author.verified };
    if (note.about === 'proposal') {
      const op = note.actions.find((action) => action.op.kind === 'proposal.review')?.op;
      const id = typeof op?.proposalId === 'string' ? op.proposalId : '';
      const target = typeof op?.target === 'string' && ASK_TARGETS.has(op.target) ? op.target as HeldAsk['target'] : null;
      if (!id || !target || holds(id)) continue;
      asks.push({ agent, kind: 'proposal', id, target, targetId: typeof op?.targetId === 'string' ? op.targetId : null,
        createdAt: note.proposal?.since ?? at, count: 1 });
    } else if (note.about === 'question') {
      const id = note.questionsId ?? '';
      if (!id || holds(id)) continue;
      asks.push({ agent, kind: 'questions', id, target: null, targetId: null,
        createdAt: note.questionsSince ?? at, count: note.questionsCount ?? 1 });
    }
  }
  return asks;
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
