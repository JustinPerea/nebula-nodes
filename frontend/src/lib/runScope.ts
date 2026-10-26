import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { batchSizeCap, parseBatchItems } from './batch';
import { hasRoutes, nameOnRoute, routePriceKey, routeUnavailable, selectRoute, withWiredBlockers } from './directRoute';
import { usesKreaAccount } from './kreaConnection';
import { runRouteProvider } from './modelDiscovery';
import { cinemaSceneBase, isLocalRun } from './nodeKeys';
import { awaitsInput, entryForRoute, estimateNode, formatUsd, formatUsdRange, sizingPorts, type InputSize, type PricingTable } from './pricing';
import { cleanPending, pendingIncludedLine, runSkips, skipSummaryOf, type PendingSkipSummary } from './pendingNodes';

/** What a run would cost, from the curated list prices. Only USD is summed. */
export interface RunCost {
  low: number;
  high: number;
  /** Priced paid nodes, each with how many times it would run. */
  lines: Array<{ name: string; low: number; high: number; runs: [number, number]; nodeId?: string }>;
  /** Paid nodes with no list price for these settings or this route. */
  unpriced: string[];
  /** Nodes billed to a subscription (a Krea account) rather than per run. */
  plan: string[];
  /** Known costs the vendor doesn't publish a fixed price for, e.g. "input images". */
  plus: string[];
  /** Route-table nodes whose chosen route (or Auto's) can't run, by name,
   * with the reason (directRoute.routeUnavailable). Also in `unpriced`;
   * never priced at another route. Present only when there are some. */
  unavailable?: Record<string, string>;
  /** Nodes priced from their input file's size, which isn't known yet (also in `unpriced`). */
  awaitingInput: string[];
  /** Those of them whose file exists but the backend can't measure (a file on
   * another host, never downloaded to price it, or one it can't read). Also in
   * `awaitingInput`. Present only when there are some. */
  sizeUnreadable?: string[];
  /** Input files to measure (inputSizeStore) before those can be priced. */
  sizeRefs: Array<{ ref: string; kind: 'Image' | 'Video' }>;
  /** `unpriced`, `plan` and `awaitingInput` by node id, for a reader that
   * needs each node's own (two nodes can share a name): the placeholder
   * dialog's rows (lib/placeholderRunConfirm.ts). */
  ids?: { unpriced: string[]; plan: string[]; awaitingInput: string[] };
}

export interface RunScopeSummary {
  /** Nodes the run would execute. */
  total: number;
  /** Display names of nodes that call an external (paid) provider. */
  paid: string[];
  /** Present once the price table has loaded. */
  cost?: RunCost;
  /** Paid nodes behind a gate (downstream of a conditional port, such as Jev
   *  Decide's On Pass / On Fail). The estimate still counts them, though the
   *  run may skip them, and a skipped node costs nothing. */
  gated?: string[];
  /** Agents' placeholders (and what needs them) this run skips, left out of
   *  `total`, `paid` and `cost` (Q125 item 3). Present only when there are some. */
  pendingSkipped?: PendingSkipSummary;
  /** Placeholders (and what needs them) the person's direct run of a node
   *  makes run, counted in `total`, `paid` and `cost`; the line under the
   *  cost says so. Present only when there are some. */
  pendingIncluded?: PendingSkipSummary;
  /** The provider each paid node's run goes through, by node id (selectRoute,
   *  with the keys of the cost context): the confirm rows name it (GM - Design,
   *  round 15, item 3). Present with a cost context. */
  routes?: Record<string, string>;
}

/** A node's name in a run's confirm and summary: the name the person gave
 * it; a node still under its model's own name is named by the route the
 * run takes (GM - Design, rounds 15 and 16: "Grok Imagine 2.0 via xAI" on the
 * person's xAI key, never the Krea copy's name). */
export function runNodeName(node: Node<NodeData>, provider: string | null | undefined): string {
  const definition = node.data?.definitionId ? NODE_DEFINITIONS[node.data.definitionId] : undefined;
  const label = node.data?.label;
  if (label && label !== definition?.displayName) return label;
  return definition ? nameOnRoute(definition, provider) : (label || node.id);
}

