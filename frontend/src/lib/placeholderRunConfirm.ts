import type { Edge, Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { allParamDefinitions, canvasTitle, hasRoutes, isDefaultTitle, keyBilling, nameOnRoute, nodeTitle, providerLabel, routeById, routeDependsOnKeys,
  selectRoute, withWiredBlockers } from './directRoute';
import { isLocalRun, modelChoice } from './nodeKeys';
import { cleanPending, type PendingAgent } from './pendingNodes';
import { formatUsdRange } from './pricing';
import { runCostNotes, runNodeName, type RunCost, type RunScopeSummary } from './runScope';
import { nodeNameList } from './errorCopy';

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
 * the heading once no placeholder is left, round 7 for "this node", the
 * input-priced footnotes, placeholders that left the run and the amounts in
 * cents, and the ruling on review 8 L-b for a replay of a placeholder its
 * agent changed after the run was saved; round 10 for its names and Krea's
 * sub-model settings in rows; round 11 for three names before a count, "the
 * agents", the grain model and "Model: default"; round 12 for "Model: not
 * chosen", Meshy's mesh type and a row that wraps only between its
 * segments), verbatim.
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
  /** The model it runs, always (review 9, L-3: a node named after its model
   * shows no model, but a switch must still be a changed row). */
  modelKey: string;
  /** A Krea node's sub-model setting, as its card names it: "Variant: Large",
   * "Engine: …", "Model: …", "Version: …" (GM - Design, round 10, item 2:
   * named even when it is the default, so a switch re-asks); "Grain model: …"
   * with Grain on (round 11, item 4), "Mesh type: …" on a Meshy node and
   * "Model: not chosen" for a required one with nothing chosen (round 12,
   * item 2 and addendum b); else null. Several are joined with " · ". */
  setting: string | null;
  /** "$0.04", "$0.0047–$0.43", "price not listed", "price depends on its
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
  /** Under the intro on a replay that still has placeholders being set up,
   * when its agents changed some after the run was saved (GM - Design on
   * review 8 L-b; round 10 names them): "Codex changed “Grade” after the
   * run was saved. The replay uses the saved settings."; else null (with none left being set
   * up, that sentence is the intro, under "Replay the saved version?"). */
  savedLine: string | null;
  /** Under the intro when placeholders the dialog showed left the run
   * (deleted or disconnected) while others finished (GM - Design, round 7,
   * review 6 L-b) or are still being set up (round 8, item 2): "1 node Codex
   * was setting up is no longer in this run."; else null. */
  leftLine: string | null;
  rows: PlaceholderRunRow[];
  /** The run's node ids in canvas order: GM's moved line names them so
   * (fix round 1 of PR #200). Absent on a model built before it. */
  canvasOrder?: string[];
  /** "Plus 1 free node." / "Plus 2 free nodes.", or null. */
  freeLine: string | null;
  /** The costly-run confirm's own line; "The listed prices total $0.43." when
   * a row's price isn't listed; null when no amount covers any row (GM, round 5).
   * Its amount is in cents, rounded up (round 7: formatConfirmUsd). */
  totalLine: string | null;
  /** The gates and what's not included, then, under a total, the rows that
   * have no list price (GM, round 6, item 1). */
  notes: string[];
  /** Of `notes`, the gates and what's not included ("Not included: input
   * images."): a run that got cheaper after the click goes ahead without
   * asking again only if it adds none of these unseen (review 6, L-a). */
  costNotes: string[];
  /** "Run for $0.12" (a fixed total), "Run for up to $0.86" (a range), or
   * "Run" when a row's price isn't listed or no price table loaded (GM, round
   * 4); "Generate…" from Cinema (GM, round 6, item 3). The amount is in
   * cents, rounded up, never whole dollars (GM, round 7: formatConfirmUsd). */
  runLabel: string;
  /** The paid placeholders the person confirms; the run sends them. */
  confirmIds: string[];
  /** The amount the person is shown and confirms: the run's upper total of
   * its listed prices (USD) rounded up to the cent, exactly as the button and
   * the total line show it (review 6, L-e; GM - Design: "Send that shown
   * amount as confirmedCost"), or null with no price table. The run sends it,
   * and the backend refuses a run its own estimate puts any higher. */
  confirmCost: number | null;
}

export interface PlaceholderRunOptions {
  /** The button's verb: "Generate" from Cinema's Generate shot, Generate N
   * and Generate all, matching what the person clicked (GM, round 6, item 3). */
  verb?: 'Run' | 'Generate';
  /** A node's name for this run, unquoted: a Cinema shot's scene is “Shot 1”. */
  names?: Readonly<Record<string, string>>;
  /** Every placeholder of this run a dialog of it showed, with its agent
   * (runPlaceholders: only this run's, review 6 L-b). Once the dialog has
   * shown it stays the authority (review 5, H1): when their agents finish
   * them while it is open, or they leave the run, there is still a dialog
   * ("Run with Codex's changes?", "Run without the node Codex was setting
   * up?"), never none. One no longer in the run is never "finished". */
  shown?: ReadonlyMap<string, PendingAgent>;
  /** Nodes of this run that are no longer what their agent was setting up:
   * a replay's saved copy of a placeholder since deleted from the canvas or
   * turned into another type (review 7, L1). The copy still runs, as a paid
   * node of the run with a muted row; the agent's placeholder counts as one
   * that left the run, never as "finished". */
  gone?: ReadonlySet<string>;
  /** A replay's nodes whose live settings differ from the saved ones it
   * sends (snapshotCanvas `changed`). One that is, or was, an agent's
   * placeholder is a version its agent changed after the run was saved: the
   * replay uses the saved settings, and says so (GM - Design on review 8
   * L-b: "Replay the saved version?"). Its saved version is a muted row. */
  changed?: ReadonlySet<string>;
  /** The keys couldn't be read (a 409 re-ask's key read failed or timed out:
   * graphStore rereadRunKeys returned false), so the route each row would
   * take is unknown. A row whose route depends on keys drops only the route,
   * never naming a possibly old one (review 18, L-D; GM - Design, round 19,
   * verbatim: "“Grok Imagine 2.0” · $0.06", "“Alt still” · Grok Imagine 2.0
   * · $0.06"). Its price stays Nebula's. */
  routeUnknown?: boolean;
  /** The keys this tab read. A key-billing node (directRoute keyBilling, the
   * class every cost surface reads; GM, PR #203 r15 item 2) is paid by them:
   * "free" (Idol with no token) needs no confirm of its own, "may cost" (with
   * one) still asks, its row's price "may cost". Unset: counted as paid. */
  apiKeys?: Readonly<Record<string, string>>;
}

