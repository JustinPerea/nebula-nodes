import { useMemo } from 'react';
import type { AgentNote } from '../lib/agentNotes';
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

export const HELD_PROPOSAL_LINE = 'You can review this when this tab is connected as you.';

const NO_NOTES: readonly AgentNote[] = [];

/** The real card's header for each kind, from what the Update carries. A
 * cover is always "proposes a new cover" (GM r34, verbatim); a Commons ask
 * counts its changes from the Update Nebula wrote (asset_proposals.update_text). */
function headerFor(kind: AssetProposalKind, text: string): string {
  if (kind === 'moodboard') return 'asks to send these notes to generators';
  if (kind === 'commons') {
    const count = Number(/asks to make (\d+) changes/.exec(text)?.[1] ?? 1);
    return count > 1 ? `proposes ${count} changes to this reference` : 'proposes a change to this reference';
  }
  return 'proposes a new cover';
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
    const at = Date.parse(note.at);
    // The Update's author is the proposal's agent (main._post_asset_update: proposal.agent), the
    // same identity, colour included, that the real card's view carries.
    held.push({ proposalId, agentName: note.author.name, agentColor: proposalAgentColor(note.author.color), header: headerFor(kind, note.text), at: Number.isFinite(at) ? at : 0 });
  }
  return held.sort((left, right) => left.at - right.at);
}

/** The placeholders for one target, for the strip and its host. */
export function useHeldProposals(kind: AssetProposalKind, targetId: string): HeldProposal[] {
  const notes = useAgentNotesStore((state) => selectCanvasList(state).notes ?? NO_NOTES);
  const proposals = useAssetProposalsStore((state) => state.proposals);
  const awaitingSync = useAssetProposalsStore((state) => state.awaitingSync);
  return useMemo(() => heldProposalsFor(notes, proposals, awaitingSync, kind, targetId),
    [notes, proposals, awaitingSync, kind, targetId]);
}
