import { create } from 'zustand';
import {
  wsClient,
  type ProposalClosedEvent,
  type ProposalPersonValues,
  type ProposalStatus,
  type ProposalView,
} from '../lib/wsClient';
import {
  acceptProposal,
  ProposalRequestError,
  rejectProposal,
  releaseApproval,
  runsNothing,
  withAncestors,
} from '../lib/canvasProposals';
import type { Point } from '../lib/agentCursorMotion';
import { useGraphStore, watchGraphSyncs } from './graphStore';
import { PERSON_REQUIRED_CODE, failureMessage } from '../lib/errorCopy';
import { refuseEditWhileOffline } from '../lib/backendConnection';
import { onPersonPromoted, personGateHeld } from '../lib/personSession';
import { clearLineOnPromote } from '../lib/clearsOnPromote';
import { refuseEditWhileFollowing } from '../lib/canvasFollow';

/** How long a closed proposal's ghosts fade before they go. Matches canvasProposals.css. */
/** The answer's code for an Accept refused because the canvas was cleared or
 * replaced after the proposal was made (backend PROPOSAL_CANVAS_REPLACED_CODE). */
export const PROPOSAL_CANVAS_REPLACED_CODE = 'proposal_canvas_replaced';
/** GM - Design, round 22 (4b), verbatim; the same with no agent named. */
export const PROPOSAL_CANVAS_REPLACED_LINE =
  "Couldn't accept this proposal. The canvas was cleared or replaced after it was made. Ask the agent for a new one.";

export const PROPOSAL_EXIT_MS = 220;

export interface ProposalEntry {
  view: ProposalView;
  /**
   * Proof this canvas may decide the proposal. It arrives only over this
   * page's browser WebSocket, lives only in memory, and is never persisted,
   * logged or shown.
   */
  acceptKey: string;
  /** Exactly what Accept will write, shown in the bar's details. Browser-only. */
  values?: ProposalPersonValues;
  /** Set while the ghosts fade out after the proposal closed. */
  closing?: Exclude<ProposalStatus, 'open'>;
}

/** Nodes an accepted proposal added that are waiting for the current run to finish. */
export interface DeferredRun {
  agentName: string;
  nodeIds: string[];
  /** The Accept click's approval for exactly these runs; the run carries it. */
  approvalId: string | null;
}