/** A row's price words (GM - Design, rounds 4 and 6, verbatim). */
export const PRICE_NOT_LISTED = 'price not listed';
export const PRICE_DEPENDS_ON_INPUT = 'price depends on its input';
export const PRICE_ON_KREA_PLAN = 'on your Krea plan';
/** A may-cost row's price (GM, PR #203 r15 item 2): no dollar amount covers it. */
export const PRICE_MAY_COST = 'may cost';

/** The params that pick the model a node runs (backend main._MODEL_SELECT_KEYS
 * and _MODEL_TEXT_KEYS): a select labelled Model, or a free-text model id. */
const MODEL_SELECT_KEYS = new Set(['model', 'model_id', 'ai_model']);
const MODEL_TEXT_KEYS = new Set(['model', 'model_id', 'endpoint_id']);
/** Nodes whose free-text `model` is no model they run (backend main._NOT_A_MODEL):
 * Krea Style Search's is a search filter (review 9, nit c). */
const NOT_A_MODEL: Readonly<Record<string, ReadonlySet<string>>> = { 'krea-style-search': new Set(['model']) };

/** A Krea node's sub-model settings (GM - Design, round 10, item 2): Krea 2's
 * Variant, Magnific's Engine, Topaz's Model (and the video upscaler's
 * enhancement and frame-interpolation models), a node app's Version. They
 * are settings of the model the node type names, so its row names the type
 * as the model and each setting by the label its card uses. */
const KREA_SETTING_KEYS = ['variant', 'engine', 'model', 'enhancement_model', 'frame_interpolation_model', 'grain_model',
  'node_app_version_id'];
/** GM's word for the node app's version (its card's field is "Node app version ID"). */
const KREA_SETTING_LABELS: Readonly<Record<string, string>> = { node_app_version_id: 'Version' };
/** Settings that pick a model only while a switch is on (GM - Design, round 11, item 4: "Name 'Grain
 * model' when one is chosen (it picks a model that runs)"): Topaz Bloom 2's and Wonder 3.5's grain
 * model runs only with Grain on. Magnific Precise's Flavor is a style setting on the same engine,
 * so it is never one of these settings. */
const KREA_SETTING_WHEN: Readonly<Record<string, string>> = { grain_model: 'grain' };
/** GM - Design, round 12 addendum (b): a required setting with nothing chosen (Topaz Standard's
 * Model, a node app's Version) reads "Model: not chosen", and the row keeps its other segments:
 * it shows why the run will be refused. (Round 11's "Model: default" assumed Krea picks one; Krea's
 * schema requires it, and the gateway refuses the run: review 11, L-1.) An optional one with
 * nothing chosen (none today) is left to the provider: "default". */
export const SETTING_NOT_CHOSEN = 'not chosen';
const SETTING_DEFAULT = 'default';
/** Settings of other nodes that pick the model that runs, named like Krea's (GM - Design, round 12,
 * item 2: Meshy's mesh type, "Mesh type: Smart Topology (Meshy T2)"; a switch re-asks). */
const OTHER_SETTINGS: Readonly<Record<string, ReadonlyArray<{ key: string; label: string }>>> = {
  'meshy-text-to-3d': [{ key: 'model_type', label: 'Mesh type' }],
  'meshy-image-to-3d': [{ key: 'model_type', label: 'Mesh type' }],
};

type ParamSpec = NonNullable<(typeof NODE_DEFINITIONS)[string]['params']>[number];

function isKrea(definition: (typeof NODE_DEFINITIONS)[string]): boolean {
  return definition.apiProvider === 'krea';
}

/** Whether `spec` is one of a Krea node's sub-model settings: a select, or the node app's version id. */
function isKreaSetting(definition: (typeof NODE_DEFINITIONS)[string], spec: ParamSpec): boolean {
  if (!isKrea(definition) || !KREA_SETTING_KEYS.includes(spec.key)) return false;
  return spec.type === 'enum' || spec.key === 'node_app_version_id';
}

/** At most 80 characters, counted in code points as Python counts them
 * (backend main._run_model_name `[:80]`; review 9, nit d), never half a pair. */
function cut80(text: string): string {
  const points = Array.from(text);
  return points.length > 80 ? points.slice(0, 80).join('') : text;
}

function specsOf(definition: (typeof NODE_DEFINITIONS)[string]): ParamSpec[] {
  return [...(definition.params ?? []), ...(definition.sharedParams ?? [])];
}

/** The model a node runs, as Nebula shows it (backend main._run_model_name):
 * the chosen option of its model picker, by its label; the model id a
 * free-text model param names, as the node card shows it ("openai/gpt-4o-mini"
 * on an OpenRouter node: review 8, L-a, so a switch is a changed row); else
 * the node type. A node that runs another model's handler (a Cinema scene)
 * names that model. A Krea node's sub-model setting is no model of its own
 * (kreaSetting). */
