import type {
  APIProvider, DirectAcceptRule, DirectSizeLimits, ModelNodeDefinition, ParamDefinition, RouteRules, RouteSpec,
} from '../types';
import { usesKreaAccount } from './kreaConnection';

/**
 * Which route one run of a node takes, and so which provider it bills.
 * The same rule as backend/services/node_route.py `select_route`; both are
 * tested against backend/tests/fixtures/route_cases.json.
 *
 * 1. `_kreaAuth == "mcp"` (or an account-only Krea node): the Krea plan. A
 *    maker key never overrides that explicit choice.
 * 2. a direct (maker) key is set, and the direct route can take this run
 *    (directBlock): the maker's API.
 * 3. otherwise the first other key that is set (FAL_KEY, KREA_API_TOKEN, or
 *    RUNWAY_API_KEY for the ElevenLabs models Runway resells).
 *
 * A route-table node (`routes`, docs/PROVIDER-ROUTES.md) reads its saved
 * `_provider` instead, and Auto never moves to another provider because of
 * a param (selectRoute). Nodes without `routes` keep the rule above.
 */

/** Which provider bills a run that uses this key (node_route.KEY_PROVIDERS). */
export const KEY_PROVIDERS: Readonly<Record<string, APIProvider>> = {
  OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', GOOGLE_API_KEY: 'google',
  GOOGLE_VERTEX_CREDENTIALS: 'google',
  OPENROUTER_API_KEY: 'openrouter', REPLICATE_API_TOKEN: 'replicate', FAL_KEY: 'fal',
  MESHY_API_KEY: 'meshy', RUNWAY_API_KEY: 'runway', ELEVENLABS_API_KEY: 'elevenlabs',
  MINIMAX_API_KEY: 'minimax', XAI_API_KEY: 'xai', HIGGSFIELD_API_KEY: 'higgsfield',
  QUIVER_API_KEY: 'quiver', KREA_API_TOKEN: 'krea', IDEOGRAM_API_KEY: 'ideogram',
  WORLDLABS_API_KEY: 'worldlabs', TYPESAFE_API_KEY: 'typesafe',
  // BytePlus ModelArk, ByteDance's own international API (Seedream, Seedance).
  BYTEPLUS_API_KEY: 'bytedance',
  // Black Forest Labs' own API (api.bfl.ai), the maker of FLUX.
  BFL_API_KEY: 'bfl',
};

/** How errors, readiness and the run status name a provider
 * (node_route.PROVIDER_LABELS; tests/fixtures/route_tables.json pins both). */
export const PROVIDER_LABELS: Readonly<Record<APIProvider, string>> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', runway: 'Runway',
  kling: 'Kling', elevenlabs: 'ElevenLabs', replicate: 'Replicate', fal: 'fal.ai',
  bytedance: 'ByteDance', minimax: 'MiniMax', luma: 'Luma', xai: 'xAI',
  recraft: 'Recraft', ideogram: 'Ideogram', openrouter: 'OpenRouter', bfl: 'Black Forest Labs',
  higgsfield: 'Higgsfield', meshy: 'Meshy', quiver: 'QuiverAI', krea: 'Krea',
  worldlabs: 'World Labs', nous: 'Nous', typesafe: 'TypeSafe', utility: 'Local tools',
};

/** The params that decide who bills a run: the provider choice and the Krea
 * billing mode (node_route.BILLING_PARAMS). Only the person changes them. */
export const PROVIDER_PARAM = '_provider';
export const BILLING_PARAMS: readonly string[] = [PROVIDER_PARAM, '_kreaAuth'];
export const AUTO = 'auto';

/** A direct route that also needs a param set, else the run takes the fallback
 * (node_route.DIRECT_REQUIRES): Ideogram's direct reframe sizes by `resolution`;
 * Runway's TTS and speech-to-speech run on ElevenLabs only with the recipe's
 * own ElevenLabs `voice_id` (Runway's voice presets don't map to one). */
export const DIRECT_REQUIRES: Readonly<Record<string, string>> = {
  'ideogram-reframe': 'resolution',
  'runway-tts': 'voice_id',
  'runway-sts': 'voice_id',
};

/** A direct route the maker shuts down on a date (node_route.DIRECT_RETIRES):
 * from that day the fal or Krea copy runs it. `param`/`values` narrow it to
 * the saved model choices that call the retiring model. gemini-2.5-flash-image:
 * "March 15, 2027" in Google's deprecations table (checked 2026-10-14). */
interface DirectRetirement { on: string; param?: string; values?: readonly string[] }
const GEMINI_25_FLASH_IMAGE_SHUTDOWN = '2027-03-15';
/** gpt-image-1.5: "Dec 1, 2026" in OpenAI's deprecations table (checked 2026-10-14). */
const GPT_IMAGE_15_SHUTDOWN = '2026-12-01';
export const DIRECT_RETIRES: Readonly<Record<string, DirectRetirement>> = {
  'nano-banana-fal': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN, param: 'model', values: ['nano-banana', 'gemini-25-flash-image'] },
  'nano-banana-fal-edit': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN, param: 'model', values: ['nano-banana', 'gemini-25-flash-image'] },
  'krea-image-google-nano-banana': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN },
  'gpt-image-1-5': { on: GPT_IMAGE_15_SHUTDOWN },
  'gpt-image-1-5-edit': { on: GPT_IMAGE_15_SHUTDOWN },
};

