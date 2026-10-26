import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { isLocalRun, modelChoice } from './nodeKeys';
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
 * Copy is GM - Design's, 2026-10-25 and 26 (round 4 for the rows' prices
 * and the button, round 5 for the total when a row has no dollar amount,
 * round 6 for the footnotes, the other paid nodes' rows, Cinema's Generate and
 * the heading once no placeholder is left), verbatim.
 * The backend refuses the run unless it carries these exact paid
 * placeholders and a total no lower than its own estimate (main.execute_node
 * and main.generate_cinema_shot, `confirmedPlaceholders` and
 * `confirmedCost`), so a missed dialog, a stale tab or another client can't
 * skip it. Its refusal carries that estimate (placeholderRefusalOf), and the
 * canvas asks again with it (withRunEstimate).
 */

export interface PlaceholderRunRow {
  nodeId: string;
  /** The node's name, quoted: “Hero still” (a Cinema shot's: “Shot 1”). */
  name: string;
  /** The model it runs, unquoted, in the provider's spelling; null when it is the name. */
  model: string | null;
  /** "$0.04", "$0.0047–0.43", "price not listed", "price depends on its
   * input" or "on your Krea plan" (GM, rounds 4 and 6). */
  price: string;
  /** The agent whose placeholder it is, or was until it finished it while
   * the dialog was open (review 5, H1); null for a paid node of the run that
   * is no placeholder, shown muted with no dot (GM - Design, round 6, item 3:
   * "every dollar in the total needs a row"). */
  agent: PendingAgent | null;
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
  /** The gates and what's not included, then, under a total, the rows that
   * have no list price (GM, round 6, item 1). */
  notes: string[];
  /** "Run for $0.12" (a fixed total), "Run for up to $0.86" (a range), or
   * "Run" when a row's price isn't listed or no price table loaded (GM, round
   * 4); "Generate…" from Cinema (GM, round 6, item 3). */
  runLabel: string;
  /** The paid placeholders the person confirms; the run sends them. */
  confirmIds: string[];
  /** The run's upper total of its listed prices (USD), rounded to 6 places as
   * Nebula rounds its own (review 4, L1), or null with no price table: the
   * run sends it, and the backend refuses a run its own estimate puts higher. */
  confirmCost: number | null;
}

export interface PlaceholderRunOptions {
  /** The button's verb: "Generate" from Cinema's Generate shot, Generate N
   * and Generate all, matching what the person clicked (GM, round 6, item 3). */
  verb?: 'Run' | 'Generate';
  /** A node's name for this run, unquoted: a Cinema shot's scene is “Shot 1”. */
  names?: Readonly<Record<string, string>>;
  /** Every placeholder an earlier dialog of this same run showed, with its
   * agent. Once the dialog has shown it stays the authority (review 5, H1):
   * when their agents finish them while it is open there is still a dialog,
   * "Run with Codex's changes?", never none. */
  shown?: ReadonlyMap<string, PendingAgent>;
}

/** A row's price words (GM - Design, rounds 4 and 6, verbatim). */
export const PRICE_NOT_LISTED = 'price not listed';
export const PRICE_DEPENDS_ON_INPUT = 'price depends on its input';
export const PRICE_ON_KREA_PLAN = 'on your Krea plan';

/** The model a node runs, as its card's model picker labels it (backend
 * main._run_model_name): the chosen model option's label, else the node type.
 * A node that runs another model's handler (a Cinema scene) names that model. */
function modelName(node: Node<NodeData>): string {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition) return node.data?.definitionId ?? node.id;
  const params = (node.data?.params ?? {}) as Record<string, unknown>;
  const via = definition.providerVia?.kind === 'model' ? modelChoice(definition, params) : null;
  if (via && NODE_DEFINITIONS[via]) return NODE_DEFINITIONS[via].displayName;
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

/** A row's price (GM - Design, rounds 4 and 6, verbatim): the list price,
 * "on your Krea plan", "price depends on its input" (its size isn't known
 * yet), or "price not listed". `missing`: no dollar amount covers it, which
 * makes the button plain "Run". Read by node id where the summary has them. */
function rowPrice(nodeId: string, summary: RunScopeSummary, name: string): { text: string; missing: boolean } {
  const cost = summary.cost;
  const line = cost?.lines.find((candidate) => candidate.nodeId === nodeId);
  if (line) return { text: formatUsdRange(line.low, line.high), missing: false };
  const has = (key: 'plan' | 'awaitingInput') => (cost?.ids ? cost.ids[key].includes(nodeId) : cost?.[key].includes(name));
  if (has('plan')) return { text: PRICE_ON_KREA_PLAN, missing: false };
  if (has('awaitingInput')) return { text: PRICE_DEPENDS_ON_INPUT, missing: true };
  return { text: PRICE_NOT_LISTED, missing: true };
}

/** Whether the amount is a range ("up to"), as the costly-run confirm shows it. */
function isRange(cost: RunCost): boolean {
  return formatUsd(cost.low) !== formatUsd(cost.high);
}

/** "Run for $0.12" when the total is fixed, "Run for up to $0.86" when it is a
 * range (matching "could cost up to"), "Run" when a row has no listed price,
 * nothing is priced (only Krea-plan rows) or there is no total (GM - Design,
 * rounds 4 and 5, verbatim); "Generate" in place of "Run" from Cinema (round 6). */
