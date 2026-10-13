import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { batchSizeCap, parseBatchItems } from './batch';
import { usesKreaAccount } from './kreaConnection';
import { runRouteProvider } from './modelDiscovery';
import { cinemaSceneBase, isLocalRun } from './nodeKeys';
import { estimateNode, formatUsd, formatUsdRange, type PricingTable } from './pricing';

/** What a run would cost, from the curated list prices. Only USD is summed. */
export interface RunCost {
  low: number;
  high: number;
  /** Priced paid nodes, each with how many times it would run. */
  lines: Array<{ name: string; low: number; high: number; runs: [number, number] }>;
  /** Paid nodes with no list price for these settings or this route. */
  unpriced: string[];
  /** Nodes billed to a subscription (a Krea account) rather than per run. */
  plan: string[];
  /** Known costs the vendor doesn't publish a fixed price for, e.g. "input images". */
  plus: string[];
}

export interface RunScopeSummary {
  /** Nodes the run would execute. */
  total: number;
  /** Display names of nodes that call an external (paid) provider. */
  paid: string[];
  /** Present once the price table has loaded. */
  cost?: RunCost;
}

export interface RunCostContext {
  pricing: PricingTable | null;
  apiKeys: Readonly<Record<string, string>>;
}

export type RunScope = { kind: 'graph' } | { kind: 'node'; nodeId: string } | { kind: 'cluster'; nodeIds: string[] };

const FANOUT_IDS = new Set(['batch', 'iterator-image', 'iterator-text']);

/**
 * How many times each node runs, as [low, high]. Everything downstream of a
 * Batch runs once per item; downstream of an Iterator, once per array item up
 * to its cap (the array isn't known until the run). The engine rejects joins
 * of independent batches and caps nested expansion at the inner iterator's
 * cap, so the nearest fan-out above a node decides its count.
 */
export function runMultipliers(nodes: Node<NodeData>[], edges: Edge[]): Map<string, [number, number]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    parents.set(edge.target, [...(parents.get(edge.target) ?? []), edge.source]);
  }
  const runs = new Map<string, [number, number]>();
  const outs = new Map<string, [number, number]>();
  const visiting = new Set<string>();

  function out(id: string): [number, number] {
    const known = outs.get(id);
    if (known) return known;
    if (visiting.has(id)) return [1, 1];
    visiting.add(id);
    const ownRuns = run(id);
    const node = byId.get(id);
    const params = (node?.data?.params ?? {}) as Record<string, unknown>;
    let result = ownRuns;
    if (node && FANOUT_IDS.has(node.data?.definitionId)) {
      if (node.data.definitionId === 'batch') {
        const count = parseBatchItems(params).length;
        result = [count, count];
      } else {
        result = [1, batchSizeCap(params)];
      }
    }
    visiting.delete(id);
    outs.set(id, result);
    return result;
  }

  function run(id: string): [number, number] {
    const known = runs.get(id);
    if (known) return known;
    let result: [number, number] = [1, 1];
    for (const parent of parents.get(id) ?? []) {
      const range = out(parent);
      if (range[1] > result[1] || (range[1] === result[1] && range[0] < result[0])) result = range;
    }
    runs.set(id, result);
    return result;
  }

  for (const node of nodes) run(node.id);
  return runs;
}

// cinema-scene is a local node that calls its base image model's handler once
// per shot (backend handlers/cinema_scene.py), so it is priced as that model
// times its shots. Its allowlist is the definition's providerVia (nodeKeys.ts).
export { cinemaSceneBase } from './nodeKeys';

/** Each run node's input ports that have an edge into them. A priced setting
 * that arrives by wire is only known at run time (pricing.estimateNode).
 * Mirrors wired_ports in backend services/model_pricing.py. */
export function wiredPorts(nodes: Node<NodeData>[], edges: Edge[]): Map<string, Set<string>> {
  const ids = new Set(nodes.map((node) => node.id));
  const wired = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!ids.has(edge.target) || !edge.targetHandle) continue;
    wired.set(edge.target, new Set([...(wired.get(edge.target) ?? []), edge.targetHandle]));
  }
  return wired;
}

/**
 * Mirrors the stores' run scopes so Run buttons can say what they will do:
 * the whole graph; one target plus every node feeding it; or an explicit
 * cluster. A node is paid when it calls a provider: any non-utility node, and
 * a utility node whose providerVia says it does with these params.
 * With a cost context, it also estimates the run from the price table.
 */
