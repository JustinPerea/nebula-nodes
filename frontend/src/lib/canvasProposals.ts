import type { Edge, InternalNode, Node } from '@xyflow/react';
import type { ModelNodeDefinition, NodeData } from '../types';
import { apiFetch } from './backend';
import { apiRequest } from './apiRequest';
import { countsInstead, nodeNameList, RequestFailedError, copyForAnswer, warnFailure } from './errorCopy';
import { formatChipEstimate } from './pricing';
import { costTitle, mayCostSentence, type UnpricedReason } from './runScope';
import { resolveAnchor, type Point } from './agentCursorMotion';
import type { NotReadyReason, ProposalCost, ProposalCostReason, ProposalNotReady, ProposalPersonValues, ProposalView } from './wsClient';
import { BILLING_PARAM_LABELS, providerChoiceLabel } from './billingParams';
import { classCounts, costChip, costClass } from './costClass';
import { keyBillingAccount, keyBillingLabel, keyPhrase, PROVIDER_PARAM } from './directRoute';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { nodeKeyStatus, usesKreaAccount, type CredentialReadiness } from './kreaConnection';
import { missingKeyTitle } from './nodeKeys';

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
 * A ghost's ⚠, as a real node's card shows it (ModelNode): the key check
 * against the saved settings, with the same title. Null when it can run.
 */