export interface RunCostContext {
  pricing: PricingTable | null;
  apiKeys: Readonly<Record<string, string>>;
  /** Measured input files by ref (inputSizeStore), for prices that read them. */
  sizes?: Readonly<Record<string, InputSize | null>>;
}

const INPUT_NODES: Record<string, 'Image' | 'Video'> = { 'image-input': 'Image', 'video-input': 'Video' };

/**
 * `node` with `direct: false` is a run of a node that isn't the person's
 * direct run (an accepted proposal's run): it skips placeholders like any
 * other. The person's direct run (the default) runs the placeholders in its
 * scope (backend main._skip_placeholders).
 */
export type RunScope = { kind: 'graph' } | { kind: 'node'; nodeId: string; direct?: boolean } | { kind: 'cluster'; nodeIds: string[] };

const FANOUT_IDS = new Set(['batch', 'iterator-image', 'iterator-text']);

/** Ids of nodes downstream of a gate port (a conditional output) within these
 * nodes and edges: the ones a run may skip (backend execution/gating.py). */
export function nodesBehindGates(nodes: Node<NodeData>[], edges: Edge[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const behind = new Set<string>();
  const queue: string[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    if (!source || !byId.has(edge.target) || !edge.sourceHandle) continue;
    const port = NODE_DEFINITIONS[source.data?.definitionId]?.outputPorts.find((p) => p.id === edge.sourceHandle);
    if (port?.conditional && !behind.has(edge.target)) {
      behind.add(edge.target);
      queue.push(edge.target);
    }
  }
  while (queue.length) {
    const id = queue.pop()!;
    for (const edge of edges) {
      if (edge.source === id && byId.has(edge.target) && !behind.has(edge.target)) {
        behind.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return behind;
}

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

/** The input ports of one canvas node that have an edge into them, as the
 * run estimate reads them (wiredPorts), for the node's own route display
 * (its run status and its Inspector params). */
export function nodeWiredPorts(nodeId: string, edges: readonly Pick<Edge, 'target' | 'targetHandle'>[]): string[] {
  const ports = new Set<string>();
  for (const edge of edges) if (edge.target === nodeId && edge.targetHandle) ports.add(edge.targetHandle);
  return [...ports].sort();
}

/** One node's input ports with how many edges reach each: what the provider
 * switcher and the card chip give a route's `ports` rule
 * (lib/directRoute.ts withWiredBlockers), as the preflight counts them. */
export function nodeWiredCounts(nodeId: string, edges: readonly Pick<Edge, 'target' | 'targetHandle'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.target === nodeId && edge.targetHandle) counts.set(edge.targetHandle, (counts.get(edge.targetHandle) ?? 0) + 1);
  }
  return counts;
}

/** Each run node's input ports that have an edge into them, with how many
 * edges reach each. A priced setting that arrives by wire is only known at
 * run time (pricing.estimateNode).
 * Mirrors wired_counts in backend services/model_pricing.py over the edges the
 * run sends: only edges whose source also runs, since a cluster run sends just
 * the edges inside it (graphStore runCluster) and a wire from outside never
 * reaches the backend. Graph and node scopes already hold every source. */
export function wiredPorts(nodes: Node<NodeData>[], edges: Edge[]): Map<string, Map<string, number>> {
  const ids = new Set(nodes.map((node) => node.id));
  const wired = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || !edge.targetHandle) continue;
    // How many edges reach each port: a route-table node's `ports` rule reads
    // it (model_pricing.wired_counts).
    const ports = wired.get(edge.target) ?? new Map<string, number>();
    ports.set(edge.targetHandle, (ports.get(edge.targetHandle) ?? 0) + 1);
    wired.set(edge.target, ports);
  }
  return wired;
}

/** The nodes a run of `scope` sends and runs, as the backend reads it: the
 * scope, less agents' placeholders and what needs them, except on the
 * person's direct run of a node (it runs them). */
export function nodesThatRun(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope): Node<NodeData>[] {
  return scopeOf(nodes, edges, scope).included;
}

