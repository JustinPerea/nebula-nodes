import { useMemo } from 'react';
import { personLockLine } from '../lib/errorCopy';
import type { AgentNote, AgentNoteProposal } from '../lib/agentNotes';
import type { AssetProposalKind } from '../lib/assetProposals';
import { selectCanvasList, useAgentNotesStore } from './agentNotesStore';
import { proposalAgentColor, useAssetProposalsStore, type AssetProposalEntry } from './assetProposalsStore';

/**
 * GM r34 (PR #200 fix round 23, review 19 NIT-4): while this tab isn't
 * connected as the person, a new asset proposal reaches it only as its
 * Update (the proposal and its accept key go to the person's sockets only,
 * main.py `broadcast_browser`). Its strip shows a placeholder card for it,
 * built from the Update alone: who asks (in the agent's own colour, GM r35),
 * the real card's header, and one line. No thumbnails, no buttons, no
 * request path. The person's sync after
 * the promote brings the real card into the same place; an Update resolved
 * first (expired, withdrawn) takes the placeholder with it.
 */
export interface HeldProposal {
  proposalId: string;
  agentName: string;
  /** GM r35: the asking agent's identity colour, as on the real card (who asks, not a status). */
  agentColor: string;
  header: string;
  at: number;
}

/** An Update's held Review (and an asset proposal's lock): "window" in the app (PR #204 round 10,
 * review 8 NIT-2), through the one lock line (lib/errorCopy personLockLine). */
export const heldProposalLine = (): string => personLockLine('review this');
/** GM, 2026-10-29: a question set's held action (the Agents panel's Needs-you row), worded as the line above. */
export const heldQuestionsLine = (): string => personLockLine('answer this');

const NO_NOTES: readonly AgentNote[] = [];

/** A ref's count of changes: 1 to 999, anything else (absent, 0) one change
 * (PR #202 review 1 NIT-2: a real ask has at least one edit). */
function changesOf(ref: AgentNoteProposal | null | undefined): number {
  const count = ref?.changes;
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= 999 ? count : 1;
}

/** When the ask was made, for ordering as the real cards and the promoted
 * line order (by the proposal's createdAt): the ref's `since`, which a
 * fallback to an older ask refreshes (PR #202 review 2 LOW-A); an older ref
 * without it, the Update's time. */
function askedAt(note: AgentNote): number {
  if (typeof note.proposal?.since === 'number') return note.proposal.since;
  const at = Date.parse(note.at);
  return Number.isFinite(at) ? at : 0;
}

/** Oldest ask first, the order the held placeholders and lines and the
 * promoted cards and line share; two asks made in the same millisecond go by
 * their proposal ids, so they don't swap on the promote either (PR #202
 * review 3 NIT-1). */
