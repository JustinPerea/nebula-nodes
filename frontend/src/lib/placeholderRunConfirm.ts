import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { isLocalRun } from './nodeKeys';
import { cleanPending, type PendingAgent } from './pendingNodes';
import { formatUsd, formatUsdRange } from './pricing';
import { runCostNotes, type RunScopeSummary } from './runScope';

/**
 * Q133 (Justin, 2026-10-25, option b): the person's direct run still runs the
 * agents' placeholders feeding the node, but Nebula always asks first when
 * any of them calls a paid model, whatever "Ask before costly runs" is set
 * to. Free placeholders just run, with the cost line. When both apply this
 * one dialog replaces the costly-run confirm and carries the total.
 *
 * Copy is GM - Design's, 2026-10-25 (round 4 for the rows' prices and the
 * button), verbatim. The backend refuses the run unless it carries these
 * exact paid placeholders and a total no lower than its own estimate
 * (main.execute_node and main.generate_cinema_shot, `confirmedPlaceholders`
 * and `confirmedCost`), so a missed dialog, a stale tab or another client
 * can't skip it.
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
  /** The costly-run confirm's own line, or null when no price table loaded. */
  totalLine: string | null;
  /** The costly-run confirm's notes (no list price, gates, not included). */
  notes: string[];
  /** "Run for $0.12" (a fixed total), "Run for up to $0.86" (a range), or
   * "Run" when a row's price isn't listed or no price table loaded (GM, round 4). */
  runLabel: string;
  /** The paid placeholders the person confirms; the run sends them. */
  confirmIds: string[];
  /** The run's upper total the dialog shows (USD), or null without one: the
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

/** "Run for $0.12" when the total is fixed, "Run for up to $0.86" when it is a
 * range (matching "could cost up to"), "Run" when a row has no listed price
 * or there is no total (GM - Design, round 4, verbatim). */
function runLabelFor(cost: RunScopeSummary['cost'], anyMissing: boolean): string {
  if (!cost || anyMissing) return 'Run';
  return formatUsd(cost.low) === formatUsd(cost.high) ? `Run for ${formatUsd(cost.high)}` : `Run for up to ${formatUsd(cost.high)}`;
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
    totalLine: cost ? `This run could cost up to ${formatUsd(cost.high)} at list prices.` : null,
    notes: runCostNotes(summary),
    runLabel: runLabelFor(cost, anyMissing),
    confirmIds: paid.map(({ node }) => node.id).sort(),
    confirmCost: cost ? cost.high : null,
  };
}