/** Why the direct route can't take a run (node_route.direct_block), checked
 * in this order: `requires` a direct param that isn't set (DIRECT_REQUIRES),
 * `blocked` by a copy-only param that is set or wired (directRoute.blockedBy),
 * `unsupported` by a value or combination the maker doesn't take
 * (directRoute.accepts / rejects / rejectsWhen), `size` the maker can't render
 * exactly (directRoute.size), or `retired` by the maker on `on`
 * (DIRECT_RETIRES). */
export interface DirectBlock {
  /** Route-table nodes add `ports` (more inputs wired than a route takes,
   * rules.ports) and `unknown-provider` (`_provider` names no route). */
  reason: 'requires' | 'blocked' | 'unsupported' | 'size' | 'retired' | 'ports' | 'unknown-provider';
  param: string | null;
  on: string | null;
  /** `unsupported`: what the maker doesn't take, the param and its value
   * ("resolution 4K") or a rejectsWhen rule's label. */
  detail?: string;
}

export type RouteKind = 'local' | 'plan' | 'only' | 'direct' | 'fallback' | 'unset';

/** Where one run goes. `routeId`, `block` and `missing` are only set on
 * route-table nodes (node_route.Route): the route chosen or resolved, why it
 * can't take this run, and the keys it would need. */
export interface NodeRoute {
  kind: RouteKind;
  provider: string | null;
  key: string | null;
  routeId?: string | null;
  block?: DirectBlock | null;
  missing?: string[];
}

type ApiKeys = Readonly<Record<string, string | undefined>>;

function keyList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((key): key is string => typeof key === 'string' && Boolean(key));
}

/** The keys that select a dual-route node's direct (maker) route, in the
 * order the backend tries them. Veo 3.1 has two: Vertex, then the Gemini API. */
export function directKeyNames(definition: Pick<ModelNodeDefinition, 'directKeyName'>): string[] {
  return keyList(definition.directKeyName);
}

export function envKeyNames(definition: Pick<ModelNodeDefinition, 'envKeyName'>): string[] {
  return keyList(definition.envKeyName);
}

/** The keys of the fal or Krea copy: every env key that isn't a direct key. */
export function fallbackKeyNames(definition: Pick<ModelNodeDefinition, 'envKeyName' | 'directKeyName'>): string[] {
  const direct = directKeyNames(definition);
  return envKeyNames(definition).filter((key) => !direct.includes(key));
}

/** Who runs a dual-route node without its maker key: the provider of its first
 * non-direct key ('fal', 'krea', or 'runway' for Runway's resold ElevenLabs models). */
export function fallbackProvider(definition: Pick<ModelNodeDefinition, 'envKeyName' | 'directKeyName'>): APIProvider | undefined {
  if (directKeyNames(definition).length === 0) return undefined;
  const key = fallbackKeyNames(definition).find((candidate) => Object.hasOwn(KEY_PROVIDERS, candidate));
  return key ? KEY_PROVIDERS[key] : undefined;
}

function isSet(apiKeys: ApiKeys, key: string): boolean {
  const value = apiKeys[key];
  return typeof value === 'string' && Boolean(value.trim());
}

/** The first direct key that is configured, if any. */
export function configuredDirectKey(
  definition: Pick<ModelNodeDefinition, 'directKeyName'>,
  apiKeys: ApiKeys,
): string | undefined {
  return directKeyNames(definition).find((key) => isSet(apiKeys, key));
}

/** A param counts as set when it isn't undefined, null, "" or only
 * whitespace (node_route._has_value). */
function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null;
}

/** Today's local date as YYYY-MM-DD, as Python's date.today() reads it. */
function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A rejectsWhen value that matches a param that is set: saved non-empty, or
 * wired into its port (node_route.SET). */
export const SET = '(set)';
/** A rejectsWhen value that matches a param that is NOT set: not saved (or
 * blank) and not wired (node_route.NOT_SET). */
export const NOT_SET = '(unset)';
/** A param that arrives by wire rather than saved (node_route.WIRED). */
export const WIRED = '(wired)';
/** Where withWiredBlockers puts the wired-input counts a `ports` rule reads
 * (node_route.PORT_COUNTS). Never a param name, so it is never sent. */
export const PORT_COUNTS = '(wired ports)';

type RoutedDefinition = Pick<ModelNodeDefinition, 'id' | 'apiProvider' | 'envKeyName' | 'directKeyName'
  | 'directRoute' | 'routes' | 'params' | 'sharedParams' | 'directParams' | 'falParams'>;

/** A route-table node: its definition lists `routes` (node_route.has_routes). */
export function hasRoutes(definition: Pick<ModelNodeDefinition, 'routes'> | undefined): boolean {
  return Array.isArray(definition?.routes) && definition.routes.length > 0;
}

const RULE_KEYS = ['blockedBy', 'accepts', 'rejects', 'rejectsWhen', 'size'] as const;