function scopeOf(nodes: Node<NodeData>[], edges: Edge[], scope: RunScope): {
  included: Node<NodeData>[]; pendingSkipped: PendingSkipSummary | null; pendingIncluded: PendingSkipSummary | null;
} {
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

  // Agents' placeholders (Q125 item 3), as the backend's run treats them
  // (main._skip_placeholders): every run skips each one and what needs it,
  // except the person's direct run of a node, which runs the placeholders in
  // its scope. So the cost prices what will run, as the spend check does.
  const flags = new Map(included.flatMap((node) => {
    const flag = cleanPending(node.data?.pending);
    return flag ? [[node.id, flag] as const] : [];
  }));
  let pendingSkipped: PendingSkipSummary | null = null;
  let pendingIncluded: PendingSkipSummary | null = null;
  if (flags.size > 0) {
    const scopeIds = included.map((node) => node.id);
    const skips = runSkips(scopeIds, edges, (id) => flags.get(id) ?? null);
    if (scope.kind === 'node' && scope.direct !== false) {
      pendingIncluded = skipSummaryOf(skips);
    } else {
      pendingSkipped = skipSummaryOf(skips);
      included = included.filter((node) => !skips.has(node.id));
    }
  }
  return { included, pendingSkipped, pendingIncluded };
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
  const { included, pendingSkipped, pendingIncluded } = scopeOf(nodes, edges, scope);

  const paid: string[] = [];
  const pricing = costContext?.pricing;
  const ids: NonNullable<RunCost['ids']> = { unpriced: [], plan: [], awaitingInput: [] };
  const cost: RunCost = { low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], ids };
  // Fan-out within what actually runs: a node scope already holds every
  // upstream Batch, and a cluster run sends only its own nodes and edges.
  const multipliers = pricing ? runMultipliers(included, edges) : null;
  const wired = wiredPorts(included, edges);
  const behindGates = nodesBehindGates(included, edges);
  const gated: string[] = [];
  const routes: Record<string, string> = {};
  for (const node of included) {
    let definition = node.data?.definitionId ? NODE_DEFINITIONS[node.data.definitionId] : undefined;
    let params = (node.data?.params ?? {}) as Record<string, unknown>;
    let calls = 1;
    let noPrice = false;
    let ports: ReadonlyMap<string, number> = wired.get(node.id) ?? new Map();
    if (!definition || isLocalRun(definition, params)) continue;
    // The provider the run goes through (the wires a Krea-only setting
    // arrives by keep it on Krea), for the name the confirm shows.
    const provider = costContext && !definition.providerVia
      ? selectRoute(definition, withWiredBlockers(definition, params, ports), costContext.apiKeys).provider : null;
    if (provider) routes[node.id] = provider;
    const name = definition.providerVia ? (node.data?.label || definition.displayName || node.id) : runNodeName(node, provider);
    if (definition.providerVia?.kind === 'model') {
      const nested = cinemaSceneBase(params, definition);
      if (nested && NODE_DEFINITIONS[nested.model]) {
        definition = NODE_DEFINITIONS[nested.model];
        params = nested.params;
        calls = nested.shots;
        ports = new Map(); // the scene's ports aren't its base model's params
      } else {
        noPrice = true;
      }
    } else if (definition.apiProvider === 'utility') {
      // A local node whose providerVia param picks provider work: priced
      // only by a row of its own entry for that value (QC Jev mode); vision-llm
      // QC calls a vision model, and Nebula has no list price for it.
      noPrice = !pricing?.nodes[definition.id];
    }
    paid.push(name);
    if (behindGates.has(node.id)) gated.push(name);
    if (!pricing || !multipliers) continue;
    if (noPrice) {
      cost.unpriced.push(name);
      ids.unpriced.push(node.id);
      continue;
    }
    // A Krea-only setting that arrives by wire keeps the run on Krea
    // (directRoute.withWiredBlockers), as the backend router does, and a
    // wired input can block or unblock a route-table node's plan route.
    const routed = withWiredBlockers(definition, params, ports);
    if (usesKreaAccount(definition, routed)) {
      cost.plan.push(name);
      ids.plan.push(node.id);
      continue;
    }
    let priceKey: string | null;
    if (hasRoutes(definition)) {
      const missing = routeUnavailable(definition, routed, costContext.apiKeys);
      if (missing) {
        cost.unpriced.push(name);
        ids.unpriced.push(node.id);
        cost.unavailable = { ...cost.unavailable, [name]: missing.message };
        continue;
      }
      priceKey = routePriceKey(definition, selectRoute(definition, routed, costContext.apiKeys));
    } else {
      priceKey = runRouteProvider(definition, costContext.apiKeys, routed);
    }
    // A price read from the input file: only an Image or Video Input in this
    // run gives a file before it runs (backend services/input_sizes.py).
    const entry = pricing.nodes[definition.id];
    let size: InputSize | null | undefined;
    for (const port of calls === 1 ? sizingPorts(entry) : []) {
      const wires = edges.filter((edge) => edge.target === node.id && edge.targetHandle === port);
      const source = wires.length === 1 ? included.find((candidate) => candidate.id === wires[0].source) : undefined;
      const kind = INPUT_NODES[source?.data?.definitionId ?? ''];
      const ref = source?.data?.params?.filePath;
      if (!kind || typeof ref !== 'string' || !ref) continue;
      size = costContext.sizes?.[ref];
      if (size === undefined) cost.sizeRefs.push({ ref, kind });
      break;
    }
    const estimate = estimateNode(entry, definition, params, priceKey, ports.keys(), size);
    if (!estimate || estimate.currency !== 'usd') {
      cost.unpriced.push(name);
      ids.unpriced.push(node.id);
      if (!size && awaitsInput(entryForRoute(entry, priceKey))) {
        cost.awaitingInput.push(name);
        ids.awaitingInput.push(node.id);
        if (size === null) cost.sizeUnreadable = [...(cost.sizeUnreadable ?? []), name];
      }
      continue;
    }
    const [fewest, most] = multipliers.get(node.id) ?? [1, 1];
    // A cinema scene's base model runs once per shot.
    const runs: [number, number] = [fewest * calls, most * calls];
    const line = { name, low: estimate.low * runs[0], high: estimate.high * runs[1], runs, nodeId: node.id };
    cost.lines.push(line);
    cost.low += line.low;
    cost.high += line.high;
    if (estimate.plus && !cost.plus.includes(estimate.plus)) cost.plus.push(estimate.plus);
  }
  const summary: RunScopeSummary = pricing ? { total: included.length, paid, cost } : { total: included.length, paid };
  if (costContext) summary.routes = routes;
  if (gated.length) summary.gated = gated;
  if (pendingSkipped) summary.pendingSkipped = pendingSkipped;
  if (pendingIncluded) summary.pendingIncluded = pendingIncluded;
  return summary;
}

