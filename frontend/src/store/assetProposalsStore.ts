import { create } from 'zustand';
import {
  acceptAssetProposal,
  rejectAssetProposal,
  type AssetProposalKind,
  type AssetProposalStatus,
  type AssetProposalView,
} from '../lib/assetProposals';
import { PERSON_REQUIRED_CODE, failureMessage } from '../lib/errorCopy';
import { onPersonPromoted } from '../lib/personSession';

/** How long a closed proposal's strip fades before it goes. Matches asset-proposals.css. */
export const ASSET_PROPOSAL_EXIT_MS = 220;

export interface AssetProposalEntry {
  view: AssetProposalView;
  /** Proof this tab may decide it. It arrives only over this page's browser
   * WebSocket, lives only in memory, and is never persisted, logged or shown. */
  acceptKey: string;
  /** Set while the strip fades out after the proposal closed. */
  closing?: Exclude<AssetProposalStatus, 'open'>;
}

/** Review on a proposal's Update (Q92 a): the strip for this target brings
 * itself into view and takes it (lib/assetProposalReview.ts, deferred). */
export interface ReviewRequest {
  kind: AssetProposalKind;
  targetId: string;
  at: number;
}

interface AssetProposalsState {
  proposals: Record<string, AssetProposalEntry>;
  review: ReviewRequest | null;
  /** Newer views of open proposals (a relist), keeping keys and person-only `before`. */
  refresh: (views: AssetProposalView[]) => void;
  pending: Record<string, 'accept' | 'reject'>;
  errors: Record<string, string>;
  sync: (list: Array<AssetProposalView & { acceptKey: string }>) => void;
  open: (view: AssetProposalView, acceptKey: string) => void;
  close: (event: { proposalId: string; status: Exclude<AssetProposalStatus, 'open'> }) => void;
  /** Keep only these ids open (what the backend lists now); the rest no longer fit. */
  retain: (ids: string[]) => void;
  pruneExpired: (now?: number) => void;
  clear: () => void;
  accept: (id: string) => Promise<void>;
  reject: (id: string, reason?: string) => Promise<void>;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const KINDS: ReadonlySet<string> = new Set<AssetProposalKind>(['project', 'moodboard', 'commons']);
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Drop malformed views; the agent colour goes into CSS, so only plain hex passes. */
function clean(view: AssetProposalView): AssetProposalView | null {
  if (!view || typeof view.id !== 'string' || !KINDS.has(view.kind) || typeof view.target?.id !== 'string') return null;
  const color = SAFE_COLOR.test(view.agent?.color ?? '') ? view.agent.color : '#5B9DFF';
  return { ...view, agent: { ...view.agent, name: String(view.agent?.name ?? 'Agent'), color }, change: view.change ?? {} };
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

export const useAssetProposalsStore = create<AssetProposalsState>((set, get) => ({
  proposals: {},
  review: null,

  refresh: (views) => {
    const current = get().proposals;
    let next: Record<string, AssetProposalEntry> | null = null;
    for (const raw of Array.isArray(views) ? views : []) {
      const view = clean(raw);
      const entry = view ? current[view.id] : undefined;
      if (!view || !entry || entry.closing || view.status !== 'open') continue;
      next ??= { ...current };
      next[view.id] = { ...entry, view: { ...view, before: view.before ?? entry.view.before } };
    }
    if (next) set({ proposals: next });
  },
  pending: {},
  errors: {},

  sync: (list) => {
    for (const id of exitTimers.keys()) cancelExit(id);
    const proposals: Record<string, AssetProposalEntry> = {};
    for (const raw of Array.isArray(list) ? list : []) {
      const view = clean(raw);
      if (!view || view.status !== 'open' || typeof raw.acceptKey !== 'string' || !raw.acceptKey) continue;
      const { acceptKey } = raw;
      delete (view as Partial<AssetProposalView & { acceptKey: string }>).acceptKey;
      proposals[view.id] = { view, acceptKey };
    }
    set({ proposals });
  },

  open: (raw, acceptKey) => {
    const view = clean(raw);
    if (!view || typeof acceptKey !== 'string' || !acceptKey) return;
    cancelExit(view.id);
    set((state) => ({ proposals: { ...state.proposals, [view.id]: { view, acceptKey } } }));
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
        pending: without(state.pending, proposalId),
        errors: without(state.errors, proposalId),
      }));
    }, ASSET_PROPOSAL_EXIT_MS));
  },

  retain: (ids) => {
    const keep = new Set(ids);
    for (const entry of Object.values(get().proposals)) {
      if (!entry.closing && !keep.has(entry.view.id)) get().close({ proposalId: entry.view.id, status: 'invalidated' });
    }
  },

  pruneExpired: (now = Date.now()) => {
    for (const entry of Object.values(get().proposals)) {
      if (!entry.closing && entry.view.expiresAt <= now) get().close({ proposalId: entry.view.id, status: 'expired' });
    }
  },

  clear: () => {
    for (const id of exitTimers.keys()) cancelExit(id);
    set({ proposals: {}, pending: {}, errors: {}, review: null });
  },

  accept: async (id) => decide(id, 'accept'),
  reject: async (id, reason) => decide(id, 'reject', reason),
}));

/** Review 17 LOW-1, as on the canvas bar (fix round 22): proposals whose
 * error is the person gate's refusal; the server promoting the tab clears them. */
const personRefused = new Set<string>();
onPersonPromoted(() => {
  if (!personRefused.size) return;
  const errors = { ...useAssetProposalsStore.getState().errors };
  for (const id of personRefused) delete errors[id];
  personRefused.clear();
  useAssetProposalsStore.setState({ errors });
});

async function decide(id: string, verb: 'accept' | 'reject', reason?: string): Promise<void> {
  const store = useAssetProposalsStore;
  const entry = store.getState().proposals[id];
  if (!entry || entry.closing || store.getState().pending[id]) return;
  store.setState((state) => ({ pending: { ...state.pending, [id]: verb }, errors: without(state.errors, id) }));
  try {
    if (verb === 'accept') await acceptAssetProposal(id, entry.acceptKey);
    else await rejectAssetProposal(id, entry.acceptKey, reason);
    store.setState((state) => ({ pending: without(state.pending, id) }));
    store.getState().close({ proposalId: id, status: verb === 'accept' ? 'accepted' : 'rejected' });
  } catch (error) {
    // A 409 means it no longer fits; the backend closes it and says so over the socket.
    const message = failureMessage(error, `Couldn't ${verb} the proposal.`);
    if ((error as { code?: unknown } | null)?.code === PERSON_REQUIRED_CODE) personRefused.add(id); else personRefused.delete(id);
    store.setState((state) => ({ pending: without(state.pending, id), errors: { ...state.errors, [id]: message } }));
  }
}

/** The targets of one kind that open proposals wait on (not fading ones), in the order they came. */
export function targetsOf(state: Pick<AssetProposalsState, 'proposals'>, kind: AssetProposalKind): string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(state.proposals).sort((left, right) => left.view.createdAt - right.view.createdAt)) {
    if (!entry.closing && entry.view.kind === kind) seen.add(entry.view.target.id);
  }
  return [...seen];
}

/** The open (or fading) proposals for one project or board, oldest first. */
export function proposalsFor(state: Pick<AssetProposalsState, 'proposals'>, kind: AssetProposalKind,
  targetId: string): AssetProposalEntry[] {
  return Object.values(state.proposals)
    .filter((entry) => entry.view.kind === kind && entry.view.target.id === targetId)
    .sort((left, right) => left.view.createdAt - right.view.createdAt);
}