interface CanvasProposalsState {
  proposals: Record<string, ProposalEntry>;
  /** Where the person dragged ghosts, per proposal and ref. Sent with Accept. */
  drag: Record<string, Record<string, Point>>;
  pending: Record<string, 'accept' | 'reject'>;
  errors: Record<string, string>;
  focusedId: string | null;
  /** The held run the notice shows (the oldest), and those waiting behind it
   * in the order they were accepted (review 16, L-2): each runs once. */
  deferredRun: DeferredRun | null;
  deferredQueue: DeferredRun[];
  sync: (proposals: Array<ProposalView & { acceptKey: string; personValues?: ProposalPersonValues }>) => void;
  open: (view: ProposalView, acceptKey: string, values?: ProposalPersonValues) => void;
  close: (event: Pick<ProposalClosedEvent, 'proposalId' | 'status'>) => void;
  clear: () => void;
  pruneExpired: (now?: number) => void;
  focus: (id: string | null) => void;
  moveGhost: (id: string, ref: string, position: Point) => void;
  accept: (id: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
  runDeferred: () => Promise<void>;
  dismissDeferred: () => void;
}

/** The held run after the one the notice shows, if any, takes its place. */
function nextDeferred(state: Pick<CanvasProposalsState, 'deferredQueue'>): Pick<CanvasProposalsState, 'deferredRun' | 'deferredQueue'> {
  const [next = null, ...rest] = state.deferredQueue;
  return { deferredRun: next, deferredQueue: rest };
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

function finitePoint(value: unknown): value is Point {
  const point = value as Point | null;
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Drop malformed proposals; the agent colour goes into CSS, so only plain hex passes. */
function clean(view: ProposalView): ProposalView | null {
  if (!view || typeof view.id !== 'string' || !Array.isArray(view.nodes) || !Array.isArray(view.edges)) return null;
  if (!view.nodes.every((node) => typeof node.ref === 'string' && finitePoint(node.position))) return null;
  const color = SAFE_COLOR.test(view.agent?.color ?? '') ? view.agent.color : '#5B9DFF';
  return {
    ...view,
    agent: { ...view.agent, name: String(view.agent?.name ?? 'Agent'), color },
    params: Array.isArray(view.params) ? view.params : [],
    run: Array.isArray(view.run) ? view.run : [],
    references: Array.isArray(view.references) ? view.references : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanValues(values: unknown): ProposalPersonValues | undefined {
  if (!isRecord(values) || !isRecord(values.nodes) || !isRecord(values.params)) return undefined;
  return values as unknown as ProposalPersonValues;
}

/** Review 17 LOW-1 (fix round 20), through the one mechanism since GM's
 * #204 round 3 rule: a proposal's error that is the person gate's refusal
 * (403 person_required) clears when the server promotes the tab, while it is
 * still that proposal's error. */
const clearRefusalOnPromote = (id: string, error: unknown, message: string) => {
  clearLineOnPromote(error, () => useCanvasProposalsStore.getState().errors[id], message,
    () => useCanvasProposalsStore.setState((state) => ({ errors: without(state.errors, id) })));
};

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

function cancelExit(id: string): void {
  const timer = exitTimers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  exitTimers.delete(id);
}

/**
 * Run accepted nodes through the canvas's normal guarded run path, carrying
 * the Accept click's approval. The backend starts the run only if it is still
 * exactly what was accepted. Afterwards the approval is released: a run that
 * started already used it up, and one the canvas declined to start (a cost
 * confirm said no, say) must not keep the nodes locked against agent edits.
 */
async function runNodes(nodeIds: string[], approvalId: string | null): Promise<void> {
  const graph = useGraphStore.getState();
  const options = approvalId ? { approvalId } : undefined;
  try {
    if (nodeIds.length === 1) {
      await graph.executeNode(nodeIds[0], options);
    } else {
      // executeCluster runs exactly the nodes it is given, so include what feeds them.
      await graph.executeCluster(withAncestors(nodeIds, graph.edges), options);
    }
  } finally {
    if (approvalId) await releaseApproval(approvalId);
  }
}

export const useCanvasProposalsStore = create<CanvasProposalsState>((set, get) => ({
  proposals: {},
  drag: {},
  pending: {},
  errors: {},
  focusedId: null,
  deferredRun: null,
  deferredQueue: [],

  sync: (list) => {
    for (const id of exitTimers.keys()) cancelExit(id);
    const proposals: Record<string, ProposalEntry> = {};
    for (const raw of Array.isArray(list) ? list : []) {
      const view = clean(raw);
      if (view && view.status === 'open' && typeof raw.acceptKey === 'string') {
        const { acceptKey } = raw;
        const values = cleanValues(raw.personValues);
        delete (view as Partial<ProposalView & { acceptKey: string; personValues: unknown }>).acceptKey;
        delete (view as Partial<ProposalView & { acceptKey: string; personValues: unknown }>).personValues;
        proposals[view.id] = { view, acceptKey, values };
      }
    }
    set((state) => ({
      proposals,
      drag: Object.fromEntries(Object.entries(state.drag).filter(([id]) => id in proposals)),
      focusedId: state.focusedId && state.focusedId in proposals ? state.focusedId : null,
    }));
  },

  open: (raw, acceptKey, values) => {
    const view = clean(raw);
    if (!view || typeof acceptKey !== 'string' || !acceptKey) return;
    cancelExit(view.id);
    set((state) => ({
      proposals: { ...state.proposals, [view.id]: { view, acceptKey, values: cleanValues(values) } },
    }));
  },

  close: ({ proposalId, status }) => {
    const entry = get().proposals[proposalId];
    if (!entry || entry.closing) return;
    set((state) => ({ proposals: { ...state.proposals, [proposalId]: { ...entry, closing: status } } }));
    cancelExit(proposalId);
    exitTimers.set(proposalId, setTimeout(() => {
      exitTimers.delete(proposalId);
      set((state) => ({
        proposals: without(state.proposals, proposalId),
        drag: without(state.drag, proposalId),
        pending: without(state.pending, proposalId),
        errors: without(state.errors, proposalId),
        focusedId: state.focusedId === proposalId ? null : state.focusedId,
      }));
    }, PROPOSAL_EXIT_MS));
  },

  clear: () => {
    for (const id of exitTimers.keys()) cancelExit(id);
    set({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null });
  },

  pruneExpired: (now = Date.now()) => {
    for (const entry of Object.values(get().proposals)) {
      if (!entry.closing && entry.view.expiresAt <= now) get().close({ proposalId: entry.view.id, status: 'expired' });
    }
  },

  focus: (id) => set({ focusedId: id }),

  moveGhost: (id, ref, position) => {
    if (!get().proposals[id] || !finitePoint(position)) return;
    set((state) => ({ drag: { ...state.drag, [id]: { ...state.drag[id], [ref]: position } } }));
  },

  accept: async (id) => {
    const entry = get().proposals[id];
    if (!entry || entry.closing || get().pending[id]) return;
    // Not while the canvas follows an agent's project switch (round 21,
    // review 20 L-1: the canvas is about to go; the bar pulses), as the
    // store's gates ask it first. Offline is read-only (round 15 of PR
    // #114): nothing is sent or marked; the banner pulses.
    if (refuseEditWhileFollowing()) return;
    if (refuseEditWhileOffline()) return;
    set((state) => ({ pending: { ...state.pending, [id]: 'accept' }, errors: without(state.errors, id) }));
    // Accepting is one undo step: the canvas before the proposal's nodes
    // arrive, taken before the backend's graphSync can bring them.
    const undoStep = useGraphStore.getState().beginUndoStep();
    const synced = watchGraphSyncs();
    let accepted = false;
    try {
      const result = await acceptProposal(id, entry.acceptKey, get().drag[id] ?? {});
      accepted = true;
      synced.stop();
      useGraphStore.getState().adoptAcceptedProposal(result, { undoStep, synced: synced.seen });
      // Its nodes are on the canvas: an undo pressed meanwhile acts now, not after the run below.
      useGraphStore.getState().endUndoStep(undoStep);
      get().close({ proposalId: id, status: 'accepted' });
      // Undone while it was on its way (review 11, L-5): its nodes are off
      // the canvas, so its run goes nowhere; the approval goes back instead.
      const onCanvas = new Set(useGraphStore.getState().nodes.map((node) => node.id));
      const undone = result.runNodeIds.some((nodeId) => !onCanvas.has(nodeId));
      if (result.runNodeIds.length > 0 && undone) {
        if (result.approvalId) await releaseApproval(result.approvalId);
      } else if (result.runNodeIds.length > 0 && runsNothing(entry.view)) {
        // Its whole run waits on agents' placeholders, so the button said
        // "Accept" (GM - Design, round 5): no run, no Run history entry, no
        // held run, and the approval goes back (review 5, L1).
        if (result.approvalId) await releaseApproval(result.approvalId);
      } else if (result.runNodeIds.length > 0) {
        // A run waiting for its inputs counts as running (review 15, M-B).
        if (useGraphStore.getState().isExecuting || useGraphStore.getState().runStarting) {
          const deferred = { agentName: entry.view.agent.name, nodeIds: result.runNodeIds, approvalId: result.approvalId };
          // One already held: this one waits behind it (review 16, L-2).
          set((state) => state.deferredRun
            ? { deferredQueue: [...state.deferredQueue, deferred] } : { deferredRun: deferred });
        } else {
          // The Accept click is the person's approval for these runs, at these values.
          await runNodes(result.runNodeIds, result.approvalId);
        }
      }
    } catch (error) {
      if (!accepted) useGraphStore.getState().cancelUndoStep(undoStep);
      // A person-only refusal (this tab isn't connected as the person) says
      // GM's line, by its code (Q116 a); a refused accept key, the canvas line.
      // GM round 22 (4b): a proposal made before a clear or an import of
      // this canvas, by the answer's code (never its words).
      const message = error instanceof ProposalRequestError && error.code === PROPOSAL_CANVAS_REPLACED_CODE
        ? PROPOSAL_CANVAS_REPLACED_LINE
        : error instanceof ProposalRequestError && error.status === 403 && error.code !== PERSON_REQUIRED_CODE
        ? 'Only the canvas can accept this. Reload the page.'
        : failureMessage(error, "Couldn't accept the proposal.");
      set((state) => ({ errors: { ...state.errors, [id]: message } }));
      clearRefusalOnPromote(id, error, message);
    } finally {
      // On every path (ending twice is harmless): an undo pressed meanwhile acts (review 10, L-2).
      useGraphStore.getState().endUndoStep(undoStep);
      synced.stop();
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  reject: async (id, reason) => {
    const entry = get().proposals[id];
    if (!entry || entry.closing || get().pending[id]) return;
    // Offline is read-only (round 15 of PR #114): nothing is sent or marked;
    // the banner pulses.
    if (refuseEditWhileOffline()) return;
    set((state) => ({ pending: { ...state.pending, [id]: 'reject' }, errors: without(state.errors, id) }));
    try {
      await rejectProposal(id, entry.acceptKey, reason);
      get().close({ proposalId: id, status: 'rejected' });
    } catch (error) {
      const message = error instanceof ProposalRequestError && error.status === 403 && error.code !== PERSON_REQUIRED_CODE
        ? 'Only the canvas can reject this. Reload the page.'
        : failureMessage(error, "Couldn't reject the proposal.");
      set((state) => ({ errors: { ...state.errors, [id]: message } }));
      clearRefusalOnPromote(id, error, message);
    } finally {
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  runDeferred: async () => {
    const deferred = get().deferredRun;
    if (!deferred || useGraphStore.getState().isExecuting || useGraphStore.getState().runStarting) return;
    const live = new Set(useGraphStore.getState().nodes.map((node) => node.id));
    const nodeIds = deferred.nodeIds.filter((nodeId) => live.has(nodeId));
    // The next held run shows now; its Run waits for this one to finish.
    set(nextDeferred);
    // A node deleted since Accept makes this a different run; the backend
    // refuses it as changed, and the person can run what is left by hand.
    if (nodeIds.length > 0) await runNodes(nodeIds, deferred.approvalId);
    else if (deferred.approvalId) await releaseApproval(deferred.approvalId);
  },

  dismissDeferred: () => {
    const deferred = get().deferredRun;
    set(nextDeferred);
    if (!deferred?.approvalId) return;
    // GM r33 item 2 (fix round 22): while this tab isn't connected as the
    // person, Dismiss hides the notice here only; the release (person-only,
    // DELETE /api/canvas/approvals/{id}, which only frees the nodes it locked)
    // goes once the server promotes the tab.
    if (personGateHeld()) holdRelease(deferred.approvalId);
    else void releaseApproval(deferred.approvalId);
  },
}));

wsClient.subscribe((event) => {
  const store = useCanvasProposalsStore.getState();
  if (event.type === 'proposalSync') store.sync(event.proposals);
  else if (event.type === 'proposalOpened') store.open(event.proposal, event.acceptKey, event.personValues);
  else if (event.type === 'proposalClosed') store.close(event);
  else if (event.type === 'graphSync' && event.graphReplaced) {
    // Another project or an import: the backend invalidated every proposal.
    store.clear();
    // Every held run goes, and every approval it held goes back (review 16, L-2).
    const { deferredRun, deferredQueue } = useCanvasProposalsStore.getState();
    useCanvasProposalsStore.setState({ deferredRun: null, deferredQueue: [] });
    for (const held of [deferredRun, ...deferredQueue]) if (held?.approvalId) void releaseApproval(held.approvalId);
  }
});

// GM r33 item 2: the approvals dismissed while the gate held, released once
// the server promotes the tab, each once. Review 19 LOW-1 (fix round 23): kept
// in this tab's sessionStorage too, so a reload before the promote still
// releases them (otherwise the approval keeps its nodes locked against agent
// edits until its 30-minute TTL, and nothing says so). Only a promote sends:
// never on load. An id the server no longer has answers not_found, which
// releaseApproval lets pass, so it is done either way. A tab whose storage
// throws keeps them in memory only, as before.
// Review 20 NIT-1: a duplicated tab copies sessionStorage, held ids included
// (and the credential with them), so both tabs release the same approval on
// their promotes. The second gets not_found, which is harmless: the approval is
// already gone, and nothing runs or spends either way.
export const HELD_RELEASES_KEY = 'nebula.heldRunReleases';

function readHeldReleases(): string[] {
  try {
    const raw = window.sessionStorage.getItem(HELD_RELEASES_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 64) : [];
  } catch {
    return [];
  }
}

function writeHeldReleases(ids: ReadonlySet<string>): void {
  try {
    if (ids.size) window.sessionStorage.setItem(HELD_RELEASES_KEY, JSON.stringify([...ids]));
    else window.sessionStorage.removeItem(HELD_RELEASES_KEY);
  } catch {
    /* No storage in this tab: memory only. */
  }
}

const releasesHeld = new Set<string>(readHeldReleases());

function holdRelease(approvalId: string): void {
  releasesHeld.add(approvalId);
  writeHeldReleases(releasesHeld);
}

onPersonPromoted(() => {
  if (!releasesHeld.size) return;
  const ids = [...releasesHeld];
  releasesHeld.clear();
  writeHeldReleases(releasesHeld);
  for (const id of ids) void releaseApproval(id);
});

/** A reload, for tests: what this tab held in memory goes; its storage stays. */
export function forgetHeldReleasesForTests(): void {
  releasesHeld.clear();
}
