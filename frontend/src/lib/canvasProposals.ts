import type { Edge, InternalNode, Node } from '@xyflow/react';
import type { ModelNodeDefinition, NodeData } from '../types';
import { apiFetch } from './backend';
import { apiRequest } from './apiRequest';
import { RequestFailedError, copyForAnswer, warnFailure } from './errorCopy';
import { resolveAnchor, type Point } from './agentCursorMotion';
import type { ProposalNotReady, ProposalView } from './wsClient';
import { nodeKeyStatus, type CredentialReadiness } from './kreaConnection';

export type { ProposalNotReady, ProposalPersonValues, ProposalView } from './wsClient';

/** What the backend returns when the person accepts (main.accept_canvas_proposal). */
export interface AcceptedProposal {
  status: 'accepted';
  proposalId: string;
  idMap: Record<string, string>;
  runNodeIds: string[];
  /**
   * The person's approval for exactly the runs listed, at the values just
   * accepted (services/run_approvals.py). Sent with the run the canvas starts
   * for runNodeIds; null when the proposal listed no runs.
   */
  approvalId: string | null;
  nodes: Node<NodeData>[];
  edges: Edge[];
  updatedNodes: Node<NodeData>[];
}

/** A failed accept/reject, keeping the HTTP status so the bar can explain a 403. */
/** A refused accept or reject: heading + reason like every request's error
 * (GM, error-copy round 2); `status` tells a gone proposal from a refusal. */
export class ProposalRequestError extends RequestFailedError {
  /** Which of Save's limits a refused Accept hit (the answer's `limit.kind`
   * beside `code: "proposal_too_complex"`): 'size' for the project's size
   * limit, else the shape limits ('depth', 'values'). Null otherwise. Read
   * from the answer, never its words (review 8 of PR #205, limits MEDIUM-1). */
  readonly limitKind: string | null;

  constructor(status: number, reason: string, options: {
    heading?: string; detail?: unknown; code?: string | null; limitKind?: string | null; sentAt?: number | null;
    sentBeforePromote?: boolean;
  } = {}) {
    super(options.heading ?? '', status, { reason, detail: options.detail, code: options.code,
      sentAt: options.sentAt, sentBeforePromote: options.sentBeforePromote });
    this.name = 'ProposalRequestError';
    this.limitKind = options.limitKind ?? null;
  }
}

const asProposalError = (error: RequestFailedError) =>
  new ProposalRequestError(error.status, error.reason, { heading: error.heading, detail: error.detail, code: error.code,
    sentAt: error.sentAt });

/** A refused Accept's answer (409), read once: its line (copyForAnswer, as
 * every request's error), its code, and the limit it hit. */
async function acceptConflict(heading: string, response: Response): Promise<ProposalRequestError> {
  type Answer = { detail?: unknown; code?: unknown; limit?: unknown } | null;
  const body = await response.json().then((value: unknown) => value as Answer, () => null as Answer);
  const code = typeof body?.code === 'string' ? body.code : null;
  const limit = body?.limit && typeof body.limit === 'object' ? (body.limit as { kind?: unknown }).kind : null;
  warnFailure(heading, response.status, body?.detail);
  return new ProposalRequestError(response.status, copyForAnswer(response.status, body?.detail, code),
    { heading, detail: body?.detail, code, limitKind: typeof limit === 'string' ? limit : null });
}

/**
 * Accept a proposal. The key came only over this canvas's WebSocket; the
 * backend also requires a browser Origin (or the desktop session, which
 * apiFetch adds for /api/canvas/proposals) and refuses any agent marker.
 */
export async function acceptProposal(
  id: string,
  acceptKey: string,
  positions: Record<string, Point>,
): Promise<AcceptedProposal> {
  const heading = "Couldn't accept the proposal.";
  const response = await apiRequest(heading, `/api/canvas/proposals/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(Object.keys(positions).length > 0 ? { positions } : {}),
  }, { as: asProposalError, allow: [409] });
  if (response.status === 409) {
    // A 409 is read here, for its limit too (a refused Accept: which line).
    throw await acceptConflict(heading, response);
  }
  const body = (await response.json()) as Partial<AcceptedProposal>;
  return {
    status: 'accepted',
    proposalId: body.proposalId ?? id,
    idMap: body.idMap ?? {},
    runNodeIds: Array.isArray(body.runNodeIds) ? body.runNodeIds : [],
    approvalId: typeof body.approvalId === 'string' && body.approvalId ? body.approvalId : null,
    nodes: Array.isArray(body.nodes) ? body.nodes : [],
    edges: Array.isArray(body.edges) ? body.edges : [],
    updatedNodes: Array.isArray(body.updatedNodes) ? body.updatedNodes : [],
  };
}

export async function rejectProposal(id: string, acceptKey: string, reason?: string): Promise<void> {
  await apiRequest("Couldn't reject the proposal.", `/api/canvas/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(reason ? { reason } : {}),
  }, { as: asProposalError });
}

/**
 * Let go of an approved run the canvas won't start (dismissed, or the canvas
 * declined to start it). Frees the nodes it locked against agent edits. A run
 * that did start already used it up, so this is then a no-op.
 */
export async function releaseApproval(approvalId: string): Promise<void> {
  try {
    await apiFetch(`/api/canvas/approvals/${encodeURIComponent(approvalId)}`, { method: 'DELETE' });
  } catch {
    /* It expires on its own; a failed release only keeps the locks a while longer. */
  }
}

// -- ghost geometry (flow coordinates) ------------------------------------------