/** A dual-route node's maker rules in RouteSpec `rules` form: directRoute's
 * rules plus `requires` (DIRECT_REQUIRES) and `retires` (DIRECT_RETIRES)
 * (node_route._legacy_rules). */
function legacyRules(definition: RoutedDefinition): RouteRules {
  const spec = (definition.directRoute ?? {}) as Record<string, unknown>;
  const rules: Record<string, unknown> = {};
  for (const key of RULE_KEYS) if (Object.hasOwn(spec, key)) rules[key] = spec[key];
  if (Object.hasOwn(DIRECT_REQUIRES, definition.id)) rules.requires = DIRECT_REQUIRES[definition.id];
  if (Object.hasOwn(DIRECT_RETIRES, definition.id)) rules.retires = { ...DIRECT_RETIRES[definition.id] };
  return rules as RouteRules;
}

/** Every route a node can run on, in Auto order (node_route.routes_of): a
 * route-table node's `routes`, else computed specs (a dual-route node's
 * maker route, then one copy route per other provider in envKeyName order;
 * a single-route node one route on its apiProvider). selectRoute doesn't use
 * the computed specs. */
export function routesOf(definition: RoutedDefinition): RouteSpec[] {
  if (hasRoutes(definition)) return definition.routes!;
  const provider = definition.apiProvider;
  const env = envKeyNames(definition);
  if (env.length < 2) return [{ id: provider ?? '', provider, keys: env, params: [] } as unknown as RouteSpec];
  const specs: RouteSpec[] = [];
  const direct = directKeyNames(definition);
  const providerFor = (key: string) => (Object.hasOwn(KEY_PROVIDERS, key) ? KEY_PROVIDERS[key] : provider);
  if (direct.length) {
    const maker = providerFor(direct[0]);
    specs.push({ id: maker, provider: maker, maker: true, keys: direct, params: [...(definition.directParams ?? [])],
      rules: legacyRules(definition) } as unknown as RouteSpec);
  }
  const grouped = new Map<string, string[]>();
  for (const key of fallbackKeyNames(definition)) {
    const copy = providerFor(key);
    grouped.set(copy, [...(grouped.get(copy) ?? []), key]);
  }
  for (const [copy, keys] of grouped) {
    specs.push({ id: copy, provider: copy, keys, params: [...(definition.falParams ?? [])] } as unknown as RouteSpec);
  }
  return specs;
}

export function routeById(definition: RoutedDefinition, routeId: unknown): RouteSpec | undefined {
  return routesOf(definition).find((route) => route.id === routeId);
}

export function makerRoute(definition: RoutedDefinition): RouteSpec | undefined {
  return routesOf(definition).find((route) => route.maker);
}

/** Every param a node declares, once per key: params, sharedParams,
 * directParams, falParams, then each route's own params; the first
 * definition of a key wins (node_route.all_param_definitions). */
export function allParamDefinitions(
  definition: Pick<ModelNodeDefinition, 'params' | 'sharedParams' | 'directParams' | 'falParams' | 'routes'>,
): ParamDefinition[] {
  const seen = new Map<string, ParamDefinition>();
  const groups = [definition.params, definition.sharedParams, definition.directParams, definition.falParams,
    ...(hasRoutes(definition) ? definition.routes!.map((route) => route.params) : [])];
  for (const group of groups) {
    for (const param of Array.isArray(group) ? group : []) {
      if (param?.key && !seen.has(param.key)) seen.set(param.key, param);
    }
  }
  return [...seen.values()];
}

/** The params a rule counts as set when they arrive by wire: `blockedBy` and
 * every rejectsWhen entry matching "(set)" or "(unset)": a wired port isn't
 * unset (node_route.wired_rule_params). On a route-table node, over every
 * route and its endpointWhen entries. */
export function wiredRuleParams(definition: Pick<ModelNodeDefinition, 'directRoute' | 'routes'>): Set<string> {
  const named = new Set<string>();
  for (const spec of ruleSets(definition)) {
    for (const key of spec.blockedBy ?? []) named.add(key);
    for (const rule of spec.rejectsWhen ?? []) {
      for (const [key, want] of Object.entries(rule.match)) if (want === SET || want === NOT_SET) named.add(key);
    }
  }
  for (const route of hasRoutes(definition) ? definition.routes! : []) {
    for (const option of route.endpointWhen ?? []) {
      for (const [key, want] of Object.entries(option.when ?? {})) if (want === SET || want === NOT_SET) named.add(key);
    }
  }
  return named;
}

function ruleSets(definition: Pick<ModelNodeDefinition, 'directRoute' | 'routes'>): RouteRules[] {
  if (hasRoutes(definition)) return definition.routes!.map(routeRules);
  return definition.directRoute ? [definition.directRoute] : [];
}

/** The ports a route's `ports` rule counts (route-table nodes only). */
function countedPorts(definition: Pick<ModelNodeDefinition, 'directRoute' | 'routes'>): Set<string> {
  if (!hasRoutes(definition)) return new Set();
  return new Set(ruleSets(definition).flatMap((rules) => Object.keys(rules.ports ?? {})));
}

