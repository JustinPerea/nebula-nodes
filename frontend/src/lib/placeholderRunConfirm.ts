import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { isLocalRun } from './nodeKeys';
import { cleanPending, type PendingAgent } from './pendingNodes';
import { formatUsd, formatUsdRange } from './pricing';
import { runCostNotes, type RunCost, type RunScopeSummary } from './runScope';

/**
 * Q133 (Justin, 2026-10-25, option b): the person's direct run still runs the
 * agents' placeholders feeding the node, but Nebula always asks first when
 * any of them calls a paid model, whatever "Ask before costly runs" is set
 * to. Free placeholders just run, with the cost line. When both apply this
 * one dialog replaces the costly-run confirm and carries the total.
 *
 * Copy is GM - Design's, 2026-10-25 (round 4 for the rows' prices and the
 * button, round 5 for the total when a row has no dollar amount), verbatim.
 * The backend refuses the run unless it carries these exact paid
 * placeholders and a total no lower than its own estimate (main.execute_node
 * and main.generate_cinema_shot, `confirmedPlaceholders` and
 * `confirmedCost`), so a missed dialog, a stale tab or another client can't
 * skip it. Its refusal carries that estimate (placeholderRefusalOf), and the
 * canvas asks again with it (withRunEstimate).
 */

export interface PlaceholderRunRow {
  nodeId: string;
  /** The node's name, quoted: “Hero still”. */
  name: string;
  /** The model it runs, unquoted, in the provider's spelling; null when it is the name. */
  model: string | null;
  /** "$0.04", "$0.0047–0.43", "price not listed" or "on your Krea plan" (GM, round 4). */
  price: string;
  agent: PendingAgent;
}

export interface PlaceholderRunConfirm {
  heading: string;
  intro: string;
  rows: PlaceholderRunRow[];
  /** "Plus 1 free node." / "Plus 2 free nodes.", or null. */
  freeLine: string | null;
  /** The costly-run confirm's own line; "The listed prices total $0.43." when
   * a row's price isn't listed; null when no amount covers any row (GM, round 5). */
  totalLine: string | null;
  /** The costly-run confirm's notes (no list price, gates, not included). */
  notes: string[];
  /** "Run for $0.12" (a fixed total), "Run for up to $0.86" (a range), or
   * "Run" when a row's price isn't listed or no price table loaded (GM, round 4). */
  runLabel: string;
  /** The paid placeholders the person confirms; the run sends them. */
  confirmIds: string[];
  /** The run's upper total of its listed prices (USD), rounded to 6 places as
   * Nebula rounds its own (review 4, L1), or null with no price table: the
   * run sends it, and the backend refuses a run its own estimate puts higher. */
  confirmCost: number | null;
}

/** The model a node runs, as its card's model picker labels it (backend
 * main._run_model_name): the chosen model option's label, else the node type. */
function modelName(node: Node<NodeData>): string {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition) return node.data?.definitionId ?? node.id;
  const params = (node.data?.params ?? {}) as Record<string, unknown>;
  for (const spec of [...(definition.params ?? []), ...(definition.sharedParams ?? [])]) {
    if ((spec.key !== 'model' && spec.key !== 'model_id') || spec.type !== 'enum') continue;
    const value = params[spec.key] ?? spec.default;
    const option = spec.options?.find((candidate) => typeof candidate === 'object' && candidate.value === value);
    if (option && typeof option === 'object' && option.label) return String(option.label);
  }
  return definition.displayName;
}

/** Calls a provider (backend model_pricing.is_local): an unknown type counts as paid. */
function isPaid(node: Node<NodeData>): boolean {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  return !definition || !isLocalRun(definition, (node.data?.params ?? {}) as Record<string, unknown>);
}

/** The node and every node feeding it: the person's direct run (summarizeRunScope's node scope). */
function nodeScope(nodes: Node<NodeData>[], edges: Edge[], nodeId: string): Node<NodeData>[] {
  const ids = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (ids.has(edge.target) && !ids.has(edge.source)) {
        ids.add(edge.source);
        changed = true;
      }
    }
  }
  return nodes.filter((node) => ids.has(node.id));
}

/** A row's price (GM - Design, round 4, verbatim): the list price, "on your
 * Krea plan", or "price not listed" (`missing`, which makes the button "Run"). */