/** Ghost cards are a fixed 240 flow units wide; port rows start 56 below the top, 24 apart. */
export const GHOST_WIDTH = 240;
export const GHOST_PORT_TOP = 56;
export const GHOST_PORT_STEP = 24;

export type ProposalLookup = Map<string, InternalNode<Node<NodeData>>>;

export function isGhostRef(id: string): boolean {
  return id.startsWith('+');
}

/** Where a ghost sits now: where the person dragged it, else where the agent put it. */
export function ghostPosition(
  view: ProposalView,
  ref: string,
  drag: Record<string, Point> | undefined,
): Point | null {
  const dragged = drag?.[ref];
  if (dragged) return dragged;
  const node = view.nodes.find((n) => n.ref === ref);
  return node ? node.position : null;
}

/** A ghost port's dot centre. Inputs sit on the left edge, outputs on the right. */
export function ghostPortPoint(
  view: ProposalView,
  ref: string,
  handle: string,
  side: 'input' | 'output',
  drag: Record<string, Point> | undefined,
): Point | null {
  const node = view.nodes.find((n) => n.ref === ref);
  const at = ghostPosition(view, ref, drag);
  if (!node || !at) return null;
  const ports = side === 'input' ? node.ports.inputs : node.ports.outputs;
  const row = Math.max(0, ports.findIndex((port) => port.id === handle));
  return {
    x: side === 'input' ? at.x : at.x + GHOST_WIDTH,
    y: at.y + GHOST_PORT_TOP + row * GHOST_PORT_STEP,
  };
}

/** Either end of a proposed wire: a ghost's port dot, or a real node's handle. */
export function wireEnd(
  view: ProposalView,
  nodeId: string,
  handle: string,
  side: 'input' | 'output',
  drag: Record<string, Point> | undefined,
  lookup: ProposalLookup,
): Point | null {
  if (isGhostRef(nodeId)) return ghostPortPoint(view, nodeId, handle, side, drag);
  return resolveAnchor({ nodeId, handle }, lookup);
}

/** A horizontal bezier like React Flow's own edges. */
export function wirePath(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

/** How many port rows a ghost card needs (inputs and outputs share rows). */
export function ghostRows(node: ProposalView['nodes'][number]): number {
  return Math.max(node.ports.inputs.length, node.ports.outputs.length);
}

/** An estimated ghost card height, for "Show" framing. */
export function ghostHeight(node: ProposalView['nodes'][number]): number {
  return Math.max(GHOST_PORT_TOP + ghostRows(node) * GHOST_PORT_STEP + 16, 150);
}

/** Where each of a proposal's ghosts sits now, as a flow rectangle (Show, Fit view). */
export function ghostBoxes(
  view: ProposalView,
  drag: Record<string, Point> | undefined,
): Array<{ x: number; y: number; width: number; height: number }> {
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const node of view.nodes) {
    const at = ghostPosition(view, node.ref, drag);
    if (at) boxes.push({ x: at.x, y: at.y, width: GHOST_WIDTH, height: ghostHeight(node) });
  }
  return boxes;
}

/**
 * The proposal's run nodes that can't run here (cost.notReady, read when the
 * agent proposed), less the ones the person has set up since: a "needs …"
 * reason whose key check now passes. Route reasons stay, since the canvas
 * can't re-check what the backend's router saw.
 */
export function stillNotReady(
  view: ProposalView,
  cache: CredentialReadiness,
  nodeFor: (row: ProposalNotReady) => { definition: ModelNodeDefinition | undefined; params: Record<string, unknown> } | null,
): Array<ProposalNotReady & { routeKeyLine?: true }> {
  return (view.cost.notReady ?? []).flatMap((row) => {
    const node = nodeFor(row);
    // A route's own missing-key line (RouteSpec.missingKeyLine, a keyed
    // route: "You can run X after you add your Hugging Face token in
    // Settings."): Accept is locked for it, so the bar says the Accept line
    // in its place (notReadyBarLines).
    const routeKeyLine = Boolean(node?.definition?.routes?.some((route) => route.missingKeyLine && route.missingKeyLine === row.missing));
    const kept = routeKeyLine ? [{ ...row, routeKeyLine: true as const }] : [row];
    if (!cache.loaded) return kept;
    // A missing key, in either wording: find_nodes' "needs <key>", or a
    // route's own line. PR #203 round 6: with the key added, the line stayed
    // beside an unlocked Accept.
    if (!row.missing.startsWith('needs ') && !routeKeyLine) return kept;
    return !node?.definition || nodeKeyStatus(node.definition, node.params, cache) === 'missing' ? kept : [];
  });
}

/** A proposal whose whole run waits on agents' placeholders: its run skips
 * them and everything that needs them, so it runs nothing, and Accept starts
 * no run for it (canvasProposalsStore.accept; review 5, L1). */
export function runsNothing(view: ProposalView): boolean {
  const { paidRuns, freeRuns, pendingSkipped } = view.cost;
  return view.run.length > 0 && paidRuns === 0 && (view.cost.mayCostRuns ?? 0) === 0 && (view.cost.planRuns ?? 0) === 0
    && freeRuns === 0 && Boolean(pendingSkipped && pendingSkipped.count > 0);
}

/** Run targets plus their ancestors on the local canvas, so a multi-target run gets its inputs. */
export function withAncestors(targets: string[], edges: Array<{ source: string; target: string }>): string[] {
  const upstream = new Map<string, string[]>();
  for (const edge of edges) {
    const list = upstream.get(edge.target) ?? [];
    list.push(edge.source);
    upstream.set(edge.target, list);
  }
  const seen = new Set<string>();
  const queue = [...targets];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const source of upstream.get(id) ?? []) queue.push(source);
  }
  return [...seen];
}