/** `params` plus a WIRED marker for each param a rule reads as set
 * (wiredRuleParams) that arrives on a wired input port, so directBlock treats
 * it as the saved param (node_route.with_wired_blockers). `wired` are the
 * ports with an edge in, or a map of each port to how many inputs it carries;
 * a route-table node with a `ports` rule then gets those counts under
 * PORT_COUNTS. The frontend counts edges, all it knows before the run; the
 * backend router counts the items each port carries, so one edge bringing a
 * list can still stop the run there. */
export function withWiredBlockers(
  definition: Pick<ModelNodeDefinition, 'directRoute' | 'routes'>,
  params: Record<string, unknown> | undefined,
  wired: Iterable<string> | ReadonlyMap<string, number>,
): Record<string, unknown> {
  const values = { ...(params ?? {}) };
  const counts = wired instanceof Map
    ? new Map(wired)
    : new Map([...(wired as Iterable<string>)].map((port) => [port, 1] as const));
  for (const key of wiredRuleParams(definition)) {
    if (counts.has(key) && !hasValue(values[key])) values[key] = WIRED;
  }
  const counted = countedPorts(definition);
  if (counted.size) {
    values[PORT_COUNTS] = Object.fromEntries([...counts].filter(([port, count]) => counted.has(port) && count > 0));
  }
  return values;
}

/** A param's value as a run reads it: the saved value, else the definition default. */
function effectiveValue(definition: RoutedDefinition, params: Record<string, unknown>, key: string): unknown {
  if (hasValue(params[key])) return params[key];
  return allParamDefinitions(definition).find((candidate) => candidate.key === key)?.default;
}

/** One spelling for a param value, as pricing compares them: 6 == 6.0 and
 * true == "true", but 0 is not false (node_route.match_value). */
export function matchValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

/** A whole-pixel width x height inside the maker's documented limits
 * (node_route.size_fits). */
export function sizeFits(width: unknown, height: unknown, limits: DirectSizeLimits): boolean {
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
  const pixels = width * height;
  if (pixels < (limits.minPixels ?? 0) || pixels > (limits.maxPixels ?? Infinity)) return false;
  return Math.max(width / height, height / width) <= (limits.maxAspect ?? Infinity);
}

/** `size` when the recipe's size is outside the rules' size (node_route._size_block). */
function sizeBlock(definition: RoutedDefinition, params: Record<string, unknown>, limits: DirectSizeLimits | undefined): DirectBlock | null {
  if (!limits) return null;
  if (limits.widthParam && limits.heightParam) {
    const width = params[limits.widthParam];
    const height = params[limits.heightParam];
    if ((hasValue(width) || hasValue(height)) && !sizeFits(width, height, limits)) {
      return { reason: 'size', param: limits.widthParam, on: null };
    }
  }
  if (limits.param) {
    const value = effectiveValue(definition, params, limits.param);
    if (typeof value === 'string' && (limits.unsupported ?? []).includes(value)) {
      return { reason: 'size', param: limits.param, on: null };
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const size = value as Record<string, unknown>;
      if (!sizeFits(size.width, size.height, limits)) return { reason: 'size', param: limits.param, on: null };
    }
  }
  return null;
}

/** A value the maker takes (one directRoute.accepts rule, node_route.value_accepted):
 * one of `values`, and/or a number (`integer`: whole) within `min`..`max`. */
export function valueAccepted(value: unknown, rule: DirectAcceptRule): boolean {
  if (rule.values && !rule.values.map(matchValue).includes(matchValue(value))) return false;
  if (rule.min !== undefined || rule.max !== undefined || rule.integer !== undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (rule.integer && !Number.isInteger(value)) return false;
    if (rule.min !== undefined && value < rule.min) return false;
    if (rule.max !== undefined && value > rule.max) return false;
  }
  return true;
}

/** One entry of a rejectsWhen `match` (node_route._matches): "(set)" means
 * saved non-empty or wired, "(unset)" neither; any other value is compared
 * with the run's value. */
function matches(definition: RoutedDefinition, params: Record<string, unknown>, key: string, want: unknown): boolean {
  if (want === SET) return hasValue(params[key]);
  if (want === NOT_SET) return !hasValue(params[key]);
  return matchValue(effectiveValue(definition, params, key)) === matchValue(want);
}

/** `unsupported` from the value rules (node_route._unsupported), read against
 * the run's values (saved, else the definition default): `accepts` the values
 * the maker takes, `rejects` values it doesn't, `rejectsWhen` combinations it
 * doesn't (every entry must match). */
function unsupportedBlock(definition: RoutedDefinition, params: Record<string, unknown>, spec: RouteRules): DirectBlock | null {
  for (const [key, rule] of Object.entries(spec.accepts ?? {})) {
    const value = effectiveValue(definition, params, key);
    if (hasValue(value) && !valueAccepted(value, rule)) {
      return { reason: 'unsupported', param: key, on: null, detail: `${key} ${matchValue(value)}` };
    }
  }
  for (const [key, refused] of Object.entries(spec.rejects ?? {})) {
    const value = effectiveValue(definition, params, key);
    if (hasValue(value) && refused.map(matchValue).includes(matchValue(value))) {
      return { reason: 'unsupported', param: key, on: null, detail: `${key} ${matchValue(value)}` };
    }
  }
  for (const rule of spec.rejectsWhen ?? []) {
    const entries = Object.entries(rule.match);
    if (entries.length && entries.every(([key, want]) => matches(definition, params, key, want))) {
      return { reason: 'unsupported', param: entries[0][0], on: null, detail: rule.label };
    }
  }
  return null;
}