function modelName(node: Node<NodeData>): string {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition) return node.data?.definitionId ?? node.id;
  const params = (node.data?.params ?? {}) as Record<string, unknown>;
  const via = definition.providerVia?.kind === 'model' ? modelChoice(definition, params) : null;
  if (via && NODE_DEFINITIONS[via]) return NODE_DEFINITIONS[via].displayName;
  const specs = specsOf(definition).filter((spec) => !isKreaSetting(definition, spec)
    && !NOT_A_MODEL[definition.id]?.has(spec.key));
  for (const spec of specs) {
    if (!MODEL_SELECT_KEYS.has(spec.key) || spec.type !== 'enum') continue;
    const value = params[spec.key] ?? spec.default;
    const option = spec.options?.find((candidate) => typeof candidate === 'object' && candidate.value === value);
    if (option && typeof option === 'object' && option.label) return String(option.label);
  }
  for (const spec of specs) {
    if (!MODEL_TEXT_KEYS.has(spec.key) || spec.type !== 'string') continue;
    const value = params[spec.key] ?? spec.default;
    if (typeof value === 'string' && value.trim()) return cut80(value.trim());
  }
  return definition.displayName;
}

/** The model a node runs, named on the route its run takes (GM - Design,
 * round 15, item 3): a node type's own name names that route's provider. */
function modelOnRoute(node: Node<NodeData>, provider: string | null, routeUnknown = false): string {
  const model = modelName(node);
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition || model !== definition.displayName) return model;
  // Review 18, L-D: with the route unknown, the model without any route.
  if (routeUnknown && routeDependsOnKeys(definition)) return canvasTitle(definition);
  return nameOnRoute(definition, provider);
}

function unset(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/** A setting's words in a row: "Variant: Large" (the chosen option's label),
 * "Version: v_9" (a typed id), "Model: not chosen" (required, nothing
 * chosen), "Model: default" (optional, nothing chosen); null otherwise. */
function settingWords(spec: ParamSpec, label: string, value: unknown): string | null {
  if (spec.type === 'enum') {
    const option = spec.options?.find((candidate) => typeof candidate === 'object' && candidate.value === value);
    if (option && typeof option === 'object' && option.label) return `${label}: ${option.label}`;
  } else if (typeof value === 'string' && value.trim()) {
    return `${label}: ${cut80(value.trim())}`;
  }
  if (!unset(value)) return null;
  return `${label}: ${spec.required ? SETTING_NOT_CHOSEN : SETTING_DEFAULT}`;
}

/** The settings that pick which model runs, as the row names them, "Variant:
 * Large" (GM - Design, round 10, item 2: the setting's label and the chosen
 * option's label, as the node card shows them, even when it is the default;
 * round 12, item 2: Meshy's "Mesh type"), joined with " · "; null for any
 * other node, or none named. */
function kreaSetting(node: Node<NodeData>): string | null {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition) return null;
  const params = (node.data?.params ?? {}) as Record<string, unknown>;
  const named: string[] = [];
  const other = OTHER_SETTINGS[definition.id];
  if (other) {
    const specs = allParamDefinitions(definition);
    for (const { key, label } of other) {
      const spec = specs.find((candidate) => candidate.key === key);
      const words = spec ? settingWords(spec, label, params[key] ?? spec.default) : null;
      if (words) named.push(words);
    }
  }
  if (isKrea(definition)) {
    const specs = specsOf(definition);
    for (const spec of specs) {
      if (!isKreaSetting(definition, spec)) continue;
      const when = KREA_SETTING_WHEN[spec.key];
      if (when && (params[when] ?? specs.find((candidate) => candidate.key === when)?.default) !== true) continue;
      const words = settingWords(spec, KREA_SETTING_LABELS[spec.key] ?? spec.label, params[spec.key] ?? spec.default);
      if (words) named.push(words);
    }
  }
  return named.length > 0 ? named.join(' · ') : null;
}

/**
 * Review 12, L-7, and GM - Design's round-13 rule: the fields a Krea node
 * can't run without, in the card's order (backend services/model_choice.py
 * required_fields): required, no default, not hidden, and no input port of
 * the same id (a wire could fill those). The canvas fills none in (a new
 * node keeps nothing, the field reads "Choose…"), and the gateway refuses a
 * request without one. Each is [key, the word the line uses]: the card's
 * label, lowercased; a node app's Version as GM named it.
 */
function requiredFields(definition: (typeof NODE_DEFINITIONS)[string]): string[][] {
  if (!isKrea(definition)) return [];
  const ports = new Set((definition.inputPorts ?? []).map((port) => port.id));
  const seen = new Set<string>();
  const fields: string[][] = [];
  for (const spec of specsOf(definition)) {
    if (seen.has(spec.key)) continue;
    seen.add(spec.key);
    if (!spec.required || !unset(spec.default) || spec.hidden || ports.has(spec.key)) continue;
    fields.push([spec.key, (KREA_SETTING_LABELS[spec.key] ?? spec.label).toLowerCase()]);
  }
  return fields;
}

/** Fields the person picks rather than types, besides every enum: a node
 * app's Version (backend model_choice._PICKED). */
const PICKED_FIELDS = new Set(['node_app_version_id']);

/** GM - Design, round 14, item 1: "Choose" for a picker (an enum, a node
 * app's version), "Set" for a value the person types (width, height, a
 * name). backend services/model_choice.py field_verb is the same rule. */
function fieldVerb(definition: (typeof NODE_DEFINITIONS)[string], key: string): 'Choose' | 'Set' {
  const spec = specsOf(definition).find((candidate) => candidate.key === key) as (ParamSpec & { type?: string; options?: unknown[] }) | undefined;
  return PICKED_FIELDS.has(key) || spec?.type === 'enum' || (spec?.options?.length ?? 0) > 0 ? 'Choose' : 'Set';
}

/** What a run of the node can be refused for: the keys set (the settings
 * cache), what is wired into it, and whether the Krea plan is signed in. */
