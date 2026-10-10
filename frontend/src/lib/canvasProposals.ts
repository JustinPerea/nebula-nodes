import type { Edge, InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { apiFetch } from './backend';
import { resolveAnchor, type Point } from './agentCursorMotion';
import type { ProposalPersonValues, ProposalView } from './wsClient';

export type { ProposalPersonValues, ProposalView } from './wsClient';

/** What the backend returns when the person accepts (main.accept_canvas_proposal). */
export interface AcceptedProposal {
  status: 'accepted';
  proposalId: string;
  idMap: Record<string, string>;
  runNodeIds: string[];
  nodes: Node<NodeData>[];
  edges: Edge[];
  updatedNodes: Node<NodeData>[];
}

/** A failed accept/reject, keeping the HTTP status so the bar can explain a 403. */
export class ProposalRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function detailOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail) return body.detail;
  } catch {
    /* not JSON */
  }
  return fallback;
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
  const response = await apiFetch(`/api/canvas/proposals/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(Object.keys(positions).length > 0 ? { positions } : {}),
  });
  if (!response.ok) {
    throw new ProposalRequestError(response.status, await detailOf(response, `Couldn't accept (${response.status})`));
  }
  const body = (await response.json()) as Partial<AcceptedProposal>;
  return {
    status: 'accepted',
    proposalId: body.proposalId ?? id,
    idMap: body.idMap ?? {},
    runNodeIds: Array.isArray(body.runNodeIds) ? body.runNodeIds : [],
    nodes: Array.isArray(body.nodes) ? body.nodes : [],
    edges: Array.isArray(body.edges) ? body.edges : [],
    updatedNodes: Array.isArray(body.updatedNodes) ? body.updatedNodes : [],
  };
}

export async function rejectProposal(id: string, acceptKey: string, reason?: string): Promise<void> {
  const response = await apiFetch(`/api/canvas/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': acceptKey },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!response.ok) {
    throw new ProposalRequestError(response.status, await detailOf(response, `Couldn't reject (${response.status})`));
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

/** "Adds 1 node · 1 wire · changes n4 · runs up to 1 paid model (fal)". */
export function proposalSummary(view: ProposalView): string {
  const parts: string[] = [];
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (view.nodes.length) parts.push(`Adds ${plural(view.nodes.length, 'node')}`);
  if (view.edges.length) parts.push(`${parts.length ? '' : 'Adds '}${plural(view.edges.length, 'wire')}`);
  if (view.params.length) parts.push(`changes ${view.params.map((change) => change.nodeId).join(', ')}`);
  if (view.run.length) {
    const { paidRuns, freeRuns, upTo, providers } = view.cost;
    if (paidRuns > 0) {
      const who = providers.length ? ` (${providers.join(', ')})` : '';
      parts.push(`runs ${upTo ? 'up to ' : ''}${plural(paidRuns, 'paid model')}${who}`);
    } else {
      parts.push(`runs ${upTo ? 'up to ' : ''}${plural(freeRuns, 'free node')}`);
    }
  } else {
    parts.push('nothing runs until you choose');
  }
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The primary button's words. */
export function acceptLabel(view: ProposalView): string {
  if (view.run.length === 0) return 'Accept';
  return view.cost.paidRuns > 0 ? `Accept & run (${view.cost.paidRuns} paid)` : 'Accept & run';
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

export interface ChangeLine {
  key: string;
  /** Present for a change to an existing node: the value at proposal time. */
  from?: string;
  to: string;
}

export interface ChangeGroup {
  id: string;
  title: string;
  kind: 'new' | 'edit';
  lines: ChangeLine[];
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
      title: `New ${node.name} (${node.ref})`,
      kind: 'new',
      lines: Object.entries(params).map(([key, value]) => ({ key, to: fullValue(value) })),
    });
  }
  for (const change of view.params) {
    const exact = values?.params[change.nodeId];
    const entries = Object.entries(exact ?? change.changes);
    groups.push({
      id: change.nodeId,
      title: change.name,
      kind: 'edit',
      lines: entries.map(([key, diff]) => ({ key, from: fullValue(diff.from), to: fullValue(diff.to) })),
    });
  }
  return groups;
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