/** directBlock's checks, in its order, over one rule set, then the `ports`
 * rule (node_route._rules_block). */
function rulesBlock(definition: RoutedDefinition, params: Record<string, unknown>, rules: RouteRules): DirectBlock | null {
  if (rules.requires && !hasValue(params[rules.requires])) return { reason: 'requires', param: rules.requires, on: null };
  for (const key of rules.blockedBy ?? []) {
    if (hasValue(params[key])) return { reason: 'blocked', param: key, on: null };
  }
  const block = unsupportedBlock(definition, params, rules) ?? sizeBlock(definition, params, rules.size);
  if (block) return block;
  const retires = rules.retires;
  if (retires && todayIso() >= retires.on) {
    const value = retires.param ? effectiveValue(definition, params, retires.param) : undefined;
    if (!retires.param || (retires.values ?? []).includes(value as string)) {
      return { reason: 'retired', param: retires.param ?? null, on: retires.on };
    }
  }
  const counts = (params[PORT_COUNTS] ?? {}) as Record<string, number>;
  for (const [port, limit] of Object.entries(rules.ports ?? {})) {
    const count = typeof counts[port] === 'number' ? counts[port] : 0;
    if (Number.isInteger(limit?.max) && count > limit.max) {
      return { reason: 'ports', param: port, on: null, detail: `${port} ${count}` };
    }
  }
  return null;
}

/** Why the direct route can't take a run with these params, or null when it
 * can (node_route.direct_block, same rules in the same order). `params` are
 * the saved params plus the wired ports a rule reads (withWiredBlockers). */
export function directBlock(definition: RoutedDefinition, params: Record<string, unknown>): DirectBlock | null {
  return rulesBlock(definition, params, legacyRules(definition));
}

/** A route's rules plus the `accepts` its `valueMap` implies (node_route._route_rules). */
function routeRules(route: RouteSpec): RouteRules {
  const rules: RouteRules = { ...(route.rules ?? {}) };
  if (route.valueMap && Object.keys(route.valueMap).length) {
    const accepts = { ...(rules.accepts ?? {}) };
    for (const [key, mapped] of Object.entries(route.valueMap)) {
      if (!Object.hasOwn(accepts, key) && mapped && typeof mapped === 'object') {
        accepts[key] = { values: Object.keys(mapped) };
      }
    }
    rules.accepts = accepts;
  }
  return rules;
}

/** Whether `route` takes this one value of `key` on its own: its `accepts`
 * rule (which a `valueMap` implies) holds and its `rejects` doesn't list
 * it. What routeParamDefinitions narrows by, and what a provider switch
 * snaps (lib/providerSwitch.ts); rejectsWhen combinations aren't per value. */
export function routeTakesValue(route: RouteSpec, key: string, value: unknown): boolean {
  const rules = routeRules(route);
  const accepts = rules.accepts && Object.hasOwn(rules.accepts, key) ? rules.accepts[key] : undefined;
  if (accepts && !valueAccepted(value, accepts)) return false;
  const rejected = rules.rejects && Object.hasOwn(rules.rejects, key) ? rules.rejects[key] : undefined;
  return !(Array.isArray(rejected) && rejected.map(matchValue).includes(matchValue(value)));
}

/** The accepts rule `route` has for `key`, if any (its own or its valueMap's). */
export function routeAcceptRule(route: RouteSpec, key: string): DirectAcceptRule | undefined {
  const accepts = routeRules(route).accepts;
  return accepts && Object.hasOwn(accepts, key) ? accepts[key] : undefined;
}

/** Why `route` can't take a run with these params, or null when it can
 * (node_route.route_block). */
export function routeBlock(definition: RoutedDefinition, route: RouteSpec | undefined, params: Record<string, unknown>): DirectBlock | null {
  if (!route) return null;
  return rulesBlock(definition, params, routeRules(route));
}

export function directAllowed(definition: RoutedDefinition, params: Record<string, unknown>): boolean {
  return directBlock(definition, params) === null;
}

/** The saved `_provider`: a route id, or "auto" when it isn't set. */
export function providerChoice(params: Record<string, unknown> | undefined): string {
  const value = params?.[PROVIDER_PARAM];
  return value === undefined || value === null || value === '' ? AUTO : String(value);
}

function kreaMode(params: Record<string, unknown>): string {
  return params._kreaAuth ? String(params._kreaAuth) : 'api-token';
}

function takesPlan(route: RouteSpec, params: Record<string, unknown>): boolean {
  return route.plan === 'only' || (route.plan === 'optional' && kreaMode(params) === 'mcp');
}

/** The Krea route a route-table run bills to the plan, before its rules are
 * checked (node_route._plan_route): the chosen route, or under Auto the
 * maker route when it is Krea's. */