export interface RouteContext {
  apiKeys: Readonly<Record<string, string | undefined>>;
  wired?: Iterable<string>;
  planReady?: boolean;
}

/** A size with one of its two fields empty is a missing field, not a size
 * the maker can't render (backend model_choice._whole_sizes): it is left out
 * of the route choice. */
function wholeSizes(definition: (typeof NODE_DEFINITIONS)[string], params: Record<string, unknown>): Record<string, unknown> {
  const values = { ...params };
  const ruleSets = [definition.directRoute, ...(definition.routes ?? []).map((route) => route.rules)];
  for (const rules of ruleSets) {
    const size = (rules as { size?: { widthParam?: string; heightParam?: string } } | undefined)?.size;
    if (!size?.widthParam || !size.heightParam) continue;
    const pair = [size.widthParam, size.heightParam];
    if (pair.filter((key) => unset(values[key])).length === 1) for (const key of pair) delete values[key];
  }
  return values;
}

/** The params a maker's own API sizes by (its `size` rule; backend
 * model_choice._maker_sizes_by): Seedream on BytePlus takes width x height. */
function makerSizesBy(definition: (typeof NODE_DEFINITIONS)[string], routeId: string | null | undefined): Set<string> {
  const rules = hasRoutes(definition)
    ? routeById(definition, routeId)?.rules
    : definition.directRoute;
  const size = (rules as { size?: { widthParam?: string; heightParam?: string } } | undefined)?.size;
  return new Set([size?.widthParam, size?.heightParam].filter((key): key is string => Boolean(key)));
}

/**
 * Review 13, M-1 and L-6 (round 14): the first required field (card order)
 * that the route the run takes needs with nothing in it, as [verb, word], or
 * null. The route is selectRoute's, the rule the backend's router, pricing
 * and spend gate read: the Krea gateway (a token, or the plan) needs every
 * field; a maker's own API with the person's key only what it sizes by
 * (OpenAI picks GPT Image 2.5's size, xAI leaves Grok's out, BytePlus needs
 * Seedream's width and height). No usable route (no key, the plan not
 * signed in): null, and the key or sign-in line comes first. backend
 * services/model_choice.py unchosen is the same rule;
 * backend/tests/fixtures/required_field_cases.json pins both.
 */
export function unchosenOnRoute(definitionId: string, params: Record<string, unknown> | undefined,
  context: RouteContext): [string, string] | null {
  const definition = NODE_DEFINITIONS[definitionId];
  if (!definition) return null;
  const fields = requiredFields(definition);
  if (fields.length === 0) return null;
  const values = params ?? {};
  const route = refusalRoute(definition, values, context);
  let needed: string[][];
  if (route.kind === 'plan') needed = context.planReady ? fields : [];
  else if (route.kind === 'unset' || !route.key || !String(context.apiKeys[route.key] ?? '').trim()) needed = [];
  else if (route.provider === 'krea') needed = fields;
  else {
    const sizes = makerSizesBy(definition, route.routeId);
    needed = fields.filter(([key]) => sizes.has(key));
  }
  const missing = needed.find(([key]) => unset(values[key]));
  return missing ? [fieldVerb(definition, missing[0]), missing[1]] : null;
}

/** The route the refusal reads: selectRoute's, with a half-set size left out
 * and the Krea-only ports wired (withWiredBlockers). */
function refusalRoute(definition: (typeof NODE_DEFINITIONS)[string], values: Record<string, unknown>,
  context: Pick<RouteContext, 'apiKeys' | 'wired'>) {
  const routed = withWiredBlockers(definition, wholeSizes(definition, values), context.wired ?? []);
  return selectRoute(definition, routed, context.apiKeys);
}

/** The ports wired into `node` among `edges`. */
function wiredInto(node: Node<NodeData>, edges: readonly Edge[] | undefined): string[] {
  return (edges ?? []).filter((edge) => edge.target === node.id && edge.targetHandle)
    .map((edge) => edge.targetHandle as string);
}

/**
 * Review 14, M-B: whether the refusal could name a field of `node` at all (a
 * required field with nothing in it). Only then does what the refusal reads
 * (the keys, the Krea plan's sign-in) have to be known before deciding.
 */
export function mayBeRefused(node: Node<NodeData>): boolean {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  if (!definition) return false;
  const values = (node.data?.params ?? {}) as Record<string, unknown>;
  return requiredFields(definition).some(([key]) => unset(values[key]));
}

/** Whether, with these keys and wires, a node of `nodes` that may be refused
 * runs on the Krea plan: then the plan's sign-in decides its refusal. */
export function planDecidesRefusal(nodes: Node<NodeData>[], edges: readonly Edge[], apiKeys: RouteContext['apiKeys']): boolean {
  return nodes.some((node) => {
    const definition = NODE_DEFINITIONS[node.data?.definitionId];
    if (!definition || !mayBeRefused(node)) return false;
    const values = (node.data?.params ?? {}) as Record<string, unknown>;
    return refusalRoute(definition, values, { apiKeys, wired: wiredInto(node, edges) }).kind === 'plan';
  });
}

/** Every Krea definition with a field the refusal names: {id: [[key, word]]}. */
export function requiredFieldInventory(): Record<string, string[][]> {
  const found: Record<string, string[][]> = {};
  for (const definition of Object.values(NODE_DEFINITIONS)) {
    const fields = requiredFields(definition);
    if (fields.length > 0) found[definition.id] = fields;
  }
  return found;
}