function runLabelFor(cost: RunScopeSummary['cost'], anyMissing: boolean, verb: string): string {
  if (!cost || anyMissing || cost.lines.length === 0) return verb;
  return isRange(cost) ? `${verb} for up to ${formatUsd(cost.high)}` : `${verb} for ${formatUsd(cost.high)}`;
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

/** Under a total, the rows with no list price (GM - Design, round 6, item 1,
 * verbatim): one or two by name, quoted, then a count. */
function unlistedFootnote(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} has no list price, so the run may cost more.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} have no list price, so the run may cost more.`;
  return `${names.length} nodes have no list price, so the run may cost more.`;
}

/** USD at 6 places: the arithmetic Nebula's check uses (main._run_estimate). */
function roundUsd(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

/** The distinct agent names, in order. */
function agentNames(agents: Iterable<PendingAgent>): string[] {
  const names: string[] = [];
  for (const agent of agents) if (!names.includes(agent.name)) names.push(agent.name);
  return names;
}

/**
 * The dialog before the person's direct run of `nodeId`, or null when no
 * placeholder in that run calls a paid model (free ones just run) and no
 * dialog has shown for it yet (`options.shown`). `summary` is the run's own
 * (summarizeRunScope, node scope, direct): its total counts the placeholders
 * and everything else, and every paid node in the run gets a row, so every
 * dollar in the total has one (GM, round 6).
 */
export function placeholderRunConfirm(
  nodes: Node<NodeData>[],
  edges: Edge[],
  nodeId: string,
  summary: RunScopeSummary,
  options: PlaceholderRunOptions = {},
): PlaceholderRunConfirm | null {
  const scope = nodeScope(nodes, edges, nodeId);
  const placeholders = scope.flatMap((node) => {
    const flag = cleanPending(node.data?.pending);
    return flag ? [{ node, agent: flag.agent }] : [];
  });
  const paid = placeholders.filter(({ node }) => isPaid(node));
  // Placeholders a dialog of this run showed that their agents have finished since (H1).
  const finished = scope.flatMap((node) => {
    const agent = options.shown?.get(node.id);
    return agent && !cleanPending(node.data?.pending) ? [{ node, agent }] : [];
  });
  if (paid.length === 0 && !(options.shown && options.shown.size > 0)) return null;
  const agentOf = new Map<string, PendingAgent>([...finished, ...placeholders].map(({ node, agent }) => [node.id, agent]));
  let anyMissing = false;
  const unlisted: string[] = [];
  const row = (node: Node<NodeData>): PlaceholderRunRow => {
    const definition = NODE_DEFINITIONS[node.data?.definitionId];
    const label = options.names?.[node.id] || node.data?.label || definition?.displayName || node.id;
    const model = modelName(node);
    const price = rowPrice(node.id, summary, node.data?.label || definition?.displayName || node.id);
    if (price.missing) anyMissing = true;
    if (price.text === PRICE_NOT_LISTED) unlisted.push(`“${label}”`);
    return { nodeId: node.id, name: `“${label}”`, model: model === label ? null : model, price: price.text,
      agent: agentOf.get(node.id) ?? null };
  };
  const paidNodes = scope.filter(isPaid);
  // The agents' rows first (with their dots), then the run's other paid nodes, muted.
  const rows = [...paidNodes.filter((node) => agentOf.has(node.id)), ...paidNodes.filter((node) => !agentOf.has(node.id))]
    .map(row);
  const cost = summary.cost;
  const verb = options.verb ?? 'Run';
  const count = placeholders.length;
  const free = count - paid.length;
  let heading: string;
  let intro: string;
  if (count > 0) {
    const agents = agentNames(placeholders.map(({ agent }) => agent));
    const one = agents.length === 1 ? agents[0] : null;
    heading = `Run ${count} ${count === 1 ? 'node' : 'nodes'} ${one ? `${one} is` : 'agents are'} still setting up?`;
    intro = one
      ? `${one} hasn't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`
      : `Agents haven't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`;
  } else {
    // No placeholder left: their agents finished them while the dialog was
    // open (GM - Design, round 6, copy answer to review 5 H1, verbatim).
    const agents = agentNames(finished.length ? finished.map(({ agent }) => agent) : options.shown?.values() ?? []);
    const one = agents.length === 1 ? agents[0] : null;
    heading = one ? `Run with ${one}'s changes?` : "Run with the agents' changes?";
    intro = one ? `${one} finished setting up these nodes.` : 'The agents finished setting up these nodes.';
  }
  const totalLine = totalLineFor(cost, anyMissing);
  const footnote = totalLine ? unlistedFootnote(unlisted) : null;
  return {
    heading,
    intro,
    rows,
    freeLine: free > 0 ? `Plus ${free} free ${free === 1 ? 'node' : 'nodes'}.` : null,
    totalLine,
    notes: [...runCostNotes(summary, { prices: false }), ...(footnote ? [footnote] : [])],
    runLabel: runLabelFor(cost, anyMissing, verb),
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
 * placeholders it needs confirmed (none when no placeholder is left but the
 * run costs more than confirmed), whose they are, and its estimate. */
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
  // Empty when no placeholder is left but the run costs more than the
  // person confirmed (review 5, H1): the canvas asks again all the same.
  const placeholders = idList(body.placeholders);
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
    ids: { unpriced: estimate.unpriced, plan: estimate.plan, awaitingInput: estimate.awaitingInput },
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
