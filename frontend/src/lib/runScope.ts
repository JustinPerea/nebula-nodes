import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { batchSizeCap, parseBatchItems } from './batch';
import {
  envKeyNames, hasRoutes, isDefaultTitle, keyBilling, keyBillingAccount, keyPhrase, nameOnRoute, routePriceKey, routeUnavailable,
  selectRoute, withWiredBlockers,
} from './directRoute';
import { namesSeveral, nodeNameList } from './errorCopy';
import { usesKreaAccount } from './kreaConnection';
import { cinemaSceneBase, isLocalRun } from './nodeKeys';
import {
  awaitsInput, chipEstimate, chipTitle, entryForRoute, estimateNode, formatChipEstimate, formatUsd,
  formatUsdRange, sizingPorts, type InputSize, type PricingTable,
} from './pricing';
import { cleanPending, pendingIncludedLine, runSkips, skipSummaryOf, type PendingSkipSummary } from './pendingNodes';
import {
  AWAITING_INPUT, LEFT_OUT, LEFT_OUT_OTHER, MISSING_KEY, MISSING_KEY_UNNAMED, NO_LISTED_PRICE, ROUTE_CANT_RUN,
  SIZE_UNREADABLE,
} from './unpricedCopy';

/** Why a paid node in a run adds to the "+ unpriced" chip (GM, PR #198 r7
 * item 3): it has no known price (also in `unpriced`), or its estimate
 * leaves a cost out (`leftOut`, also in `plus`).
 * - `noPrice`: no list price for these settings, a setting it reads arrives
 *   by wire, or an estimate that isn't in USD;
 * - `missingKey`: its chosen route (or Auto) has no key; `key` is the key as
 *   the node's route line names it ("fal.ai API key"), null when unnamed;
 * - `cantRun`: its chosen route can't take the run for another reason;
 * - `awaitingInput`: priced from its input's size, not known yet;
 * - `sizeUnreadable`: priced from its input's size, which can't be read;
 * - `leftOut`: priced, with a cost its price entry's `plus` names. */
export type UnpricedReason =
  | { kind: 'noPrice' | 'cantRun' | 'awaitingInput' | 'sizeUnreadable' }
  | { kind: 'missingKey'; key: string | null }
  | { kind: 'leftOut'; plus: string };

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
  /** Each node that makes the chip open, with why, in the order the run
   * walks them: the store's node order (the order nodes were added), not
   * their position on screen. The Run chip's tooltip reads it. */
  reasons?: Array<{ name: string; reason: UnpricedReason; at?: { x: number; y: number } }>;
  /** `unpriced`, `plan` and `awaitingInput` by node id, for a reader that
   * needs each node's own (two nodes can share a name): the placeholder
   * dialog's rows (lib/placeholderRunConfirm.ts). */
  ids?: { unpriced: string[]; plan: string[]; awaitingInput: string[]; unavailable?: Record<string, string> };
  /** Every priced line is a sourced $0 (its row's price is 0), so the total
   * is exact, not an estimate that rounds to zero (GM, PR #203 r11 item 4:
   * "$0" against "~$0"). Present only when true. */
  sourcedZero?: true;
}

export interface RunScopeSummary {
  /** Nodes the run would execute. */
  total: number;
  /** Display names of nodes that call an external (paid) provider. */
  paid: string[];
  /** Nodes on a route that may bill the person's own account because their
   * key is set (directRoute.keyBilling "mayCost": Idol with a Hugging Face
   * token), never in `paid` or `cost` (GM, PR #203 r11 item 2: "2 paid · 1
   * may cost"), with the account. Present only when there are some; the same
   * route with no key is free and adds nothing (r12). */
  mayCost?: Array<{ name: string; account: string }>;
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
 * person's xAI key, never the Krea copy's name; round 19, review 18 L-A:
 * "Grok Imagine 2.0 via Krea" on Krea, never "Grok Imagine 2.0 (Krea)",
 * when its route depends on keys: nameOnRoute). */
