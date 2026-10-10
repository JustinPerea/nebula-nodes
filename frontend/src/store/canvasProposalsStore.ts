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
  withAncestors,
} from '../lib/canvasProposals';
import type { Point } from '../lib/agentCursorMotion';
import { useGraphStore } from './graphStore';

/** How long a closed proposal's ghosts fade before they go. Matches canvasProposals.css. */
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
}

interface CanvasProposalsState {
  proposals: Record<string, ProposalEntry>;
  /** Where the person dragged ghosts, per proposal and ref. Sent with Accept. */
  drag: Record<string, Record<string, Point>>;
  pending: Record<string, 'accept' | 'reject'>;
  errors: Record<string, string>;
  focusedId: string | null;
  deferredRun: DeferredRun | null;
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

/** Run accepted nodes through the canvas's normal guarded run path. */
async function runNodes(nodeIds: string[]): Promise<void> {
  const graph = useGraphStore.getState();
  if (nodeIds.length === 1) {
    await graph.executeNode(nodeIds[0]);
    return;
  }
  // executeCluster runs exactly the nodes it is given, so include what feeds them.
  await graph.executeCluster(withAncestors(nodeIds, graph.edges));
}

export const useCanvasProposalsStore = create<CanvasProposalsState>((set, get) => ({
  proposals: {},
  drag: {},
  pending: {},
  errors: {},
  focusedId: null,
  deferredRun: null,

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
    set((state) => ({ pending: { ...state.pending, [id]: 'accept' }, errors: without(state.errors, id) }));
    try {
      const result = await acceptProposal(id, entry.acceptKey, get().drag[id] ?? {});
      useGraphStore.getState().adoptAcceptedProposal(result);
      get().close({ proposalId: id, status: 'accepted' });
      if (result.runNodeIds.length > 0) {
        if (useGraphStore.getState().isExecuting) {
          set({ deferredRun: { agentName: entry.view.agent.name, nodeIds: result.runNodeIds } });
        } else {
          // The Accept click is the person's approval for these runs.
          await runNodes(result.runNodeIds);
        }
      }
    } catch (error) {
      const message = error instanceof ProposalRequestError && error.status === 403
        ? 'Only the canvas can accept this. Reload the page.'
        : error instanceof Error ? error.message : String(error);
      set((state) => ({ errors: { ...state.errors, [id]: message } }));
    } finally {
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  reject: async (id, reason) => {
    const entry = get().proposals[id];
    if (!entry || entry.closing || get().pending[id]) return;
    set((state) => ({ pending: { ...state.pending, [id]: 'reject' }, errors: without(state.errors, id) }));
    try {
      await rejectProposal(id, entry.acceptKey, reason);
      get().close({ proposalId: id, status: 'rejected' });
    } catch (error) {
      const message = error instanceof ProposalRequestError && error.status === 403
        ? 'Only the canvas can reject this. Reload the page.'
        : error instanceof Error ? error.message : String(error);
      set((state) => ({ errors: { ...state.errors, [id]: message } }));
    } finally {
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  runDeferred: async () => {
    const deferred = get().deferredRun;
    if (!deferred || useGraphStore.getState().isExecuting) return;
    const live = new Set(useGraphStore.getState().nodes.map((node) => node.id));
    const nodeIds = deferred.nodeIds.filter((nodeId) => live.has(nodeId));
    set({ deferredRun: null });
    if (nodeIds.length > 0) await runNodes(nodeIds);
  },

  dismissDeferred: () => set({ deferredRun: null }),
}));

wsClient.subscribe((event) => {
  const store = useCanvasProposalsStore.getState();
  if (event.type === 'proposalSync') store.sync(event.proposals);
  else if (event.type === 'proposalOpened') store.open(event.proposal, event.acceptKey, event.personValues);
  else if (event.type === 'proposalClosed') store.close(event);
  else if (event.type === 'graphSync' && event.graphReplaced) {
    // Another project or an import: the backend invalidated every proposal.
    store.clear();
    useCanvasProposalsStore.setState({ deferredRun: null });
  }
});