function planRoute(definition: RoutedDefinition, params: Record<string, unknown>): RouteSpec | undefined {
  const choice = providerChoice(params);
  const route = choice === AUTO ? makerRoute(definition) : routeById(definition, choice);
  return route?.plan && takesPlan(route, params) ? route : undefined;
}

/** A route-table run billed to the signed-in Krea plan: exactly when
 * selectRoute returns `plan` (node_route.uses_krea_plan), so `params` are
 * routed (withWiredBlockers): a wired input can block or unblock the plan
 * route. */
export function usesRoutePlan(definition: RoutedDefinition, params: Record<string, unknown> | undefined): boolean {
  const values = params ?? {};
  const route = planRoute(definition, values);
  return route !== undefined && routeBlock(definition, route, values) === null;
}

function setKeys(route: RouteSpec, apiKeys: ApiKeys): string[] {
  return keyList(route.keys).filter((key) => isSet(apiKeys, key));
}

function unionKeys(definition: RoutedDefinition): string[] {
  return [...new Set(routesOf(definition).flatMap((route) => keyList(route.keys)))];
}

function unset(provider: string | null | undefined, routeId: string | null, block: DirectBlock | null, missing: string[] = []): NodeRoute {
  return { kind: 'unset', provider: provider ?? null, key: null, routeId, block, missing };
}

/** selectRoute for a route-table node (node_route._select_from_routes). */
function selectFromRoutes(definition: RoutedDefinition, params: Record<string, unknown>, apiKeys: ApiKeys): NodeRoute {
  const routes = routesOf(definition);
  const first = routes[0]?.provider ?? definition.apiProvider;
  const choice = providerChoice(params);
  const plan = planRoute(definition, params);
  if (plan) {
    const block = routeBlock(definition, plan, params);
    if (block) return unset(plan.provider, plan.id, block);
    return { kind: 'plan', provider: 'krea', key: null, routeId: plan.id, block: null, missing: [] };
  }
  const keyed = (route: RouteSpec): NodeRoute => ({
    kind: route.maker ? 'direct' : 'fallback', provider: route.provider, key: setKeys(route, apiKeys)[0],
    routeId: route.id, block: null, missing: [],
  });
  if (choice !== AUTO) {
    const route = routeById(definition, choice);
    if (!route) return unset(first, null, { reason: 'unknown-provider', param: PROVIDER_PARAM, on: null, detail: choice });
    if (!setKeys(route, apiKeys).length) return unset(route.provider, route.id, null, keyList(route.keys));
    const block = routeBlock(definition, route, params);
    if (block) return unset(route.provider, route.id, block);
    return keyed(route);
  }
  const route = routes.find((candidate) => candidate.plan !== 'only' && setKeys(candidate, apiKeys).length > 0);
  if (!route) return unset(first, null, null, unionKeys(definition));
  // Auto never moves on: who bills depends on the choice and the keys.
  const block = routeBlock(definition, route, params);
  if (block) return unset(route.provider, route.id, block);
  return keyed(route);
}

/** The route a run of this node takes with these params and keys
 * (node_route.select_route, the same precedence). */
export function selectRoute(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): NodeRoute {
  const values = params ?? {};
  if (definition.apiProvider === 'utility') return { kind: 'local', provider: null, key: null };
  if (hasRoutes(definition)) return selectFromRoutes(definition, values, apiKeys);
  if (usesKreaAccount(definition, values)) return { kind: 'plan', provider: 'krea', key: null };
  const env = envKeyNames(definition);
  if (env.length < 2) return { kind: 'only', provider: definition.apiProvider, key: env[0] ?? null };
  const providerFor = (key: string) => (Object.hasOwn(KEY_PROVIDERS, key) ? KEY_PROVIDERS[key] : definition.apiProvider);
  if (directAllowed(definition, values)) {
    const key = configuredDirectKey(definition, apiKeys);
    if (key) return { kind: 'direct', provider: providerFor(key), key };
  }
  const key = fallbackKeyNames(definition).find((candidate) => isSet(apiKeys, candidate));
  if (key) return { kind: 'fallback', provider: providerFor(key), key };
  return { kind: 'unset', provider: definition.apiProvider, key: null };
}

/** The key under model_pricing.json `routes` that prices this route
 * (model_pricing.route_price_key): the route's `pricing` or id on a
 * route-table node, the provider on every other node. */
export function routePriceKey(definition: ModelNodeDefinition, route: NodeRoute): string | null {
  if (!hasRoutes(definition)) return route.provider;
  const spec = route.routeId ? routeById(definition, route.routeId) : undefined;
  return spec ? (spec.pricing ?? spec.id) : null;
}

/** The provider model or path a run on `route` calls: the first
 * endpointWhen entry whose `when` matches, else `endpoint`
 * (node_route.route_endpoint). */
export function routeEndpoint(definition: RoutedDefinition, route: RouteSpec, params: Record<string, unknown> | undefined): string | undefined {
  const values = params ?? {};
  for (const option of route.endpointWhen ?? []) {
    const entries = Object.entries(option.when ?? {});
    if (entries.length && entries.every(([key, want]) => matches(definition, values, key, want))) return option.endpoint;
  }
  return route.endpoint;
}