export function runNodeName(node: Node<NodeData>, provider: string | null | undefined): string {
  const definition = node.data?.definitionId ? NODE_DEFINITIONS[node.data.definitionId] : undefined;
  const label = node.data?.label;
  // GM - Design, round 18: either form of the default title is unnamed.
  if (label && !isDefaultTitle(definition, label)) return label;
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
  const mayCost: NonNullable<RunScopeSummary['mayCost']> = [];
  let zeroRows = true;
  const pricing = costContext?.pricing;
  const ids: NonNullable<RunCost['ids']> = { unpriced: [], plan: [], awaitingInput: [] };
  const cost: RunCost = {
    low: 0, high: 0, lines: [], unpriced: [], plan: [], plus: [], awaitingInput: [], sizeRefs: [], reasons: [], ids,
  };
  let at: { x: number; y: number } | undefined;
  const because = (name: string, reason: UnpricedReason) => cost.reasons!.push({ name, reason, ...(at ? { at } : {}) });
  // Fan-out within what actually runs: a node scope already holds every
  // upstream Batch, and a cluster run sends only its own nodes and edges.
  const multipliers = pricing ? runMultipliers(included, edges) : null;
  const wired = wiredPorts(included, edges);
  const behindGates = nodesBehindGates(included, edges);
  const gated: string[] = [];
  const routes: Record<string, string> = {};
  for (const node of included) {
    at = node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y) ? node.position : undefined;
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
    // Free unless the person's key is set, and then it may bill their own
    // account: never paid, never priced (GM, PR #203 r11 item 2, r12).
    const keyed = withWiredBlockers(definition, params, ports);
    const billing = keyBilling(definition, keyed, costContext?.apiKeys ?? {});
    if (billing) {
      if (billing === 'mayCost') mayCost.push({ name, account: keyBillingAccount(definition, keyed, costContext?.apiKeys ?? {}) ?? '' });
      continue;
    }
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
      because(name, { kind: 'noPrice' });
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
    // No key for any of the node's providers (selectRoute's `unset`): a node
    // whose price depends on the provider then reads as a missing key, never
    // as "no listed price" (PR #198 round 5 live check: a Seedream scene,
    // priced on BytePlus only, fell back to fal.ai with no key at all).
    let keyUnset = false;
    if (hasRoutes(definition)) {
      const missing = routeUnavailable(definition, routed, costContext.apiKeys);
      if (missing) {
        cost.unpriced.push(name);
        ids.unpriced.push(node.id);
        cost.unavailable = { ...cost.unavailable, [name]: missing.message };
        // A route with no key names it as the route line does (keyPhrase);
        // a block (a setting, a retired model, an unknown provider) can't run.
        because(name, missing.block ? { kind: 'cantRun' } : { kind: 'missingKey', key: keyPhrase(missing.missing) });
        ids.unavailable = { ...ids.unavailable, [node.id]: missing.message };
        continue;
      }
      priceKey = routePriceKey(definition, selectRoute(definition, routed, costContext.apiKeys));
    } else {
      const route = selectRoute(definition, routed, costContext.apiKeys);
      priceKey = route.provider;
      keyUnset = route.kind === 'unset';
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
        because(name, { kind: size === null ? 'sizeUnreadable' : 'awaitingInput' });
      } else if (keyUnset && envKeyNames(definition).length) {
        because(name, { kind: 'missingKey', key: keyPhrase(envKeyNames(definition)) });
      } else {
        because(name, { kind: 'noPrice' });
      }
      continue;
    }
    const [fewest, most] = multipliers.get(node.id) ?? [1, 1];
    // A cinema scene's base model runs once per shot.
    const runs: [number, number] = [fewest * calls, most * calls];
    const line = { name, low: estimate.low * runs[0], high: estimate.high * runs[1], runs, nodeId: node.id };
    if (estimate.high !== 0) zeroRows = false;
    cost.lines.push(line);
    cost.low += line.low;
    cost.high += line.high;
    if (estimate.plus && !cost.plus.includes(estimate.plus)) cost.plus.push(estimate.plus);
    if (estimate.plus) because(name, { kind: 'leftOut', plus: estimate.plus });
  }
  if (pricing && cost.lines.length > 0 && zeroRows) cost.sourcedZero = true;
  const summary: RunScopeSummary = pricing ? { total: included.length, paid, cost } : { total: included.length, paid };
  if (mayCost.length) summary.mayCost = mayCost;
  if (costContext) summary.routes = routes;
  if (gated.length) summary.gated = gated;
  if (pendingSkipped) summary.pendingSkipped = pendingSkipped;
  if (pendingIncluded) summary.pendingIncluded = pendingIncluded;
  return summary;
}

/** Whether a run's chip is open: part of it has no known price, or a
 * priced node's estimate leaves a cost out, so the real total can be higher. */
