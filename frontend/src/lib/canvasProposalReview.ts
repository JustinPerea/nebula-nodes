import { useCanvasProposalsStore, type ProposalEntry } from '../store/canvasProposalsStore';
import { goToCanvas, onCanvas, whenReady } from './goToCanvas';

/** How long the bar's review ring shows (canvasProposals.css `proposal-bar-review`). */
const RING_MS = 1600;
let ringTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Review on a canvas proposal's Update (Justin's Q112 a, 2026-10-21: "with
 * Review taking you to the canvas and its bar"): go to the open project's
 * canvas from any screen (the way that screen's Back goes; Projects opens the
 * project first), show that proposal in the bar, bring its ghosts into view
 * (`frame`, the corner's spring) and give the bar the keyboard with a short
 * ring. Accept stays a click. Refuses when the proposal is no longer waiting
 * (the backend settles its Update then). Only the Updates corner, a deferred
 * chunk, imports this.
 */
export async function reviewCanvasProposal(
  op: Record<string, unknown>,
  frame?: (entry: ProposalEntry) => void,
): Promise<void> {
  const id = typeof op.proposalId === 'string' ? op.proposalId : '';
  if (!id) throw new Error("This update's proposal can't be opened from here.");
  await goToCanvas();
  const store = useCanvasProposalsStore;
  // Asked for at once, so the bar shows it the moment it draws.
  store.getState().focus(id);
  const waiting = () => {
    const entry = store.getState().proposals[id];
    return entry && !entry.closing ? entry : null;
  };
  const ready = await whenReady(() => onCanvas() && waiting() !== null
    && document.querySelector('.proposal-bar') !== null);
  const entry = waiting();
  if (!ready || !entry) {
    if (store.getState().focusedId === id) store.getState().focus(null);
    throw new Error('This proposal is no longer waiting for you.');
  }
  frame?.(entry);
  const bar = document.querySelector<HTMLElement>('.proposal-bar');
  if (!bar) return;
  bar.focus({ preventScroll: true });
  bar.dataset.review = 'true';
  if (ringTimer !== null) clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    ringTimer = null;
    delete bar.dataset.review;
  }, RING_MS);
}