export function ghostKeyWarning(
  definition: ModelNodeDefinition | undefined,
  params: Record<string, unknown>,
  cache: CredentialReadiness,
): string | null {
  if (!definition || nodeKeyStatus(definition, params, cache) !== 'missing') return null;
  return usesKreaAccount(definition, params) ? 'Krea sign-in required' : missingKeyTitle(definition, params);
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

/**
 * The bar's not-ready lines (GM, PR #203 r11 item 5): inside the bar the
 * control is Accept, so while Accept is key-locked, a row in a route's own
 * missing-key words says the Accept line instead ("You can accept this after
 * you add your Hugging Face token in Settings."), once. Every other row keeps
 * its own line (notReadyLine).
 */
export function notReadyBarLines(
  rows: ReadonlyArray<ProposalNotReady & { routeKeyLine?: true }>,
  acceptLock: string | null,
): Array<{ key: string; text: string; accept?: true }> {
  const lines: Array<{ key: string; text: string; accept?: true }> = [];
  // Nodes with the same reason say one line, whatever their names (GM, PR
  // #203 r28; r27 item 7 merged only the same name), by the reason the
  // backend sent (row.reason: person_line.NOT_READY_PREDICATES), never by
  // the words (review 14, copy LOW-1): the line's index, the reason and
  // every node's name in order.
  const same = new Map<string, { index: number; reason: NotReadyReason; names: string[] }>();
  let said = false;
  for (const row of rows) {
    if (row.routeKeyLine && acceptLock) {
      if (!said) lines.push({ key: row.ref, text: acceptLock, accept: true });
      said = true;
      continue;
    }
    const text = notReadyLine(row);
    const reason = row.person?.trim() && isReason(row.reason) ? row.reason : null;
    if (!reason) {
      // A route's own line, or a backend older than round 15: a line each.
      lines.push({ key: row.ref, text });
      continue;
    }
    const seen = same.get(reason.one);
    if (seen) {
      seen.names.push(row.name);
      continue;
    }
    same.set(reason.one, { index: lines.length, reason, names: [row.name] });
    lines.push({ key: row.ref, text });
  }
  for (const { index, reason, names } of same.values()) {
    if (names.length > 1) lines[index] = { ...lines[index], text: mergedNotReadyLine(names, reason) };
  }
  return lines;
}

function isReason(value: unknown): value is NotReadyReason {
  return Boolean(value) && typeof (value as NotReadyReason).one === 'string' && typeof (value as NotReadyReason).many === 'string';
}

/** One reason said for several nodes: their names through the shared
 * name-list rule (errorCopy.nodeNameList: up to 3 by name, a same-name group
 * as its own item, a count from 4 nodes), then the reason's own plural (GM,
 * PR #203 r28): "“Writer” and “Editor” need your Anthropic API key. Add it
 * in Settings.", "2 “Claude” nodes and “Writer” need …", "4 nodes need …".
 * One node says its singular after its quoted name. */
export function mergedNotReadyLine(names: string[], reason: NotReadyReason): string {
  return names.length === 1 ? `“${names[0]}” ${reason.one}` : `${nodeNameList(names)} ${reason.many}`;
}

/**
 * What the bar shows of its not-ready nodes, by the shared rule
 * (errorCopy.countsInstead; GM, PR #203 r24): up to 3 nodes, a line each;
 * from 4, one line that counts them ("4 nodes can’t run here yet."), and
 * every node's line in the details, opened by NOT_READY_DISCLOSURE. The
 * count is of nodes, whatever lines notReadyBarLines merged.
 */
/** The not-ready list's disclosure: one name, open or closed ("Show the
 * list" / "Hide the list"; GM, PR #203 r26). The heading inside is "Can’t
 * run here". Every surface that lists not-ready nodes reads it. */
export const NOT_READY_DISCLOSURE = { closed: 'Show the list', open: 'Hide the list' } as const;
/** The disclosure when the details hold the list and something else too
 * (what Accept writes, the whole note): "Show the details" / "Hide the
 * details" (GM, PR #203 r27 item 4). */
export const DETAILS_DISCLOSURE = { closed: 'Show the details', open: 'Hide the details' } as const;

/** The bar's details toggle, by what the details hold: the not-ready list
 * alone, the list beside other parts, or only the other parts. */
export function detailsDisclosure(
  holds: { list: boolean; changes: boolean; note: boolean }, open: boolean,
): string {
  const state = open ? 'open' : 'closed';
  if (holds.list) return (holds.changes || holds.note ? DETAILS_DISCLOSURE : NOT_READY_DISCLOSURE)[state];
  if (holds.changes) return open ? 'Hide what Accept writes' : 'See what Accept writes';
  return open ? 'Hide the note' : 'Read the whole note';
}

export function notReadyShown(
  rows: ReadonlyArray<ProposalNotReady & { routeKeyLine?: true }>,
  acceptLock: string | null,
): { lines: Array<{ key: string; text: string }>; inDetails: Array<{ key: string; text: string }> } {
  const lines = notReadyBarLines(rows, acceptLock);
  if (!countsInstead(rows.length)) return { lines, inDetails: [] };
  // The Accept line stays in view whatever the count: it says why Accept is
  // locked (review 13 of PR #203, copy NIT-3).
  const accept = lines.filter((line) => line.accept);
  return { lines: [{ key: 'count', text: `${rows.length} nodes can’t run here yet.` }, ...accept], inDetails: lines };
}

/** The person's line ("“GPT Image 2” needs your OpenAI API key. Add it in
 * Settings.", round 3f, the name quoted at its source since GM, PR #203 r20
 * item 3: node_readiness.instance_missing_line); from a backend older than
 * 3f, find_nodes' words:
 * "GPT Image 2 (n3) needs OPENAI_API_KEY in Settings > Providers". */
export function notReadyLine(row: ProposalNotReady): string {
  if (row.person?.trim()) return row.person.trim();
  // Route messages already start with the node's name.
  return row.missing.startsWith(row.name) ? `${row.ref}: ${row.missing}` : `${row.name} (${row.ref}) ${row.missing}`;
}

/** A ghost card's warning for its not-ready row: the person's line (round 3f), else find_nodes' words. */
export function notReadyWarning(row: ProposalNotReady | undefined): string | null {
  if (!row) return null;
  return row.person?.trim() || row.missing;
}

/**
 * The view with every key-billing node's class read from the keys set now
 * (costClass, the class every cost surface reads): a token
 * added after the agent proposed makes Idol "may cost", one removed makes
 * it "free", on the ghost card, in the run's counts and so on the bar and
 * the Accept chip (GM, PR #203 r15 items 1 and 2; review 7, NIT-5). The
 * backend's listing does the same for agents (canvas_proposals.live_cost).
 * `paramsOf` reads the params a run node would run with: a new node's as
 * Accept writes them, a canvas node's with the proposal's changes on top
 * (useLiveProposalView); null when it isn't known, and then its class stays
 * as proposed. No price changes: a key-billing node is never paid or priced.
 */
export function liveKeyBilling(
  view: ProposalView, apiKeys: Readonly<Record<string, string>>,
  paramsOf: (ref: string, nodeId: string | null) => Record<string, unknown> | null | undefined,
): ProposalView {
  const relabel = <T extends ProposalCost>(cost: T, definition: ModelNodeDefinition | undefined,
    params: Record<string, unknown> | null | undefined): T => {
    if (!definition || !params || (cost.kind !== 'free' && cost.kind !== 'mayCost')) return cost;
    const billing = costClass(definition, params, apiKeys);
    if (billing !== 'free' && billing !== 'mayCost') return cost;
    // The one cost class and its label (costClass,
    // keyBillingAccount, keyBillingLabel; review 8 of PR #203, LOW-3).
    const account = keyBillingAccount(definition, params, apiKeys) ?? '';
    const label = keyBillingLabel(billing, account);
    if (billing === cost.kind && label === cost.label) return cost;
    return { ...cost, kind: billing, label, name: cost.name ?? definition.displayName, account };
  };
  let changed = false;
  const nodes = view.nodes.map((node) => {
    const cost = relabel(node.cost, NODE_DEFINITIONS[node.definitionId], paramsOf(node.ref, null));
    if (cost === node.cost) return node;
    changed = true;
    return { ...node, cost };
  });
  const byRef = new Map(view.nodes.map((node) => [node.ref, node]));
  const entries = view.cost.nodes.map((entry) => {
    const definitionId = entry.definitionId ?? (entry.nodeId === null ? byRef.get(entry.ref)?.definitionId : undefined);
    const cost = relabel(entry, definitionId ? NODE_DEFINITIONS[definitionId] : undefined, paramsOf(entry.ref, entry.nodeId));
    if (cost !== entry) changed = true;
    return cost;
  });
  if (!changed) return view;
  const may = entries.filter((entry) => entry.kind === 'mayCost');
  const seen = new Set<string>();
  const mayCost = may.flatMap((entry) => {
    const row = { name: entry.name ?? '', account: entry.account ?? '' };
    const key = `${row.name}\u0000${row.account}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [row];
  });
  // Free runs are those whose kind is "free"; a kind this canvas doesn't
  // name stays in the backend's paid count, never in the free one (backend
  // canvas_proposals.class_counts; review 11 of PR #203, NIT-4).
  return { ...view, nodes, cost: { ...view.cost, nodes: entries, mayCostRuns: may.length, mayCost,
    freeRuns: entries.filter((entry) => entry.kind === 'free').length } };
}

/** The card's plan line under the note (GM - Design, 2026-11-01): what
 * Accept changes and runs, by node name; the model and who pays for a single
 * paid run; the run chip's price. The backend writes it (services/
 * canvas_proposals.plan_line), so agents read the same words in `nebula
 * proposal` and MCP. */
export function proposalPlan(view: ProposalView): string {
  return view.plan ?? '';
}

/** The proposal card's chip, as the Run chip writes it (lib/pricing
 * formatChipEstimate): "~$0.07", "Up to $0.43", "$0.07 + unpriced" when part
 * of the run has no known price. The card has no tooltip for it. */
export function proposalEstimateLabel(view: ProposalView): string | null {
  const estimate = view.cost.estimate;
  if (!estimate || view.run.length === 0) return null;
  // A sourced $0 is free and never priced (GM, PR #203 r18 item 1), so an
  // estimate here is a paid part: one that rounds to zero is "~$0".
  return formatChipEstimate(estimate.low, estimate.high, Boolean(estimate.open));
}

/** A proposal whose whole run waits on agents' placeholders: its run skips
 * them and everything that needs them, so it runs nothing, and Accept starts
 * no run for it (canvasProposalsStore.accept; review 5, L1). */
export function runsNothing(view: ProposalView): boolean {
  const { paidRuns, freeRuns, pendingSkipped } = view.cost;
  return view.run.length > 0 && paidRuns === 0 && (view.cost.mayCostRuns ?? 0) === 0 && (view.cost.planRuns ?? 0) === 0
    && freeRuns === 0 && Boolean(pendingSkipped && pendingSkipped.count > 0);
}

/** The run's may-cost nodes, each with the account it may bill (backend
 * canvas_proposals.summarize_cost). */
function mayCostRows(view: ProposalView): Array<{ name: string; account: string }> {
  return (view.cost.mayCostRuns ?? 0) > 0 ? (view.cost.mayCost ?? []) : [];
}

/** The primary button's words. "Accept" when accepting runs nothing (GM -
 * Design, round 5, item 3): Accept starts no run for it (it would skip every
 * node: backend main._skip_placeholders), and nothing is queued for when the
 * agent finishes. The paid count left the label (GM - Design, 2026-11-01):
 * the plan line right above it says what's paid. */
export function acceptLabel(view: ProposalView): string {
  if (view.run.length === 0 || runsNothing(view)) return 'Accept';
  return 'Accept and run';
}

/** The count chip's tooltip when part of the run may bill the person's own
 * account: "Idol can use your Hugging Face credits." (GM, PR #203 r11 item
 * 2, as the Run chip's last sentence). Null otherwise. */
export function proposalMayCostSentence(view: ProposalView): string | null {
  return mayCostSentence(mayCostRows(view));
}

const REASON_KINDS = new Set<string>(['noPrice', 'cantRun', 'awaitingInput', 'sizeUnreadable', 'plan']);

/** A node's reason from the backend (model_pricing.estimate_run reasons) as
 * the Run chip records it (runScope UnpricedReason). A kind this build
 * doesn't know (a newer backend's) reads as no listed price, never a crash
 * in the bar's render (review 9 of PR #203, NIT-2). */
export function entryReason(why: ProposalCostReason): UnpricedReason {
  switch (why.kind) {
    case 'missingKey': return { kind: 'missingKey', key: keyPhrase(Array.isArray(why.keys) ? why.keys : []) };
    case 'leftOut': return { kind: 'leftOut', plus: typeof why.plus === 'string' ? why.plus : '' };
    default: return REASON_KINDS.has(why.kind) ? { kind: why.kind } : { kind: 'noPrice' };
  }
}

/**
 * The Accept chip's tooltip, by the Run chip's formatter (runScope
 * costTitle; GM, PR #203 r17 item 4: the same reason lines, one formatter):
 * "“A” and “B” call paid providers. Estimated cost $0.13.", then "“B” has
 * no listed price." on its own line, the may-cost sentence last. Null when
 * the chip doesn't show. `canvasName` names a canvas node the run starts
 * and `canvasAt` gives its place, so reasons read left to right as the Run
 * chip's do; a new node is named and placed as its ghost card is.
 */
export function acceptChipTitle(
  view: ProposalView,
  canvasName: (nodeId: string) => string | null | undefined,
  canvasAt?: (nodeId: string) => { x: number; y: number } | null | undefined,
): string | null {
  if (!acceptCountChip(view)) return null;
  const ghosts = new Map(view.nodes.map((node) => [node.ref, node]));
  type Entry = ProposalView['cost']['nodes'][number];
  const nameOf = (entry: Entry) => (entry.nodeId === null ? ghosts.get(entry.ref)?.name : canvasName(entry.nodeId))
    ?? entry.nodeId ?? entry.ref;
  const atOf = (entry: Entry) => (entry.nodeId === null ? ghosts.get(entry.ref)?.position : canvasAt?.(entry.nodeId));
  const paid = view.cost.paidRuns > 0 ? view.cost.nodes.filter((entry) => entry.kind === 'paid') : [];
  // Runs on the Krea plan: never paid, a reason line of their own (GM, PR #203 r19 item 1).
  const plan = view.cost.nodes.filter((entry) => entry.kind === 'plan');
  const estimate = view.cost.estimate;
  // A proposal made before reasons were sent: its unpriced nodes have no listed price.
  const unpriced = new Set(estimate?.unpriced ?? []);
  const reasons = [...paid, ...plan].flatMap((entry) => {
    const reason: UnpricedReason | null = entry.reason ? entryReason(entry.reason)
      : entry.kind === 'plan' ? { kind: 'plan' } : unpriced.has(entry.ref) ? { kind: 'noPrice' } : null;
    if (!reason) return [];
    const at = atOf(entry);
    return [{ name: nameOf(entry), reason, ...(at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { at } : {}) }];
  });
  return costTitle({
    paid: paid.map(nameOf),
    estimate: estimate ? { low: estimate.low, high: estimate.high, open: Boolean(estimate.open) } : null,
    reasons,
    mayCost: mayCostRows(view),
  }) ?? null;
}

/** The count chip beside "Accept and run" (GM, PR #203 r11 item 2): "1
 * paid", "2 paid · 1 may cost", "1 may cost" (a run that may bill the
 * person's own account, never counted as paid). Null when its run is free
 * or Accept runs nothing. */
export function acceptCountChip(view: ProposalView): string | null {
  if (view.run.length === 0 || runsNothing(view)) return null;
  // The one chip rule (costChip, GM, PR #203 r20): classes joined by "·".
  return costChip(null, classCounts({ paid: view.cost.paidRuns, plan: view.cost.planRuns ?? 0,
    mayCost: view.cost.mayCostRuns ?? 0 }));
}

/** "3:05" until the proposal expires. */
export function countdown(expiresAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Short text for a proposed param value. */
export function briefValue(value: unknown, limit = 36): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** A proposed value written out in full (the backend already marks anything it shortened). */
export function fullValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'string') return value === '' ? '(empty)' : value;
  return JSON.stringify(value) ?? String(value);
}

/** Who bills a run (lib/billingParams.ts) is the only internal state a
 * proposal may change (backend main._refuse_agent_billing_change), so the bar
 * names it plainly: a route-table node's provider, a Krea node's billing mode. */
const KREA_BILLING_KEY = '_kreaAuth';
const KREA_BILLING_VALUES: Record<string, string> = { 'api-token': 'API balance', mcp: 'Krea plan' };

function changeLine(key: string, to: unknown, from?: unknown, hasFrom = false): ChangeLine {
  if (key === PROVIDER_PARAM) {
    // A node that never set it runs on Auto, the default.
    return { key: BILLING_PARAM_LABELS[PROVIDER_PARAM], to: providerChoiceLabel(to),
      ...(hasFrom ? { from: providerChoiceLabel(from) } : {}) };
  }
  if (key === KREA_BILLING_KEY) {
    // A node that never set it bills the API token, the default.
    const name = (value: unknown) => (value === null || value === undefined || value === ''
      ? KREA_BILLING_VALUES['api-token']
      : (typeof value === 'string' && KREA_BILLING_VALUES[value]) || fullValue(value));
    return { key: 'Billed to', to: name(to), ...(hasFrom ? { from: name(from) } : {}) };
  }
  return { key, to: fullValue(to), ...(hasFrom ? { from: fullValue(from) } : {}) };
}

export interface ChangeLine {
  key: string;
  /** Present for a change to an existing node: the value at proposal time. */
  from?: string;
  to: string;
}

/** One wire in the panel: “Prompt” → “Second take” · Prompt, the target's
 * port muted (GM - Design, PR #216 r2-r3). */
export interface WireLine {
  id: string;
  from: string;
  to: string;
  port: string;
}

export interface ChangeGroup {
  id: string;
  title: string;
  /** `wires`: "New connections"; `unwired`: "Removed connections", struck through. */
  kind: 'new' | 'edit' | 'wires' | 'unwired';
  lines: ChangeLine[];
  wires?: WireLine[];
}

const QUOTE_MARKS = '“”"\'‘’';

/** A node's name on the card, in curly quotes once: quotes the name carries
 * itself come off first (review 2 L4; the plan line's rule, backend
 * canvas_proposals._plan_name), so “Hero” never reads ““Hero””. */
export function cardQuoted(name: string): string {
  let text = name.trim();
  // Only quotes that wrap it, at both ends: an apostrophe the name ends in
  // stays ("Artists'", review 3 NIT-3), as the backend's plan_name.
  while (text.length >= 2 && QUOTE_MARKS.includes(text[0]) && QUOTE_MARKS.includes(text[text.length - 1])) {
    text = text.slice(1, -1).trim();
  }
  return `“${text || name}”`;
}

function wireLines(edges: ProposalView['edges'] | undefined, names: Record<string, string>,
  ports: Record<string, string> = {}): WireLine[] {
  return (edges ?? []).map((edge) => ({
    id: `${edge.source}.${edge.sourceHandle}>${edge.target}.${edge.targetHandle}`,
    from: cardQuoted(edge.sourceName ?? names[edge.source] ?? edge.source),
    to: cardQuoted(edge.targetName ?? names[edge.target] ?? edge.target),
    port: edge.targetLabel ?? ports[`${edge.target}.${edge.targetHandle}`] ?? edge.targetHandle,
  }));
}

/**
 * Every value Accept will write, grouped by node, for the decision bar.
 * Uses the browser-only person values when present (full text), else the
 * view's agent-facing values.
 */
export function proposalChanges(view: ProposalView, values?: ProposalPersonValues): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  for (const node of view.nodes) {
    const params = values?.nodes[node.ref] ?? node.params ?? {};
    groups.push({
      id: node.ref,
      // By name, never by ref (GM - Design, 2026-11-01): New “Krea 2”; a name
      // the agent gave it (`rename`) shows with the model it is.
      title: `New ${cardQuoted(node.name)}${node.model ? ` · ${node.model}` : ''}`,
      kind: 'new',
      lines: Object.entries(params).map(([key, value]) => changeLine(key, value)),
    });
  }
  for (const change of view.params) {
    const exact = values?.params[change.nodeId];
    const entries = Object.entries(exact ?? change.changes);
    groups.push({
      id: change.nodeId,
      // “Hero shot” · Krea 2 (GM - Design, 2026-11-01). `name` carries the
      // node's id for agents; a backend without `title` falls back to it.
      title: change.title
        ? `${cardQuoted(change.title)}${change.model && change.model !== change.title ? ` · ${change.model}` : ''}`
        : change.name,
      kind: 'edit',
      // The same model set again: its inputs are read again, never "X → X"
      // (GM - Design, PR #216 r4 8: "Krea 2 · inputs updated").
      lines: entries.map(([key, diff]) => (change.inputsUpdated?.key === key
        ? { key, to: `${change.inputsUpdated.name} · inputs updated` }
        : changeLine(key, diff.to, diff.from, true))),
    });
  }
  // Every wire Accept makes or removes, one line each (GM - Design, PR #216 r2-r3).
  // The backend names both ends on each wire; an older view's own names fill in.
  const names: Record<string, string> = {
    ...Object.fromEntries(view.params.filter((change) => change.title).map((change) => [change.nodeId, change.title!])),
    ...Object.fromEntries(view.nodes.map((node) => [node.ref, node.name])),
    ...view.names,
  };
  const ports = Object.fromEntries(view.nodes.flatMap((node) =>
    (node.ports?.inputs ?? []).map((port) => [`${node.ref}.${port.id}`, port.label])));
  const made = wireLines(view.edges, names, ports);
  if (made.length > 0) groups.push({ id: 'wires', title: 'New connections', kind: 'wires', lines: [], wires: made });
  const removed = wireLines(view.removedEdges, names);
  if (removed.length > 0) {
    groups.push({ id: 'unwired', title: 'Removed connections', kind: 'unwired', lines: [], wires: removed });
  }
  return groups;
}

/**
 * How many changes Accept makes: the backend's `changeCount`, the one number
 * the card, the Update and MCP read (GM - Design, PR #216 r3): each new node,
 * changed node, new wire and removed wire. An older backend's view without it
 * counts the panel the same way: one per node group, one per wire line.
 */
export function proposalChangeCount(view: ProposalView, groups: ChangeGroup[]): number {
  if (typeof view.changeCount === 'number') return view.changeCount;
  return groups.reduce((sum, group) => sum + (group.wires ? group.wires.length : 1), 0);
}

/** "2 changes", "1 change", for the disclosure row. */
export function changeCountLabel(count: number): string {
  return `${count} change${count === 1 ? '' : 's'}`;
}

/** "value: a → b; seed: 1 → 2" for the ring around a changed node. */
export function changeTag(changes: Record<string, { from: unknown; to: unknown }>, limit = 24): string {
  return Object.entries(changes)
    .map(([key, diff]) => `${key}: ${briefValue(fullValue(diff.from), limit)} → ${briefValue(fullValue(diff.to), limit)}`)
    .join('; ');
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

/** What the notice region's polite line says once a keyboard Accept or
 * Reject closes the proposal (#216 round 3l, GM r69 a), wherever focus then
 * is (ProposalBar). */
export function decisionLine(kind: 'accept' | 'reject', agent: string): string {
  return `${kind === 'accept' ? 'Accepted' : 'Rejected'} the proposal from ${agent}.`;
}