/**
 * GM - Design, round 12 addendum (b), verbatim: "Nothing ran. Choose a model
 * for “Clean plate” first." for the first node among `nodes` (the nodes a run
 * would send) with a required field that has nothing chosen, on the route
 * its run takes (unchosenOnRoute; round 13: "Choose an aspect ratio for “X”
 * first."; round 14, item 1: "Set a width for “X” first." for a typed value),
 * or null. That route would refuse the run, so the canvas refuses it before
 * any dialog ("Don't ask someone to approve a run that can't go out"), on
 * every run path; the backend refuses it the same way (execution.engine
 * unchosen_model_errors). `names`: a node's name for this run. `context`:
 * the keys set, the run's wires, the Krea plan's sign-in; without one
 * (settings not loaded) nothing is refused here, and the backend, which
 * knows the keys, refuses on the route.
 */
export function modelNotChosenText(nodes: Node<NodeData>[], names?: Readonly<Record<string, string>>,
  context?: { apiKeys: RouteContext['apiKeys']; edges?: Edge[]; planReady?: boolean }): string | null {
  if (!context) return null;
  for (const node of nodes) {
    const wired = wiredInto(node, context.edges);
    const found = unchosenOnRoute(node.data?.definitionId, (node.data?.params ?? {}) as Record<string, unknown>,
      { apiKeys: context.apiKeys, wired, planReady: context.planReady });
    if (!found) continue;
    const [verb, field] = found;
    const definition = NODE_DEFINITIONS[node.data?.definitionId];
    const name = names?.[node.id] || (definition ? nodeTitle(definition, node.data?.label) : node.data?.label) || node.id;
    // GM, round 13: "an aspect ratio", "a model".
    const article = /^[aeiou]/i.test(field) ? 'an' : 'a';
    return `Nothing ran. ${verb} ${article} ${field} for “${name}” first.`;
  }
  return null;
}

/**
 * GM - Design, round 16 (a), verbatim: a re-ask after a route change says
 * why, in one line above the rows: "“Hero still” changed while this was
 * open."; 2-3 nodes in row order, "“A”, “B” and “C” changed while this was
 * open." ("“A” and “B” …" for two); 4 or more, "4 nodes changed while this
 * was open." It names only the nodes whose route or price moved between
 * what the person was shown (`shown`) and the rows now (`now`): the model a
 * row runs on its route, its setting, or its price. Null when none moved.
 * Each node is named as its row reads now (review 16, L-1: the person
 * matches the line to the row under it). GM round 17 (1): the dialog says
 * the same line when it updates in place (movedNodesLine).
 */
export function changedNodesLine(shown: PlaceholderRunConfirm, now: PlaceholderRunConfirm): string | null {
  return movedNodesLine(now.rows, movedRowIds(shown, now), now.canvasOrder);
}

/** The rows of `now` whose route or price moved since `shown`, in row order:
 * the model a row runs on its route, its setting, or its price. A row that
 * joined or left the run isn't one (the dialog's other lines cover it). */
export function movedRowIds(shown: PlaceholderRunConfirm, now: PlaceholderRunConfirm): string[] {
  const before = new Map(shown.rows.map((row) => [row.nodeId, row]));
  return now.rows.filter((row) => {
    const was = before.get(row.nodeId);
    return was !== undefined && (was.modelKey !== row.modelKey || (was.setting ?? '') !== (row.setting ?? '')
      || was.price !== row.price);
  }).map((row) => row.nodeId);
}

/** A row's name without its quotes (rows carry it quoted). */
const unquoted = (name: string) => /^“(.*)”$/s.exec(name)?.[1] ?? name;

/** GM's line for the nodes `ids` names, by `rows`' names; null when none of
 * them is a row (any more). Fix round 1 of PR #200 (GM answer 3, review
 * L-6): same titles grouped with a count (errorCopy nodeNameList), in canvas
 * order (`canvasOrder`, the run's node ids as the canvas holds them; rows'
 * order without it). */
