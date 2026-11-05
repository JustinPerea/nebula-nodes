import type { Edge, InternalNode, Node } from '@xyflow/react';
import type { ModelNodeDefinition, NodeData } from '../types';
import { apiFetch } from './backend';
import { apiRequest } from './apiRequest';
import { RequestFailedError } from './errorCopy';
import { formatChipEstimate } from './pricing';
import { resolveAnchor, type Point } from './agentCursorMotion';
import type { ProposalNotReady, ProposalPersonValues, ProposalView } from './wsClient';
import { BILLING_PARAM_LABELS, providerChoiceLabel } from './billingParams';
import { PROVIDER_PARAM } from './directRoute';
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
  constructor(status: number, reason: string, options: { heading?: string; detail?: unknown; code?: string | null; sentAt?: number | null; sentBeforePromote?: boolean } = {}) {
    super(options.heading ?? '', status, { reason, detail: options.detail, code: options.code,
      sentAt: options.sentAt, sentBeforePromote: options.sentBeforePromote });
    this.name = 'ProposalRequestError';
  }
}

const asProposalError = (error: RequestFailedError) =>
  new ProposalRequestError(error.status, error.reason, { heading: error.heading, detail: error.detail, code: error.code,
    sentAt: error.sentAt });

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
  const response = await apiRequest("Couldn't accept the proposal.", `/api/canvas/proposals/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(Object.keys(positions).length > 0 ? { positions } : {}),
  }, { as: asProposalError });
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
): ProposalNotReady[] {
  return (view.cost.notReady ?? []).filter((row) => {
    if (!cache.loaded || !row.missing.startsWith('needs ')) return true;
    const node = nodeFor(row);
    return !node?.definition || nodeKeyStatus(node.definition, node.params, cache) === 'missing';
  });
}

/** The person's line ("GPT Image 2 needs your OpenAI API key. Add it in
 * Settings.", round 3f); from a backend older than 3f, find_nodes' words:
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
  return formatChipEstimate(estimate.low, estimate.high, Boolean(estimate.open));
}

/** A proposal whose whole run waits on agents' placeholders: its run skips
 * them and everything that needs them, so it runs nothing, and Accept starts
 * no run for it (canvasProposalsStore.accept; review 5, L1). */
export function runsNothing(view: ProposalView): boolean {
  const { paidRuns, freeRuns, pendingSkipped } = view.cost;
  return view.run.length > 0 && paidRuns === 0 && freeRuns === 0 && Boolean(pendingSkipped && pendingSkipped.count > 0);
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
const KREA_BILLING_VALUES: Record<string, string> = { 'api-token': 'API token balance', mcp: 'Krea plan' };

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

/** GM - Design (2026-10-31): the status on each node a held run waits on. */
export const WAITING_FOR_OK = 'Waiting for your OK';

/** What the notice region's polite line says once a keyboard Accept or
 * Reject closes the proposal (#216 round 3l, GM r69 a), wherever focus then
 * is (ProposalBar). */
export function decisionLine(kind: 'accept' | 'reject', agent: string): string {
  return `${kind === 'accept' ? 'Accepted' : 'Rejected'} the proposal from ${agent}.`;
}