export function askedOrder(left: { at: number; id: string }, right: { at: number; id: string }): number {
  if (left.at !== right.at) return left.at - right.at;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** The real card's header for each kind, from the Update's structured ref
 * (agent_notes.proposal_detail), never its text: review 20 NIT-3, an agent's
 * name in the text could spoof a count. A cover says which kind (GM, PR #200
 * follow-up 2); a ref without it keeps GM r34's "proposes a new cover". */
function headerFor(kind: AssetProposalKind, ref: AgentNoteProposal | null | undefined): string {
  if (kind === 'moodboard') return 'asks to send these notes to generators';
  if (kind === 'commons') {
    const count = changesOf(ref);
    return count === 1 ? 'proposes a change to this reference' : `proposes ${count} changes to this reference`;
  }
  return ref?.cover === 'automatic' ? 'proposes the automatic cover' : 'proposes a new cover';
}

/** The placeholders for one target: its open Updates whose proposal has no card here, oldest first. */
export function heldProposalsFor(notes: readonly AgentNote[], proposals: Readonly<Record<string, AssetProposalEntry>>,
  awaitingSync: boolean, kind: AssetProposalKind, targetId: string): HeldProposal[] {
  if (!awaitingSync) return [];
  const held: HeldProposal[] = [];
  for (const note of notes) {
    if (note.about !== 'proposal' || note.resolvedAt) continue;
    const op = note.actions.find((action) => action.op.kind === 'proposal.review')?.op;
    const proposalId = typeof op?.proposalId === 'string' ? op.proposalId : '';
    if (!proposalId || op?.target !== kind || op.targetId !== targetId || proposals[proposalId]) continue;
    const at = askedAt(note);
    // The Update's author is the proposal's agent (main._post_asset_update: proposal.agent), the
    // same identity, colour included, that the real card's view carries.
    held.push({ proposalId, agentName: note.author.name, agentColor: proposalAgentColor(note.author.color), header: headerFor(kind, note.proposal), at });
  }
  return held.sort((left, right) => askedOrder({ at: left.at, id: left.proposalId }, { at: right.at, id: right.proposalId }));
}

/** The placeholders for one target, for the strip and its host. */
export function useHeldProposals(kind: AssetProposalKind, targetId: string): HeldProposal[] {
  const notes = useAgentNotesStore((state) => selectCanvasList(state).notes ?? NO_NOTES);
  const proposals = useAssetProposalsStore((state) => state.proposals);
  const awaitingSync = useAssetProposalsStore((state) => state.awaitingSync);
  return useMemo(() => heldProposalsFor(notes, proposals, awaitingSync, kind, targetId),
    [notes, proposals, awaitingSync, kind, targetId]);
}

/** GM, PR #202 r1: the Commons proposals line while this tab is held. One
 * entry per open Update, each standing for one proposal, worded as the
 * promoted line words one proposal; CommonsProposalsLine merges them per
 * reference as it does the proposals, with no Review until the promote. The
 * count and the kind come from the Update's ref, never its text or the
 * person-only proposal list. An Update resolved (withdrawn, expired) takes
 * its line with it. */
export interface HeldCommonsLine {
  proposalId: string;
  assetId: string;
  agentName: string;
  agentColor: string;
  asks: string;
  at: number;
}

/** What one Commons proposal asks, in the promoted line's words (CommonsProposalsLine). */
export function commonsAsks(ref: AgentNoteProposal | null | undefined): string {
  const count = changesOf(ref);
  if (count > 1) return `make ${count} changes to a reference`;
  return ref?.inbox ? 'take a reference out of the inbox' : 'change a reference';
}

export function heldCommonsLines(notes: readonly AgentNote[], proposals: Readonly<Record<string, AssetProposalEntry>>,
  awaitingSync: boolean): HeldCommonsLine[] {
  if (!awaitingSync) return [];
  const lines: HeldCommonsLine[] = [];
  for (const note of notes) {
    if (note.about !== 'proposal' || note.resolvedAt) continue;
    const op = note.actions.find((action) => action.op.kind === 'proposal.review')?.op;
    const proposalId = typeof op?.proposalId === 'string' ? op.proposalId : '';
    const assetId = typeof op?.targetId === 'string' ? op.targetId : '';
    if (!proposalId || !assetId || op?.target !== 'commons' || proposals[proposalId]) continue;
    const at = askedAt(note);
    lines.push({ proposalId, assetId, agentName: note.author.name, agentColor: proposalAgentColor(note.author.color),
      asks: commonsAsks(note.proposal), at });
  }
  return lines.sort((left, right) => askedOrder({ at: left.at, id: left.proposalId }, { at: right.at, id: right.proposalId }));
}

export function useHeldCommonsLines(): HeldCommonsLine[] {
  const notes = useAgentNotesStore((state) => selectCanvasList(state).notes ?? NO_NOTES);
  const proposals = useAssetProposalsStore((state) => state.proposals);
  const awaitingSync = useAssetProposalsStore((state) => state.awaitingSync);
  return useMemo(() => heldCommonsLines(notes, proposals, awaitingSync), [notes, proposals, awaitingSync]);
}