export function providerLabel(provider: string | null | undefined): string {
  return provider && Object.hasOwn(PROVIDER_LABELS, provider) ? PROVIDER_LABELS[provider as APIProvider] : (provider || 'provider');
}

function orList(items: string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function why(route: RouteSpec, block: DirectBlock): string {
  if (block.reason === 'unsupported') return `it doesn't take ${block.detail}`;
  if (block.reason === 'blocked') return `it doesn't take ${block.param}`;
  if (block.reason === 'requires') return `it needs ${block.param} set`;
  if (block.reason === 'size') return `it can't render that ${block.param} exactly`;
  if (block.reason === 'retired') return `the maker retired this model on ${block.on}`;
  if (block.reason === 'ports') {
    const most = route.rules?.ports?.[block.param ?? '']?.max;
    return most ? `it takes at most ${most} wired ${block.param}` : `it doesn't take wired ${block.param}`;
  }
  return String(block.detail ?? block.reason);
}

function acceptedValues(route: RouteSpec, block: DirectBlock): string[] {
  if (block.reason !== 'unsupported' || !block.param) return [];
  const rule = routeRules(route).accepts?.[block.param];
  return (rule?.values ?? []).map(matchValue);
}

/** Why a route-table run can't start, in the words the router, the engine's
 * preflight and the switcher use (node_route.route_unavailable_message). */
export function routeUnavailableMessage(definition: ModelNodeDefinition, route: NodeRoute, alternatives: string[] = []): string {
  const name = definition.displayName || definition.id || 'This node';
  const spec = route.routeId ? routeById(definition, route.routeId) : undefined;
  const others = alternatives.map((alt) => providerLabel(routeById(definition, alt)?.provider));
  const also = others.length ? ` ${orList(others)} can take it.` : '';
  const block = route.block;
  if (block?.reason === 'unknown-provider') {
    const ids = [AUTO, ...routesOf(definition).map((candidate) => candidate.id)];
    return `${name} is set to provider '${block.detail}', which it doesn't have. Choose ${orList(ids)}.`;
  }
  if (block && spec) {
    const values = acceptedValues(spec, block);
    const fix = values.length ? `Pick ${orList(values)}, or switch provider.`
      : block.reason === 'ports' ? 'Disconnect the extra inputs, or switch provider.'
        : 'Change that setting, or switch provider.';
    return `${name} can't run on ${providerLabel(spec.provider)}: ${why(spec, block)}. ${fix}${also}`;
  }
  const needed = route.missing?.length ? orList(route.missing) : 'a provider key';
  if (spec) {
    return `${name} is set to ${providerLabel(spec.provider)}, which needs ${needed}. `
      + `Add it in Settings > Providers or choose another provider.${also}`;
  }
  return `${name} needs ${needed} in Settings > Providers.`;
}

export interface RouteUnavailable {
  routeId: string | null;
  missing: string[];
  block: Partial<DirectBlock> | null;
  /** The other routes with a key set that can take the run: the one-click
   * switches. Auto never takes one by itself. */
  alternatives: string[];
  message: string;
}

/** A block as JSON, its set fields only (node_route.block_dict). */
export function blockFields(block: DirectBlock | null | undefined): Partial<DirectBlock> | null {
  if (!block) return null;
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== null && value !== undefined)) as Partial<DirectBlock>;
}

/** Why a route-table node can't run with these params and keys, or null when
 * it can and for every node without `routes` (node_route.route_unavailable).
 * `params` are routed (withWiredBlockers). */
export function routeUnavailable(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): RouteUnavailable | null {
  if (!hasRoutes(definition)) return null;
  const values = params ?? {};
  const route = selectRoute(definition, values, apiKeys);
  if (route.kind !== 'unset') return null;
  const alternatives = routesOf(definition)
    .filter((candidate) => candidate.id !== route.routeId && candidate.plan !== 'only'
      && setKeys(candidate, apiKeys).length > 0 && routeBlock(definition, candidate, values) === null)
    .map((candidate) => candidate.id);
  return {
    routeId: route.routeId ?? null,
    missing: route.missing ?? [],
    block: blockFields(route.block),
    alternatives,
    message: routeUnavailableMessage(definition, route, alternatives),
  };
}

/** `param` as one route offers it (node_route._narrowed): an enum's options
 * cut to the values the route takes (its `accepts`, which a `valueMap`
 * implies, and its `rejects`), a number's min/max narrowed to the route's
 * `accepts` range. A param the rules don't name comes back as it is.
 * rejectsWhen combinations stay a run-time block. */
