import {
  DeferredAgentCursorLayer,
  DeferredPinLayer,
  DeferredProposalBar,
  DeferredProposalLayer,
} from '../../lib/deferredChunks';
import { deferredAtOnce } from '../deferredAtOnce';
// The agent cursors' store subscribes to the socket at import; it stays in
// the startup entry so presence that arrives before the layer is not missed.
// (The proposals and pins stores are imported eagerly by useFitCanvasView and
// ContextMenu; tests/entrySplit.test.ts checks all three.)
import '../../store/agentPresenceStore';

/**
 * Canvas overlays that draw only what the socket or a fetch brings in: an
 * agent's proposal (its ghosts and its decision bar, which also carries the
 * undo notice after an undo), the person's pins, the agents' cursors. None of
 * that exists at the first paint (it arrives over the socket or a fetch after
 * it), so each mounts inside Canvas straight away, draws nothing until its
 * chunk lands, and App preloads the chunks on idle. If data beats a chunk, it
 * appears when the chunk does, exactly as if it had arrived that much later;
 * nothing already on screen moves.
 */
export const ProposalBar = deferredAtOnce(DeferredProposalBar, 'ProposalBar');
export const ProposalLayer = deferredAtOnce(DeferredProposalLayer, 'ProposalLayer');
export const PinLayer = deferredAtOnce(DeferredPinLayer, 'PinLayer');
export const AgentCursorLayer = deferredAtOnce(DeferredAgentCursorLayer, 'AgentCursorLayer');