export function movedNodesLine(rows: PlaceholderRunRow[], ids: Iterable<string>, canvasOrder?: string[]): string | null {
  const wanted = new Set(ids);
  const at = (row: PlaceholderRunRow) => {
    const index = canvasOrder?.indexOf(row.nodeId) ?? -1;
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const moved = rows.filter((row) => wanted.has(row.nodeId));
  if (moved.length === 0) return null;
  const ordered = canvasOrder ? [...moved].sort((a, b) => at(a) - at(b)) : moved;
  return `${nodeNameList(ordered.map((row) => unquoted(row.name)))} changed while this was open.`;
}

/** A row's segments, in order: the name, the model, each setting, the price
 * (GM - Design, round 12: the row wraps only between them, never inside one).
 * The dialog draws each as one unit, with the " · " between. */
export function rowSegments(row: PlaceholderRunRow): string[] {
  return [row.name, ...(row.model ? [row.model] : []), ...(row.setting ? row.setting.split(' · ') : []), row.price];
}

/** Calls a provider (backend model_pricing.is_local): an unknown type counts
 * as paid. With `apiKeys`, a key-billing node that is "free" with them is
 * not (backend main._paid_placeholders reads the same). */
function isPaid(node: Node<NodeData>, apiKeys?: Readonly<Record<string, string>>): boolean {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  const params = (node.data?.params ?? {}) as Record<string, unknown>;
  if (definition && apiKeys && keyBilling(definition, params, apiKeys) === 'free') return false;
  return !definition || !isLocalRun(definition, params);
}

/** A key-billing node that may bill the person's own account with these keys. */
function mayCost(node: Node<NodeData>, apiKeys?: Readonly<Record<string, string>>): boolean {
  const definition = NODE_DEFINITIONS[node.data?.definitionId];
  return Boolean(definition && apiKeys
    && keyBilling(definition, (node.data?.params ?? {}) as Record<string, unknown>, apiKeys) === 'mayCost');
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

/** The placeholders in the person's direct run of `nodeId`, with their
 * agents: what a dialog of this run shows, and all it remembers (review 6,
 * L-b: never another agent's placeholder elsewhere on the canvas). */
export function runPlaceholders(nodes: Node<NodeData>[], edges: Edge[], nodeId: string): Map<string, PendingAgent> {
  const found = new Map<string, PendingAgent>();
  for (const node of nodeScope(nodes, edges, nodeId)) {
    const flag = cleanPending(node.data?.pending);
    if (flag) found.set(node.id, flag.agent);
  }
  return found;
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

/** USD rounded up to the cent, and never under a cent when above zero: what the person confirms (review 6, L-e; GM -
 * Design, round 7: "amounts the person confirms (button and total line)
 * ALWAYS show cents, rounded UP to the next cent, regardless of size ... and
 * "$0.01" for anything under a cent"). Read at 6 places first, Nebula's own
 * arithmetic (main._run_estimate), so float noise (0.07 * 100 =
 * 7.000000000000001) never adds a cent. */
export function roundUpToCent(amount: number): number {
  if (!(amount > 0)) return 0;
  const micros = Math.round(amount * 1e6);
  // Review 7, L4: an amount under half a millionth still costs something,
  // so it confirms a cent, never $0.00 (backend main._six_places agrees).
  return Math.max(0.01, Math.ceil(micros / 1e4) / 100);
}

/** "$0.21", "$10.49", "$0.01": an amount the person confirms, always in
 * cents (GM - Design, round 7). Row prices keep formatUsd. */
export function formatConfirmUsd(amount: number): string {
  return `$${roundUpToCent(amount).toFixed(2)}`;
}

/** Whether the amount is a range ("up to"), as the confirmed amounts show it. */
function isRange(cost: RunCost): boolean {
  return formatConfirmUsd(cost.low) !== formatConfirmUsd(cost.high);
}

/** "Run for $0.12" when the total is fixed, "Run for up to $0.86" when it is a
 * range (matching "could cost up to"), "Run" when a row has no listed price,
 * nothing is priced (only Krea-plan rows) or there is no total (GM - Design,
 * rounds 4 and 5, verbatim); "Generate" in place of "Run" from Cinema (round 6). */
function runLabelFor(cost: RunScopeSummary['cost'], anyMissing: boolean, verb: string): string {
  if (!cost || anyMissing || cost.lines.length === 0) return verb;
  return isRange(cost) ? `${verb} for up to ${formatConfirmUsd(cost.high)}` : `${verb} for ${formatConfirmUsd(cost.high)}`;
}

/** The total under the rows (GM - Design, round 5, verbatim: "a dollar amount
 * shows only when it covers every paid row; Krea-plan rows cost nothing extra
 * and don't count as missing"): the costly-run confirm's own line when it
 * does; "The listed prices total (up to) $0.43." when a row's price isn't
 * listed; none when nothing in the run has a listed price. */
function totalLineFor(cost: RunScopeSummary['cost'], anyMissing: boolean): string | null {
  if (!cost || cost.lines.length === 0) return null;
  if (!anyMissing) return `This run could cost up to ${formatConfirmUsd(cost.high)} at list prices.`;
  return isRange(cost) ? `The listed prices total up to ${formatConfirmUsd(cost.high)}.`
    : `The listed prices total ${formatConfirmUsd(cost.high)}.`;
}

/** Under a total, the rows no dollar amount covers (GM - Design, verbatim):
 * "price not listed" ones by name, one or two, then a count (round 6, item
 * 1); "price depends on its input" ones the same way (round 7, item 2); both
 * kinds together, or three or more priced by their input, as one count. */
function missingFootnote(unlisted: string[], byInput: string[]): string | null {
  const count = unlisted.length + byInput.length;
  if (count === 0) return null;
  if (unlisted.length > 0 && byInput.length > 0) return `${count} nodes have no price yet, so the run may cost more.`;
  if (byInput.length === 1) return `${byInput[0]} is priced by its input, so the run may cost more.`;
  if (byInput.length === 2) return `${byInput[0]} and ${byInput[1]} are priced by their input, so the run may cost more.`;
  if (byInput.length > 2) return `${count} nodes have no price yet, so the run may cost more.`;
  if (unlisted.length === 1) return `${unlisted[0]} has no list price, so the run may cost more.`;
  if (unlisted.length === 2) return `${unlisted[0]} and ${unlisted[1]} have no list price, so the run may cost more.`;
  return `${count} nodes have no list price, so the run may cost more.`;
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
  const scopeIds = new Set(scope.map((node) => node.id));
  const placeholders = scope.flatMap((node) => {
    const flag = cleanPending(node.data?.pending);
    return flag ? [{ node, agent: flag.agent }] : [];
  });
  const paid = placeholders.filter(({ node }) => isPaid(node, options.apiKeys));
  // Placeholders a dialog of this run showed that their agents have finished
  // since (H1): still in the run, no longer placeholders.
  const gone = (node: Node<NodeData>) => options.gone?.has(node.id) === true && !cleanPending(node.data?.pending);
  const finished = scope.flatMap((node) => {
    const agent = options.shown?.get(node.id);
    return agent && !cleanPending(node.data?.pending) && !gone(node) ? [{ node, agent }] : [];
  });
  // And those that left the run since (deleted or disconnected): never
  // "finished" (review 6, L-b). A replay's saved copy of one that is gone
  // from the canvas runs, but the agent's placeholder left (review 7, L1).
  const inScope = new Set(scope.filter((node) => !gone(node)).map((node) => node.id));
  const left = [...(options.shown ?? [])].filter(([id]) => !inScope.has(id)).map(([, agent]) => agent);
  if (paid.length === 0 && !(options.shown && options.shown.size > 0)) return null;
  // A replay's placeholders whose agents changed them after the run was saved
  // (GM - Design on review 8 L-b): the replay sends the saved version, so it
  // says so. Placeholders still being set up and ones finished meanwhile.
  const changedByAgent = [...placeholders, ...finished].filter(({ node }) => options.changed?.has(node.id) === true);
  const finishedChanged = new Set(finished.filter(({ node }) => options.changed?.has(node.id)).map(({ node }) => node.id));
  // A saved copy that is no longer its agent's node has no dot (review 7, L1),
  // nor does the saved version of one its agent changed and finished (GM:
  // "the saved versions as muted rows").
  const agentOf = new Map<string, PendingAgent>([...finished.filter(({ node }) => !finishedChanged.has(node.id)), ...placeholders]
    .map(({ node, agent }) => [node.id, agent]));
  let anyMissing = false;
  const unlisted: string[] = [];
  const byInput: string[] = [];
  // GM - Design, round 15, item 3: a row names the route the run actually
  // takes (summarizeRunScope's `routes`): a node under its model's own name,
  // and the model, read "Grok Imagine 2.0 via xAI" on the person's xAI key (round 16).
  const routeOf = (node: Node<NodeData>) => summary.routes?.[node.id] ?? null;
  // GM - Design, round 18, item 1 (verbatim): "Unnamed node: the default
  // title drops the route. "Grok Imagine 2.0" in all three places" (the card,
  // the changed line, the row): "“Grok Imagine 2.0” · via xAI · $0.06". "When
  // the name already is the model, the row drops the model and keeps only the
  // route. A named node keeps the full form: "“Alt still” · Grok Imagine 2.0
  // via xAI · $0.06". On Krea: "“Grok Imagine 2.0” · via Krea · price not
  // listed"." Only for nodes whose route depends on keys (canvasTitle).
  const titled = (node: Node<NodeData>) => {
    const definition = NODE_DEFINITIONS[node.data?.definitionId];
    return !options.names?.[node.id] && definition !== undefined && !definition.providerVia
      && isDefaultTitle(definition, node.data?.label) && canvasTitle(definition) !== definition.displayName ? definition : null;
  };
  const labelOf = (node: Node<NodeData>) => {
    const definition = titled(node);
    return definition ? canvasTitle(definition) : options.names?.[node.id] || runNodeName(node, routeOf(node));
  };
  const row = (node: Node<NodeData>): PlaceholderRunRow => {
    const label = labelOf(node);
    const model = modelOnRoute(node, routeOf(node), options.routeUnknown);
    const price = mayCost(node, options.apiKeys) ? { text: PRICE_MAY_COST, missing: true }
      : rowPrice(node.id, summary, runNodeName(node, routeOf(node)));
    if (price.missing) anyMissing = true;
    if (price.text === PRICE_NOT_LISTED) unlisted.push(`“${label}”`);
    if (price.text === PRICE_DEPENDS_ON_INPUT) byInput.push(`“${label}”`);
    const definition = titled(node);
    const route = routeOf(node);
    // The model segment of an unnamed node whose name is the model: only the route.
    const shownModel = definition && modelName(node) === definition.displayName
      ? (route && !options.routeUnknown ? `via ${providerLabel(route)}` : null)
      : model === label ? null : model;
    return { nodeId: node.id, name: `“${label}”`, model: shownModel, modelKey: model,
      setting: kreaSetting(node), price: price.text, agent: agentOf.get(node.id) ?? null };
  };
  const paidNodes = scope.filter((node) => isPaid(node, options.apiKeys));
  // The agents' rows first (with their dots), then the run's other paid nodes, muted.
  const rows = [...paidNodes.filter((node) => agentOf.has(node.id)), ...paidNodes.filter((node) => !agentOf.has(node.id))]
    .map(row);
  const cost = summary.cost;
  const verb = options.verb ?? 'Run';
  const count = placeholders.length;
  const free = count - paid.length;
  let heading: string;
  let intro: string;
  // GM - Design, round 7 (review 6 L-b answer), and round 8 item 2: also
  // under the still-setting-up heading. Verbatim.
  const leftAgents = agentNames(left);
  // Round 11, item 6: "the agents" ("nodes agents" read like a stumble).
  const leftWho = leftAgents.length === 1 ? leftAgents[0] : 'the agents';
  const leftLine = left.length === 0 ? null : left.length === 1
    ? `1 node ${leftWho} was setting up is no longer in this run.`
    : `${left.length} nodes ${leftWho} ${leftAgents.length === 1 ? 'was' : 'were'} setting up are no longer in this run.`;
  // GM - Design on review 8 L-b and round 10, item 1, verbatim: "Codex
  // changed “Grade” after the run was saved. The replay uses the saved
  // settings.", "“Grade” and “Wide”", "3 nodes"; "The agents changed …" for
  // several agents. The names are the rows'.
  // Round 11: up to 3 by name ("“Wide”, “Hero still” and “Grade”"), a count from 4, and the
  // names in the order the rows below them read (item 1). A free node has no row: it comes after.
  let savedSentence: string | null = null;
  if (changedByAgent.length > 0) {
    const agents = agentNames(changedByAgent.map(({ agent }) => agent));
    // Fix round 1 of PR #200 (GM answer 3, review L-6): canvas order, and
    // same titles grouped with a count (errorCopy nodeNameList).
    const canvasAt = (id: string) => { const at = nodes.findIndex((candidate) => candidate.id === id); return at < 0 ? nodes.length : at; };
    const which = nodeNameList([...changedByAgent].sort((a, b) => canvasAt(a.node.id) - canvasAt(b.node.id)).map(({ node }) => labelOf(node)));
    savedSentence = `${agents.length === 1 ? agents[0] : 'The agents'} changed ${which} after the run was saved. The replay uses the saved settings.`;
  }
  if (count > 0) {
    const agents = agentNames(placeholders.map(({ agent }) => agent));
    const one = agents.length === 1 ? agents[0] : null;
    heading = `Run ${count} ${count === 1 ? 'node' : 'nodes'} ${one ? `${one} is` : 'the agents are'} still setting up?`;
    intro = one
      ? `${one} hasn't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`
      : `Agents haven't finished ${count === 1 ? 'this, so its settings' : 'these, so their settings'} may not be final.`;
  } else if (finishedChanged.size > 0 && savedSentence) {
    // A replay whose placeholders' agents finished them with other settings
    // than the saved ones: the saved version runs (GM - Design on review 8 L-b).
    heading = 'Replay the saved version?';
    intro = savedSentence;
  } else if (finished.length > 0) {
    // No placeholder left: their agents finished them while the dialog was
    // open (GM - Design, round 6, copy answer to review 5 H1; round 7, item 1
    // for "this node"), and any others left the run (review 6, L-b answer).
    // All verbatim.
    const agents = agentNames(finished.map(({ agent }) => agent));
    const one = agents.length === 1 ? agents[0] : null;
    const these = finished.length === 1 ? 'this node' : 'these nodes';
    heading = one ? `Run with ${one}'s changes?` : "Run with the agents' changes?";
    intro = one ? `${one} finished setting up ${these}.` : `The agents finished setting up ${these}.`;
  } else {
    // Every placeholder the dialog showed left the run, none finished
    // (GM - Design, answer to review 6 L-b, verbatim): neutral, never "removed".
    const agents = agentNames(left);
    const one = agents.length === 1 ? agents[0] : null;
    heading = left.length === 1 && one
      ? `Run without the node ${one} was setting up?`
      : one ? `Run without the nodes ${one} was setting up?` : 'Run without the nodes the agents were setting up?';
    intro = left.length === 1 ? "It's no longer in this run." : "They're no longer in this run.";
  }
  const totalLine = totalLineFor(cost, anyMissing);
  const footnote = totalLine ? missingFootnote(unlisted, byInput) : null;
  const costNotes = runCostNotes(summary, { prices: false });
  return {
    heading,
    intro,
    // Under the still-setting-up heading's body, before the left line (GM).
    savedLine: count > 0 ? savedSentence : null,
    // The heading already says they left: no second line under it.
    leftLine: count === 0 && finished.length === 0 ? null : leftLine,
    rows,
    canvasOrder: nodes.filter((node) => scopeIds.has(node.id)).map((node) => node.id),
    freeLine: free > 0 ? `Plus ${free} free ${free === 1 ? 'node' : 'nodes'}.` : null,
    totalLine,
    notes: [...costNotes, ...(footnote ? [footnote] : [])],
    costNotes,
    runLabel: runLabelFor(cost, anyMissing, verb),
    confirmIds: paid.map(({ node }) => node.id).sort(),
    confirmCost: cost ? roundUpToCent(cost.high) : null,
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

/**
 * Review 16, M2: a 409 re-ask asked again because a row's route moved while
 * it was open. Nebula's estimate (`refused`) was for the routes the refused
 * run had: a row still on its route keeps those numbers (what Nebula holds
 * the run to), and a row on a new route (`moved`) takes the canvas's own
 * route-aware numbers for it (`canvas`, summarizeRunScope's cost), as
 * Nebula's estimate for that route would read. low and high are the sums of
 * the lines, null with none (as Nebula's are).
 */
export function mergeRunEstimates(refused: RunEstimate, canvas: RunCost | undefined, moved: ReadonlySet<string>): RunEstimate {
  const keep = (id: string) => !moved.has(id);
  const nodes = Object.fromEntries(Object.entries(refused.nodes).filter(([id]) => keep(id)));
  const unpriced = refused.unpriced.filter(keep);
  const plan = refused.plan.filter(keep);
  const awaitingInput = refused.awaitingInput.filter(keep);
  const unavailable = Object.fromEntries(Object.entries(refused.unavailable).filter(([id]) => keep(id)));
  for (const line of canvas?.lines ?? []) {
    if (line.nodeId && moved.has(line.nodeId)) nodes[line.nodeId] = { low: line.low, high: line.high };
  }
  const ids = canvas?.ids;
  for (const id of moved) {
    if (ids?.unpriced.includes(id)) unpriced.push(id);
    if (ids?.plan.includes(id)) plan.push(id);
    if (ids?.awaitingInput.includes(id)) awaitingInput.push(id);
    const why = ids?.unavailable?.[id];
    if (why) unavailable[id] = why;
  }
  const lines = Object.values(nodes);
  const sum = (pick: (line: { low: number; high: number }) => number) => lines.reduce((total, line) => total + pick(line), 0);
  return {
    low: lines.length ? sum((line) => line.low) : null,
    high: lines.length ? sum((line) => line.high) : null,
    nodes, unpriced, plan,
    plus: [...new Set([...refused.plus, ...(moved.size ? canvas?.plus ?? [] : [])])],
    unavailable, awaitingInput,
  };
}

/** The run's nodes with the placeholders Nebula's refusal names (`refusal`):
 * a paid one the tab hasn't heard of yet gets its agent's flag from the
 * refusal, and a paid one it lists no longer (an agent made it normal) loses
 * it, so the dialog asks over what Nebula will hold the run to. */
export function withRefusalFlags(
  nodes: Node<NodeData>[], refusal: PlaceholderRefusal, apiKeys?: Readonly<Record<string, string>>,
): Node<NodeData>[] {
  const listed = new Set(refusal.placeholders);
  return nodes.map((node) => {
    const flag = cleanPending(node.data?.pending);
    if (listed.has(node.id) && !flag) {
      const agent = refusal.agents[node.id];
      return agent ? { ...node, data: { ...node.data, pending: { agent, at: 0 } } } : node;
    }
    if (!listed.has(node.id) && flag && isPaid(node, apiKeys)) {
      const data = { ...node.data } as NodeData & { pending?: unknown };
      delete data.pending;
      return { ...node, data };
    }
    return node;
  });
}