function narrowed(param: ParamDefinition, rules: RouteRules): ParamDefinition {
  const accepts = rules.accepts && Object.hasOwn(rules.accepts, param.key) ? rules.accepts[param.key] : undefined;
  const rejected = rules.rejects && Object.hasOwn(rules.rejects, param.key) ? rules.rejects[param.key] : undefined;
  if (!accepts && !Array.isArray(rejected)) return param;
  const refused = Array.isArray(rejected) ? new Set(rejected.map(matchValue)) : null;
  if (Array.isArray(param.options) && param.options.length) {
    return {
      ...param,
      options: param.options.filter((option) => (!accepts || valueAccepted(option.value, accepts))
        && (!refused || !refused.has(matchValue(option.value)))),
    };
  }
  if (!accepts) return { ...param };
  const next: ParamDefinition = { ...param };
  if (typeof accepts.min === 'number') next.min = typeof param.min === 'number' ? Math.max(param.min, accepts.min) : accepts.min;
  if (typeof accepts.max === 'number') next.max = typeof param.max === 'number' ? Math.min(param.max, accepts.max) : accepts.max;
  return next;
}

/** The params a route shows and sends: sharedParams plus that route's own
 * group (directParams on the maker route, falParams on the fal or Krea copy
 * and on the Krea plan). Nodes without a split keep `params`. On a
 * route-table node `route` may be a route id (NodeRoute.routeId): its
 * sharedParams plus that route's params, each as the route offers it (an
 * enum cut to the values it takes, a number range narrowed to its own;
 * node_route.route_param_definitions), so a provider switch changes what
 * can be picked. `_provider` and `_kreaAuth` are the switcher's, never in
 * this list (node_route.route_param_keys). */
export function routeParamDefinitions(definition: ModelNodeDefinition, route: RouteKind | string | null | undefined): ParamDefinition[] {
  if (hasRoutes(definition)) {
    const spec = routeById(definition, route);
    const rules = spec ? routeRules(spec) : {};
    const byKey = new Map<string, ParamDefinition>();
    for (const param of [...(definition.sharedParams ?? []), ...(spec?.params ?? [])]) {
      if (param?.key) byKey.set(param.key, narrowed(param, rules));
    }
    return [...byKey.values()];
  }
  if (!definition.sharedParams) return definition.params;
  const kinds: readonly string[] = ['local', 'plan', 'only', 'direct', 'fallback', 'unset'];
  const direct = route === 'direct' || (!kinds.includes(String(route)) && makerRoute(definition)?.id === route);
  const group = direct ? (definition.directParams ?? []) : (definition.falParams ?? []);
  // Route selection should already make keys unique; keep this boundary so
  // malformed catalog data can never create duplicate controls.
  const byKey = new Map<string, ParamDefinition>();
  for (const param of [...definition.sharedParams, ...group]) byKey.set(param.key, param);
  return [...byKey.values()];
}

/** Whose options a route-table node shows (routeParamDefinitions;
 * node_route.shown_route_id): the chosen route; under Auto, the route Auto
 * resolves to with these keys (even when it can't take the run yet, so its
 * settings stay editable); with no key set, the maker's (else the first
 * route). Undefined for nodes without `routes`. */
export function shownRouteId(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): string | undefined {
  if (!hasRoutes(definition)) return undefined;
  const choice = providerChoice(params);
  if (choice !== AUTO && routeById(definition, choice)) return choice;
  const route = selectRoute(definition, params ?? {}, apiKeys);
  if (route.routeId) return route.routeId;
  return (makerRoute(definition) ?? routesOf(definition)[0])?.id;
}

/** A route-table node gets the provider switcher (components/nodes/ProviderSwitcher):
 * its definition lists `routes`, and its handler is the backend's
 * maker_routes.multi_route router, which reads `_provider`. The backend
 * registers that router for every route-table node
 * (route_clients.register_route_nodes, pinned by test_maker_routes.py), so
 * `routes` alone answers it here. Older dual-route nodes, and veo-3 and
 * Ideogram's hand routers, never show it. */
export function routeSwitch(definition: Pick<ModelNodeDefinition, 'routes'> | undefined): boolean {
  return hasRoutes(definition);
}

/** The params to show for a node's next run: its route's (routeParamDefinitions),
 * plus the one direct param the maker route still needs (DIRECT_REQUIRES) when
 * the maker key is set, so the person can opt in. Ideogram Reframe saved
 * without `resolution` (an agent-made node) would otherwise hide the only
 * control that moves it onto the person's Ideogram key. Create seeds that
 * param's default (as a new node always did); the Inspector passes
 * `seedOptIn: false` so it shows unset ("Choose…") until the person picks.
 * A route-table node shows the chosen or resolved route's params, even when
 * that route can't run yet, so they stay editable. */
export function paramDefinitionsForRun(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
  { seedOptIn = true }: { seedOptIn?: boolean } = {},
): ParamDefinition[] {
  const values = params ?? {};
  if (hasRoutes(definition)) return routeParamDefinitions(definition, shownRouteId(definition, values, apiKeys));
  const route = selectRoute(definition, values, apiKeys);
  const shown = routeParamDefinitions(definition, route.kind);
  const block = directBlock(definition, values);
  if (route.kind === 'direct' || block?.reason !== 'requires' || !block.param || !configuredDirectKey(definition, apiKeys)) {
    return shown;
  }
  const needed = definition.directParams?.find((param) => param.key === block.param);
  if (!needed) return shown;
  const optIn = seedOptIn ? needed : { ...needed, default: undefined, required: true };
  return [...shown.filter((param) => param.key !== needed.key), optIn];
}