function costOpen(cost: RunCost): boolean {
  return cost.unpriced.length > 0 || cost.plus.length > 0;
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

/** The Run chip: "~$0.04", "$0.04–0.43", "$0.04 + unpriced" when part of
 * the run has no known price (GM, PR #198 r6), "<$0.01" for a non-zero
 * amount under a cent (r1: "$0" only ever means free), "N paid" when none
 * of it has a list price. Null when nothing is paid or may cost.
 * GM, PR #203 r11 item 2: a run that may bill the person's own account
 * (summary.mayCost) is counted apart, "1 may cost" alone and "2 paid · 1 may
 * cost" beside paid nodes with no list price; beside a priced part the chip
 * keeps its amount and the tooltip says it (runChipTitle). */
export function runChipLabel({ paid, cost, mayCost }: RunScopeSummary): string | null {
  const may = mayCost?.length ? `${mayCost.length} may cost` : null;
  if (paid.length === 0) return may;
  if (!cost || cost.lines.length === 0) return may ? `${paid.length} paid · ${may}` : `${paid.length} paid`;
  // GM, PR #203 r11 item 4, by source: a sourced $0 (every priced row is
  // 0) is exact, "$0"; an estimate that rounds to zero is "~$0".
  const amount = !costOpen(cost) && cost.sourcedZero ? '$0' : formatChipEstimate(cost.low, cost.high, costOpen(cost));
  // GM, PR #203 r14 item 4: beside a priced part, "~$0.13 + 1 may cost".
  return may ? `${amount} + ${may}` : amount;
}

/** "“Hero still” calls a paid provider." / "“A” and “B” call paid
 * providers.": the first sentence of a mixed cost tooltip (GM, PR #203 r14
 * item 3), the names by errorCopy nodeNameList (a count from 4). */
export function paidSentence(names: string[]): string | null {
  if (names.length === 0) return null;
  return `${nodeNameList(names)} ${names.length === 1 ? 'calls a paid provider' : 'call paid providers'}.`;
}

/** A priced part as a sentence, never with "~" inside it (GM, PR #203 r14
 * item 3, r16 item 3): pricing chipTitle's "Estimated cost $0.13.",
 * "Estimated cost under $0.01.", "Up to $Y." and "Between $X and $Y.", a
 * sourced $0's "This costs nothing to run.", and an open estimate's priced
 * part ("The priced part of this run costs up to $0.43.", or '' for none). */
export function estimateSentence(low: number, high: number, open: boolean, sourcedZero = false): string {
  if (!open && sourcedZero) return SOURCED_ZERO_TITLE;
  return chipTitle(chipEstimate(low, high, open));
}

/** What a cost tooltip says, from either chip's own parts. */
export interface CostTitleParts {
  /** Every paid node's name, with a list price or not (GM, PR #203 r17 item 3). */
  paid: string[];
  /** The priced part, or null when no paid node has a price (or the price
   * table hasn't loaded). */
  estimate: { low: number; high: number; open: boolean; sourcedZero?: boolean } | null;
  /** Why each unpriced part is unpriced, as the Run chip records it. */
  reasons: NonNullable<RunCost['reasons']>;
  mayCost?: RunScopeSummary['mayCost'];
}

/**
 * Every cost tooltip: the toolbar's Run chip (runChipTitle) and the
 * proposal bar's Accept chip (canvasProposals acceptChipTitle), one
 * formatter (GM, PR #203 r16 item 3; r17 items 3 and 4). Line 1 names the
 * paid nodes, priced or not, then the priced part as a sentence: "“A”
 * calls a paid provider. Estimated cost $0.13." No heading. Each reason for
 * an unpriced part goes on its own line under line 1 ("“B” has no listed
 * price.": GM, PR #198 r9 bug 2), and the may-cost sentence comes last
 * ("Idol can use your Hugging Face credits."); with no reasons it is all one
 * line. Undefined when nothing is paid or may cost.
 */
export function costTitle({ paid, estimate, reasons, mayCost }: CostTitleParts): string | undefined {
  const may = mayCostSentence(mayCost);
  const priced = paid.length > 0 && estimate
    ? estimateSentence(estimate.low, estimate.high, estimate.open, estimate.sourcedZero === true) : '';
  const lead = [paidSentence(paid), priced].filter(Boolean).join(' ');
  const lines = paid.length > 0 ? reasonSentences(reasons) : [];
  if (lines.length === 0) return [lead, may].filter(Boolean).join(' ') || undefined;
  return [lead, ...lines, may].filter(Boolean).join('\n') || undefined;
}

/** The sourced "$0" chip's tooltip (GM, PR #203 r11 item 4). */
export const SOURCED_ZERO_TITLE = 'This costs nothing to run.';

/** "Idol can use your Hugging Face credits.": the may-cost sentence, last in
 * the chip's tooltip (GM, PR #203 r11 item 2), one per account. */
export function mayCostSentence(mayCost: RunScopeSummary['mayCost']): string | null {
  if (!mayCost?.length) return null;
  const byAccount = new Map<string, string[]>();
  for (const { name, account } of mayCost) {
    const names = byAccount.get(account) ?? [];
    if (!names.includes(name)) names.push(name);
    byAccount.set(account, names);
  }
  return [...byAccount].map(([account, names]) => {
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${who} can use your ${account} credits.`;
  }).join(' ');
}

/** One sentence per reason (GM r7 item 3): the nodes sharing it named
 * together (errorCopy nodeNameList), ordered as the nodes appear on the
 * canvas: left to right, the way a graph reads, then top to bottom (a node
 * with no position keeps its place after those that have one). */
function reasonSentences(reasons: NonNullable<RunCost['reasons']>): string[] {
  const groups = new Map<string, { line: (names: string, several: boolean) => string; names: string[] }>();
  const placed = reasons.map((entry, index) => ({ ...entry, index }));
  placed.sort((a, b) => (a.at && b.at ? a.at.x - b.at.x || a.at.y - b.at.y || a.index - b.index
    : a.at ? -1 : b.at ? 1 : a.index - b.index));
  for (const { name, reason } of placed) {
    let id: string;
    let line: (names: string, several: boolean) => string;
    switch (reason.kind) {
      case 'missingKey': {
        const key = reason.key ?? MISSING_KEY_UNNAMED;
        id = `missingKey:${key}`;
        line = (names, several) => MISSING_KEY(names, several, key);
        break;
      }
      case 'leftOut':
        line = Object.hasOwn(LEFT_OUT, reason.plus) ? LEFT_OUT[reason.plus] : LEFT_OUT_OTHER(reason.plus);
        // Nodes leaving out the same cost are one sentence (GM r8).
        id = `leftOut:${reason.plus}`;
        break;
      case 'noPrice': id = 'noPrice'; line = NO_LISTED_PRICE; break;
      case 'cantRun': id = 'cantRun'; line = ROUTE_CANT_RUN; break;
      case 'awaitingInput': id = 'awaitingInput'; line = AWAITING_INPUT; break;
      case 'sizeUnreadable': id = 'sizeUnreadable'; line = SIZE_UNREADABLE; break;
    }
    const group = groups.get(id) ?? { line, names: [] };
    group.names.push(name);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ line, names }) => line(nodeNameList(names), namesSeveral(names)));
}

/** The Run chip's tooltip, from the same parts as its label (costTitle,
 * the one cost-tooltip formatter): whenever the chip shows, its paid nodes
 * first, priced or not (GM, PR #203 r17 item 3), then the priced part, a
 * sentence per reason, and the may-cost sentence last. */
export function runChipTitle(summary: RunScopeSummary): string | undefined {
  const { paid, cost } = summary;
  const open = cost ? costOpen(cost) : false;
  // A summary with no reasons recorded (one built before them) names its
  // unpriced nodes as having no listed price.
  const reasons = !cost || !open ? [] : cost.reasons?.length ? cost.reasons
    : cost.unpriced.map((name) => ({ name, reason: { kind: 'noPrice' as const } }));
  const estimate = cost && cost.lines.length > 0
    ? { low: cost.low, high: cost.high, open, sourcedZero: cost.sourcedZero === true } : null;
  return costTitle({ paid, estimate, reasons, mayCost: summary.mayCost });
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
export function describeRunScope(summary: RunScopeSummary): string {
  const { total, paid, cost, gated, pendingIncluded } = summary;
  const nodes = `${total} ${total === 1 ? 'node' : 'nodes'}`;
  // GM - Design, 2026-10-25: the run counts the placeholders it runs and says so.
  const included = pendingIncludedLine(pendingIncluded)?.replace(/\.$/, '');
  const may = mayCostSentence(summary.mayCost)?.replace(/\.$/, '');
  if (paid.length === 0) return [`Runs ${nodes} · no paid providers`, may, included].filter(Boolean).join('. ');
  const parts = [`Runs ${nodes} · ${paid.length} ${paid.length === 1 ? 'calls a paid provider' : 'call paid providers'}: ${nameList(paid)}`];
  if (cost && cost.lines.length > 0) {
    const total = formatUsdRange(cost.low, cost.high);
    const detail = cost.lines.map((line) => `${line.name} ${formatUsdRange(line.low, line.high)}${runsLabel(line.runs)}`);
    parts.push(`Estimated ${total} at list prices (${detail.join('; ')})`);
  }
  // The may-cost sentence after the estimate, as the tooltip orders them
  // (GM, PR #203 r14 item 3; review 7, NIT-4).
  if (may) parts.push(may);
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