/** The same run done `passes` times (a Cinema shot's variations, each a
 * full pass with the cache off): every price and run count multiplied. */
export function repeatRun(summary: RunScopeSummary, passes: number): RunScopeSummary {
  const times = Number.isFinite(passes) && passes > 1 ? Math.floor(passes) : 1;
  if (times === 1 || !summary.cost) return summary;
  const { cost } = summary;
  return { ...summary, cost: { ...cost, low: cost.low * times, high: cost.high * times,
    lines: cost.lines.map((line) => ({ ...line, low: line.low * times, high: line.high * times,
      runs: [line.runs[0] * times, line.runs[1] * times] as [number, number] })) } };
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

const AWAITING = 'Priced when its input is known:';
const UNREADABLE = "Nebula can't read the size of its input (a file on another host is never downloaded to price it):";

/** The awaiting-input notes: still to be made, or there but unreadable. */
function awaitingNotes(cost: RunCost): string[] {
  const unreadable = cost.sizeUnreadable ?? [];
  // Names repeat (two SeedVR2 nodes), so take each unreadable one out once.
  const pending = [...(cost.awaitingInput ?? [])];
  for (const name of unreadable) pending.splice(pending.indexOf(name), 1);
  const notes: string[] = [];
  if (pending.length) notes.push(`${AWAITING} ${nameList(pending)}`);
  if (unreadable.length) notes.push(`${UNREADABLE} ${nameList(unreadable)}`);
  return notes;
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
export function describeRunScope({ total, paid, cost, gated, pendingIncluded }: RunScopeSummary): string {
  const nodes = `${total} ${total === 1 ? 'node' : 'nodes'}`;
  // GM - Design, 2026-10-25: the run counts the placeholders it runs and says so.
  const included = pendingIncludedLine(pendingIncluded)?.replace(/\.$/, '');
  if (paid.length === 0) return [`Runs ${nodes} · no paid providers`, included].filter(Boolean).join('. ');
  const parts = [`Runs ${nodes} · ${paid.length} ${paid.length === 1 ? 'calls a paid provider' : 'call paid providers'}: ${nameList(paid)}`];
  if (cost && cost.lines.length > 0) {
    const total = formatUsdRange(cost.low, cost.high);
    const detail = cost.lines.map((line) => `${line.name} ${formatUsdRange(line.low, line.high)}${runsLabel(line.runs)}`);
    parts.push(`Estimated ${total} at list prices (${detail.join('; ')})`);
  }
  if (included) parts.push(included);
  if (cost?.plus.length) parts.push(`Not included: ${cost.plus.join(', ')}`);
  const unavailable = Object.keys(cost?.unavailable ?? {});
  const awaiting = cost?.awaitingInput ?? [];
  const unpriced = cost?.unpriced.filter((name) => !unavailable.includes(name) && !awaiting.includes(name)) ?? [];
  if (unpriced.length) parts.push(`No list price for ${nameList(unpriced)}`);
  if (cost && awaiting.length) parts.push(...awaitingNotes(cost));
  // Each of these has its own message on the node and in the run error.
  if (unavailable.length) parts.push(`Can't run on the chosen provider: ${nameList(unavailable)}`);
  if (cost?.plan.length) parts.push(`Billed to your Krea plan: ${nameList(cost.plan)}`);
  if (gated?.length) parts.push(gatedNote(gated));
  return parts.join('. ');
}

/** The estimate counts every node; say so when a gate may skip some. */
function gatedNote(gated: string[]): string {
  const them = gated.length === 1 ? 'it' : 'them';
  return `A gate may skip ${nameList(gated)}. The estimate still counts ${them}, and a skipped node costs nothing`;
}

/** The confirm text when a run's estimate reaches the user's threshold. */
export function runCostConfirmMessage({ cost, gated, pendingIncluded }: RunScopeSummary): string {
  if (!cost) return 'Run it?';
  // GM - Design, 2026-10-25: "a line under the cost".
  const included = pendingIncludedLine(pendingIncluded);
  const lines = cost.lines.map((line) => `• ${line.name}: ${formatUsdRange(line.low, line.high)}${runsLabel(line.runs)}`);
  return [
    [`This run could cost up to ${formatUsd(cost.high)} at list prices.`, included].filter(Boolean).join('\n'),
    lines.join('\n'),
    ...runCostNotes({ cost, gated }),
    'Run it?',
  ].filter(Boolean).join('\n\n');
}

/** The costly-run confirm's notes under its prices (gates, not included, no
 * list price, priced once its input is known); the placeholder run dialog
 * (lib/placeholderRunConfirm.ts) shows the gates and what's not included
 * (`prices: false`), and says the rest in its rows. */
export function runCostNotes({ cost, gated }: Pick<RunScopeSummary, 'cost' | 'gated'>,
  { prices = true }: { prices?: boolean } = {}): string[] {
  const notes: string[] = [];
  if (gated?.length) notes.push(`${gatedNote(gated)}.`);
  if (!cost) return notes;
  if (cost.plus.length) notes.push(`Not included: ${cost.plus.join(', ')}.`);
  // The placeholder dialog says these in its rows and its own footnote (GM - Design, round 6).
  if (!prices) return notes;
  const unpriced = cost.unpriced.filter((name) => !cost.awaitingInput?.includes(name));
  if (unpriced.length) notes.push(`No list price for ${nameList(unpriced)}, so it may cost more.`);
  notes.push(...awaitingNotes(cost).map((note) => `${note}, so it may cost more.`));
  return notes;
}

/** Whether this run's high estimate reaches the threshold (null never asks). */
export function shouldConfirmRunCost(summary: RunScopeSummary, thresholdUsd: number | null): boolean {
  return thresholdUsd !== null && Boolean(summary.cost) && summary.cost!.high >= thresholdUsd;
}
