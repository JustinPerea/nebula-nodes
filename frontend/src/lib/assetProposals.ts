import { apiFetch } from './backend';

/** Proposals outside the graph (backend services/asset_proposals.py, U16):
 * a cover the person pinned on a project, a board's Send notes, curating a
 * Commons reference (services/commons_proposals.py, Q63 b). The person
 * decides where they work on that thing: the Projects screen, Moodboard
 * Studio, the Commons. */
export type AssetProposalKind = 'project' | 'moodboard' | 'commons';
export type AssetProposalStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'invalidated';

/** One edit of a commons proposal, in the shape its Commons route takes. */
export type CommonsEdit =
  | { correction: { field_path: string; op: 'set' | 'add' | 'remove'; value: unknown; reason: string | null } }
  | { region: { id?: string; box?: [number, number, number, number]; label?: string; note?: string;
    status?: 'confirmed' | 'deleted' } }
  | { membership: { id: string; role?: string; why?: string; accept?: true } };

export interface AssetProposalView {
  id: string;
  status: AssetProposalStatus;
  agent: { id: string; name: string; color: string; verified?: boolean };
  note: string;
  kind: AssetProposalKind;
  target: { kind: AssetProposalKind; id: string; name: string };
  change: {
    /** A project's cover: `null` is the automatic one. `lostPin`: the pin it
     * was proposed against while that pin's image is gone (it no longer
     * counts, Q90 a), so `from` is the automatic cover. `auto`: the image the
     * automatic cover shows now, or null when the project has none. */
    cover?: { from: string | null; to: string | null; fromBy: { kind: string; name: string } | null;
      lostPin?: { url: string; by: { kind: string; name: string } | null }; auto?: string | null };
    sendNotes?: { from: boolean; to: boolean };
    /** A Commons reference's edits (kind commons), the agent's own values. */
    edits?: CommonsEdit[];
  };
  /** Commons only, and only on the person's socket: each edit's target as it
   * was proposed against ({value} | {present} | a region | a membership | null). */
  before?: Array<Record<string, unknown> | null>;
  summary: string;
  decideIn: 'projects' | 'moodboard-studio' | 'commons';
  createdAt: number;
  expiresAt: number;
  reason: string | null;
  applied: Record<string, unknown> | null;
  /** The Update it posted in the corner (Q92 a), or null with no project open. */
  update?: { id: string; projectId: string } | null;
}

/** Browser sockets only: a new proposal plus the key that lets this tab decide it. */
export interface AssetProposalOpenedEvent {
  type: 'assetProposalOpened';
  proposal: AssetProposalView;
  acceptKey: string;
}

/** Browser sockets only, after hello: every open asset proposal with its key. */
export interface AssetProposalSyncEvent {
  type: 'assetProposalSync';
  proposals: Array<AssetProposalView & { acceptKey: string }>;
}

export interface AssetProposalClosedEvent {
  type: 'assetProposalClosed';
  proposalId: string;
  status: Exclude<AssetProposalStatus, 'open'>;
  reason?: string | null;
  kind: AssetProposalKind;
  targetId: string;
}

export class AssetProposalError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function decide(id: string, acceptKey: string, verb: 'accept' | 'reject', body?: unknown): Promise<void> {
  const response = await apiFetch(`/api/asset-proposals/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(body ?? {}),
  });
  if (response.ok) return;
  let detail = '';
  try {
    const parsed = (await response.json()) as { detail?: unknown };
    if (typeof parsed?.detail === 'string') detail = parsed.detail;
  } catch { /* not JSON */ }
  throw new AssetProposalError(response.status, detail || `Couldn't ${verb} (${response.status})`);
}

/** The key came only over this tab's WebSocket; the backend also needs the person token. */
export const acceptAssetProposal = (id: string, acceptKey: string) => decide(id, acceptKey, 'accept');
export const rejectAssetProposal = (id: string, acceptKey: string, reason?: string) =>
  decide(id, acceptKey, 'reject', reason ? { reason } : {});

/** The open ones (no keys); reading them also lets the backend close those that no longer fit. */
export async function listAssetProposals(): Promise<AssetProposalView[]> {
  const response = await apiFetch('/api/asset-proposals');
  if (!response.ok) throw new AssetProposalError(response.status, `Couldn't list proposals (${response.status})`);
  const body = (await response.json()) as { proposals?: AssetProposalView[] };
  return Array.isArray(body.proposals) ? body.proposals : [];
}
