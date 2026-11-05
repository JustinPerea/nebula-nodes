import { waitLineId } from './canvasProposals';
import type { useCanvasProposalsStore } from '../store/canvasProposalsStore';

/** What a node's band shows: the proposal it speaks for, and how many wait on the node. */
export interface WaitBand {
  proposalId: string;
  count: number;
  color: string;
  line: string;
  /** The bar's line it points at, while the bar shows that proposal. */
  describedBy: string | null;
}

type ProposalsState = ReturnType<typeof useCanvasProposalsStore.getState>;

/**
 * The band on a node a run the daily total holds waits on (GM - Design,
 * 2026-10-31, round 2 of PR #212): the proposal the bar shows when it is one
 * of this node's, else the newest, and how many wait on the node.
 */
export function waitBandFor(state: ProposalsState, nodeId: string): WaitBand | null {
  const waiting = Object.values(state.proposals)
    .filter((entry) => !entry.closing && entry.view.wait?.nodeIds.includes(nodeId))
    .map((entry) => entry.view);
  if (waiting.length === 0) return null;
  const shown = waiting.find((view) => view.id === state.shownId)
    ?? [...waiting].sort((a, b) => b.createdAt - a.createdAt)[0];
  return {
    proposalId: shown.id,
    count: waiting.length,
    color: shown.agent.color,
    line: shown.wait?.cardLine ?? '',
    describedBy: state.shownId === shown.id ? waitLineId(shown.id) : null,
  };
}

/** One string per band, so a node re-renders only when its own band changes. */
export function bandKey(band: WaitBand | null): string {
  return band ? JSON.stringify(band) : '';
}