function rowPrice(nodeId: string, summary: RunScopeSummary, name: string): { text: string; missing: boolean } {
  const line = summary.cost?.lines.find((candidate) => candidate.nodeId === nodeId);
  if (line) return { text: formatUsdRange(line.low, line.high), missing: false };
  if (summary.cost?.plan.includes(name)) return { text: 'on your Krea plan', missing: false };
  return { text: 'price not listed', missing: true };
}

/** Whether the amount is a range ("up to"), as the costly-run confirm shows it. */
function isRange(cost: RunCost): boolean {
  return formatUsd(cost.low) !== formatUsd(cost.high);
}

/** "Run for $0.12" when the total is fixed, "Run for up to $0.86" when it is a
 * range (matching "could cost up to"), "Run" when a row has no listed price,
 * nothing is priced (only Krea-plan rows) or there is no total (GM - Design,
 * rounds 4 and 5, verbatim). */
function runLabelFor(cost: RunScopeSummary['cost'], anyMissing: boolean): string {
  if (!cost || anyMissing || cost.lines.length === 0) return 'Run';
  return isRange(cost) ? `Run for up to ${formatUsd(cost.high)}` : `Run for ${formatUsd(cost.high)}`;
}

/** The total under the rows (GM - Design, round 5, verbatim: "a dollar amount
 * shows only when it covers every paid row; Krea-plan rows cost nothing extra
 * and don't count as missing"): the costly-run confirm's own line when it
 * does; "The listed prices total (up to) $0.43." when a row's price isn't
 * listed; none when nothing in the run has a listed price. */
function totalLineFor(cost: RunScopeSummary['cost'], anyMissing: boolean): string | null {
  if (!cost || cost.lines.length === 0) return null;
  if (!anyMissing) return `This run could cost up to ${formatUsd(cost.high)} at list prices.`;
  return isRange(cost) ? `The listed prices total up to ${formatUsd(cost.high)}.` : `The listed prices total ${formatUsd(cost.high)}.`;
}