export function summarizeRunScope(
  nodes: Node<NodeData>[],
  edges: Edge[],
  scope: RunScope,
  costContext?: RunCostContext,
): RunScopeSummary {
  let included: Node<NodeData>[];
  if (scope.kind === 'graph') {
    included = nodes;
  } else if (scope.kind === 'cluster') {
    const ids = new Set(scope.nodeIds);
    included = nodes.filter((node) => ids.has(node.id));
  } else {
    const ids = new Set([scope.nodeId]);
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
    included = nodes.filter((node) => ids.has(node.id));
  }

  const paid: string[] = [];
  const pricing = costContext?.pricing;
  const cost: RunCost = { low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [] };
  // Fan-out within what actually runs: a node scope already holds every
  // upstream Batch, and a cluster run sends only its own nodes and edges.
  const multipliers = pricing ? runMultipliers(included, edges) : null;
  const wired = wiredPorts(included, edges);
  for (const node of included) {
    let definition = node.data?.definitionId ? NODE_DEFINITIONS[node.data.definitionId] : undefined;
    let params = (node.data?.params ?? {}) as Record<string, unknown>;
    let calls = 1;
    let noPrice = false;
    let ports: Iterable<string> = wired.get(node.id) ?? [];
    const name = node.data?.label || definition?.displayName || node.id;
    if (!definition || isLocalRun(definition, params)) continue;
    if (definition.providerVia?.kind === 'model') {
      const nested = cinemaSceneBase(params, definition);
      if (nested && NODE_DEFINITIONS[nested.model]) {
        definition = NODE_DEFINITIONS[nested.model];
        params = nested.params;
        calls = nested.shots;
        ports = []; // the scene's ports aren't its base model's params
      } else {
        noPrice = true;
      }
    } else if (definition.apiProvider === 'utility') {
      // A local node whose providerVia param picks provider work (vision-llm
      // QC): it calls a vision model, and Nebula has no list price for it.
      noPrice = true;
    }
    paid.push(name);
    if (!pricing || !multipliers) continue;
    if (noPrice) {
      cost.unpriced.push(name);
      continue;
    }
    if (usesKreaAccount(definition, params)) {
      cost.plan.push(name);
      continue;
    }
    const estimate = estimateNode(
      pricing.nodes[definition.id], definition, params,
      runRouteProvider(definition, costContext.apiKeys), ports,
    );
    if (!estimate || estimate.currency !== 'usd') {
      cost.unpriced.push(name);
      continue;
    }
    const [fewest, most] = multipliers.get(node.id) ?? [1, 1];
    // A cinema scene's base model runs once per shot.
    const runs: [number, number] = [fewest * calls, most * calls];
    const line = { name, low: estimate.low * runs[0], high: estimate.high * runs[1], runs };
    cost.lines.push(line);
    cost.low += line.low;
    cost.high += line.high;
    if (estimate.plus && !cost.plus.includes(estimate.plus)) cost.plus.push(estimate.plus);
  }
  return pricing ? { total: included.length, paid, cost } : { total: included.length, paid };
}

/** The Run chip: "~$0.04", "$0.0047–0.43", "$0.04+" when part of the run
 * has no list price, "N paid" when none of it does. Null when nothing is paid. */
export function runChipLabel({ paid, cost }: RunScopeSummary): string | null {
  if (paid.length === 0) return null;
  if (!cost || cost.lines.length === 0) return `${paid.length} paid`;
  const exact = formatUsd(cost.low) === formatUsd(cost.high);
  const amount = exact ? formatUsd(cost.high) : formatUsdRange(cost.low, cost.high);
  // "+" when part of the run has no list price, so the real total can be higher.
  if (cost.unpriced.length > 0 || cost.plus.length > 0) return `${amount}+`;
  return exact ? `~${amount}` : amount;
}

function nameList(names: string[]): string {
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function runsLabel([low, high]: [number, number]): string {
  if (low === 1 && high === 1) return '';
  return low === high ? ` × ${high} runs` : ` × up to ${high} runs`;
}

/** "Runs 2 nodes · 1 calls a paid provider: GPT Image 2.5", then the
 * estimate per node when the price table has loaded. */
export function describeRunScope({ total, paid, cost }: RunScopeSummary): string {
  const nodes = `${total} ${total === 1 ? 'node' : 'nodes'}`;
  if (paid.length === 0) return `Runs ${nodes} · no paid providers`;
  const parts = [`Runs ${nodes} · ${paid.length} ${paid.length === 1 ? 'calls a paid provider' : 'call paid providers'}: ${nameList(paid)}`];
  if (cost && cost.lines.length > 0) {
    const total = formatUsdRange(cost.low, cost.high);
    const detail = cost.lines.map((line) => `${line.name} ${formatUsdRange(line.low, line.high)}${runsLabel(line.runs)}`);
    parts.push(`Estimated ${total} at list prices (${detail.join('; ')})`);
  }
  if (cost?.plus.length) parts.push(`Not included: ${cost.plus.join(', ')}`);
  if (cost?.unpriced.length) parts.push(`No list price for ${nameList(cost.unpriced)}`);
  if (cost?.plan.length) parts.push(`Billed to your Krea plan: ${nameList(cost.plan)}`);
  return parts.join('. ');
}

/** The confirm text when a run's estimate reaches the user's threshold. */
export function runCostConfirmMessage({ cost }: RunScopeSummary): string {
  if (!cost) return 'Run it?';
  const lines = cost.lines.map((line) => `• ${line.name}: ${formatUsdRange(line.low, line.high)}${runsLabel(line.runs)}`);
  const notes: string[] = [];
  if (cost.plus.length) notes.push(`Not included: ${cost.plus.join(', ')}.`);
  if (cost.unpriced.length) notes.push(`No list price for ${nameList(cost.unpriced)}, so it may cost more.`);
  return [
    `This run could cost up to ${formatUsd(cost.high)} at list prices.`,
    lines.join('\n'),
    ...notes,
    'Run it?',
  ].filter(Boolean).join('\n\n');
}

/** Whether this run's high estimate reaches the threshold (null never asks). */
export function shouldConfirmRunCost(summary: RunScopeSummary, thresholdUsd: number | null): boolean {
  return thresholdUsd !== null && Boolean(summary.cost) && summary.cost!.high >= thresholdUsd;
}