/** USD at 6 places: the arithmetic Nebula's check uses (main._run_estimate). */
function roundUsd(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

/**
 * The dialog before the person's direct run of `nodeId`, or null when no
 * placeholder in that run calls a paid model (free ones just run). `summary`
 * is the run's own (summarizeRunScope, node scope, direct): its total counts
 * the placeholders and everything else.
 */
export function placeholderRunConfirm(
  nodes: Node<NodeData>[],
  edges: Edge[],
  nodeId: string,
  summary: RunScopeSummary,
): PlaceholderRunConfirm | null {
  const placeholders = nodeScope(nodes, edges, nodeId).flatMap((node) => {
    const flag = cleanPending(node.data?.pending);
    return flag ? [{ node, agent: flag.agent }] : [];
  });
  const paid = placeholders.filter(({ node }) => isPaid(node));
  if (paid.length === 0) return null;
  const agents: string[] = [];
  for (const { agent } of placeholders) if (!agents.includes(agent.name)) agents.push(agent.name);
  const one = agents.length === 1 ? agents[0] : null;
  const count = placeholders.length;
  const free = count - paid.length;
  let anyMissing = false;
  const rows = paid.map(({ node, agent }) => {
    const definition = NODE_DEFINITIONS[node.data?.definitionId];
    const label = node.data?.label || definition?.displayName || node.id;
    const model = modelName(node);
    const price = rowPrice(node.id, summary, label);
    if (price.missing) anyMissing = true;
    return { nodeId: node.id, name: `“${label}”`, model: model === label ? null : model, price: price.text, agent };
  });
  const cost = summary.cost;
  return {
    heading: `Run ${count} ${count === 1 ? 'node' : 'nodes'} ${one ? `${one} is` : 'agents are'} still setting up?`,
    intro: one
      ? `${one} hasn't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`
      : `Agents haven't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`,
    rows,
    freeLine: free > 0 ? `Plus ${free} free ${free === 1 ? 'node' : 'nodes'}.` : null,
    totalLine: totalLineFor(cost, anyMissing),
    notes: runCostNotes(summary),
    runLabel: runLabelFor(cost, anyMissing),
    confirmIds: paid.map(({ node }) => node.id).sort(),
    confirmCost: cost ? roundUsd(cost.high) : null,
  };
}

/** Nebula's own estimate of a direct run, as its refusal carries it
 * (backend main._run_estimate): the whole run's total at its keys and its
 * measured inputs, each priced node's share, and node ids for the rest. */
export interface RunEstimate {
  low: number | null;
  high: number | null;
  nodes: Record<string, { low: number; high: number }>;
  unpriced: string[];
  plan: string[];
  plus: string[];
  unavailable: Record<string, string>;
  awaitingInput: string[];
}

/** Nebula's refusal of the person's direct run over paid placeholders (409
 * `placeholder_confirm_required`, main._placeholder_confirm_refusal): which
 * placeholders it needs confirmed, whose they are, and its estimate. */
export interface PlaceholderRefusal {
  placeholders: string[];
  agents: Record<string, PendingAgent>;
  estimate: RunEstimate | null;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function cleanEstimate(raw: unknown): RunEstimate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const nodes: RunEstimate['nodes'] = {};
  for (const [id, line] of Object.entries((value.nodes as Record<string, unknown> | undefined) ?? {})) {
    const low = numberOr((line as { low?: unknown })?.low, null);
    const high = numberOr((line as { high?: unknown })?.high, null);
    if (low !== null && high !== null) nodes[id] = { low, high };
  }
  const unavailable: Record<string, string> = {};
  for (const [id, why] of Object.entries((value.unavailable as Record<string, unknown> | undefined) ?? {})) {
    if (typeof why === 'string') unavailable[id] = why;
  }
  return { low: numberOr(value.low, null), high: numberOr(value.high, null), nodes,
    unpriced: idList(value.unpriced), plan: idList(value.plan),
    plus: idList(value.plus), unavailable, awaitingInput: idList(value.awaitingInput) };
}

/** The refusal in a failed run start, or null for any other error. */
export function placeholderRefusalOf(error: unknown): PlaceholderRefusal | null {
  if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 409) return null;
  const detail = (error as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const body = detail as Record<string, unknown>;
  if (body.code !== 'placeholder_confirm_required') return null;
  const placeholders = idList(body.placeholders);
  if (placeholders.length === 0) return null;
  const agents: Record<string, PendingAgent> = {};
  for (const [id, raw] of Object.entries((body.agents as Record<string, unknown> | undefined) ?? {})) {
    const flag = cleanPending({ agent: raw, at: 0 });
    if (flag) agents[id] = flag.agent;
  }
  return { placeholders, agents, estimate: cleanEstimate(body.estimate) };
}

/** The run's summary priced at Nebula's own estimate (its refusal's): the
 * dialog asks again with the numbers the backend holds the run to, so the
 * confirmation it sends passes (review 4, M1: the tab's keys or a measured
 * input can price it differently). Names come from `nodes`. */
export function withRunEstimate(summary: RunScopeSummary, estimate: RunEstimate, nodes: Node<NodeData>[]): RunScopeSummary {
  const nameOf = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node?.data?.label || NODE_DEFINITIONS[node?.data?.definitionId ?? '']?.displayName || id;
  };
  const lines = Object.entries(estimate.nodes).map(([nodeId, line]) =>
    ({ name: nameOf(nodeId), low: line.low, high: line.high, runs: [1, 1] as [number, number], nodeId }));
  const unavailable = Object.fromEntries(Object.entries(estimate.unavailable).map(([id, why]) => [nameOf(id), why]));
  const cost: RunCost = {
    low: estimate.low ?? 0,
    high: estimate.high ?? 0,
    lines,
    unpriced: estimate.unpriced.map(nameOf),
    plan: estimate.plan.map(nameOf),
    plus: estimate.plus,
    awaitingInput: estimate.awaitingInput.map(nameOf),
    sizeRefs: [],
    ...(Object.keys(unavailable).length ? { unavailable } : {}),
  };
  return { ...summary, cost };
}

/** The run's nodes with the placeholders Nebula's refusal names (`refusal`):
 * a paid one the tab hasn't heard of yet gets its agent's flag from the
 * refusal, and a paid one it lists no longer (an agent made it normal) loses
 * it, so the dialog asks over what Nebula will hold the run to. */
export function withRefusalFlags(nodes: Node<NodeData>[], refusal: PlaceholderRefusal): Node<NodeData>[] {
  const listed = new Set(refusal.placeholders);
  return nodes.map((node) => {
    const flag = cleanPending(node.data?.pending);
    if (listed.has(node.id) && !flag) {
      const agent = refusal.agents[node.id];
      return agent ? { ...node, data: { ...node.data, pending: { agent, at: 0 } } } : node;
    }
    if (!listed.has(node.id) && flag && isPaid(node)) {
      const data = { ...node.data } as NodeData & { pending?: unknown };
      delete data.pending;
      return { ...node, data };
    }
    return node;
  });
}
