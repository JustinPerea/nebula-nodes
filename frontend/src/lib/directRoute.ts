import type {
  APIProvider, DirectAcceptRule, DirectSizeLimits, ModelNodeDefinition, ParamDefinition, RoutePortLimit, RouteRules,
  RouteSpec,
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
   * rules.ports), `unknown-provider` (`_provider` names no route) and
   * `hidden` (a saved value of a setting this route doesn't show, that
   * another route honors: rule H, hiddenBlock). */
  reason: 'requires' | 'blocked' | 'unsupported' | 'size' | 'retired' | 'ports' | 'unknown-provider' | 'hidden';
  param: string | null;
  /** `retired`: the shutdown date. `hidden`: the route that would honor the value. */
  on: string | null;
  /** `unsupported`: what the maker doesn't take, the param and its value
   * ("resolution 4K") or a rejectsWhen rule's label. `hidden`: the setting
   * and its value as the card shows them ("Safety 5"). */
  detail?: string;
  /** `hidden`: the settings that hide it on this route, as the card shows
   * them ("Model FLUX.2 [klein] 9B"); absent when the route never offers it. */
  when?: string;
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

/** The input ports one `ports` entry counts: its `of` list for a group,
 * else the port it is keyed by (node_route._limit_ports). */
function limitPorts(port: string, limit: RoutePortLimit | undefined): string[] {
  return Array.isArray(limit?.of) ? limit.of.map(String) : [port];
}

/** How many inputs one `ports` entry counts: the sum over its ports
 * (node_route.port_limit_count). FLUX 3 Video's providers take at most ten
 * images in all, start image, keyframes and end image together. */
export function portLimitCount(port: string, limit: RoutePortLimit | undefined, counts: Record<string, number>): number {
  return limitPorts(port, limit).reduce((sum, name) => sum + (typeof counts[name] === 'number' ? counts[name] : 0), 0);
}

/** How a message names one `ports` entry: its `label`, else its key
 * (node_route.port_limit_name). */
export function portLimitName(port: string, limit: RoutePortLimit | undefined): string {
  return typeof limit?.label === 'string' && limit.label ? limit.label : port;
}

/** The ports a route's `ports` rule counts (route-table nodes only). */
function countedPorts(definition: Pick<ModelNodeDefinition, 'directRoute' | 'routes'>): Set<string> {
  if (!hasRoutes(definition)) return new Set();
  return new Set(ruleSets(definition).flatMap((rules) =>
    Object.entries(rules.ports ?? {}).flatMap(([port, limit]) => limitPorts(port, limit))));
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
    const count = portLimitCount(port, limit, counts);
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
 * (node_route.route_block): its rules, then on a route-table node rule H
 * (hiddenBlock), so a rule's own reason always wins. */
export function routeBlock(definition: RoutedDefinition, route: RouteSpec | undefined, params: Record<string, unknown>): DirectBlock | null {
  if (!route) return null;
  if (!hasRoutes(definition) || route.id === undefined) return rulesBlock(definition, params, routeRules(route));
  return shownRulesBlock(definition, route, params) ?? hiddenBlock(definition, route, params);
}

/** A route-table route's rules over the values it would send: a setting in
 * its list that it hides with these values is read at its default, since it
 * is never sent (node_route._shown_rules_block). */
function shownRulesBlock(definition: RoutedDefinition, route: RouteSpec, params: Record<string, unknown>): DirectBlock | null {
  const full = definition as ModelNodeDefinition;
  const sent = routeSentKeys(full, route.id, params);
  const hidden = routeParamDefinitions(full, route.id).map((param) => param.key).filter((key) => !sent.has(key));
  const shown = hidden.length ? Object.fromEntries(Object.entries(params).filter(([key]) => !hidden.includes(key))) : params;
  return rulesBlock(definition, shown, routeRules(route));
}

type VisibleWhen = Record<string, (string | number | boolean)[]>;

/** A route's `paramVisibleWhen` (empty when it has none). */
export function routeVisibleWhen(route: RouteSpec | undefined): NonNullable<RouteSpec['paramVisibleWhen']> {
  return route?.paramVisibleWhen && typeof route.paramVisibleWhen === 'object' ? route.paramVisibleWhen : {};
}

/** A param's `visibleWhen` ANDed with a route's condition for it: the
 * controllers unioned, and where both name one, the values both allow (in
 * the param's order) (node_route.merge_visible_when). */
export function mergeVisibleWhen(own: VisibleWhen | undefined, route: VisibleWhen | undefined): VisibleWhen {
  const merged: VisibleWhen = Object.fromEntries(Object.entries(own ?? {}).map(([key, values]) => [key, [...values]]));
  for (const [key, values] of Object.entries(route ?? {})) {
    if (Object.hasOwn(merged, key)) {
      const allowed = new Set(values.map(matchValue));
      merged[key] = merged[key].filter((value) => allowed.has(matchValue(value)));
    } else {
      merged[key] = [...values];
    }
  }
  return merged;
}

/** Whether a `visibleWhen` holds for these values (saved over defaults,
 * effectiveValues). A controller with no value passes, and on a route-table
 * node (`routeKeys` given) so does a controller that only another route
 * takes: it counts as absent whatever is still saved for it. Values compare
 * by matchValue (node_route.visible_when_holds). */
export function visibleWhenHolds(
  visibleWhen: VisibleWhen | undefined, values: Record<string, unknown>, routeKeys?: Iterable<string>,
): boolean {
  if (!visibleWhen) return true;
  const listed = routeKeys ? new Set(routeKeys) : null;
  return Object.entries(visibleWhen).every(([key, allowed]) => {
    if (listed && !listed.has(key)) return true;
    const value = values[key];
    if (value === undefined || value === null) return true;
    return allowed.map(matchValue).includes(matchValue(value));
  });
}

/** Whether a param is shown (and so sent) for these values: its
 * `visibleWhen` (on a route-table node, merged with the route's
 * `paramVisibleWhen` by routeParamDefinitions) holds. The one predicate the
 * Inspector, Create's pills, routeSentKeys and rule H read
 * (node_route.param_shown). `hidden` (editor-managed) params are separate:
 * they are sent, never edited. */
export function paramShown(param: Pick<ParamDefinition, 'visibleWhen'>, values: Record<string, unknown>, routeKeys?: Iterable<string>): boolean {
  return visibleWhenHolds(param.visibleWhen, values, routeKeys);
}

/** The values a node's controls are shown against: on a route-table node,
 * effectiveValues (saved over every default); on any other node, the saved
 * values over the defaults of the params `shown` lists, as the Inspector
 * always read them. */
export function shownValues(definition: RoutedDefinition, params: Record<string, unknown> | undefined, shown: readonly ParamDefinition[]): Record<string, unknown> {
  if (hasRoutes(definition)) return effectiveValues(definition, params);
  const values: Record<string, unknown> = Object.fromEntries(shown.filter((param) => param.default !== undefined)
    .map((param) => [param.key, param.default]));
  for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null) values[key] = value;
  return values;
}

/** The controls a node shows for these values, out of `shown` (its route's
 * list, paramDefinitionsForRun): not editor-managed (`hidden`), and
 * paramShown with shownValues; on a route-table node a controller only
 * another route takes counts as absent. The Inspector and Create's pills
 * both read this, so they can't disagree. */
export function visibleParams(definition: RoutedDefinition, params: Record<string, unknown> | undefined, shown: readonly ParamDefinition[]): ParamDefinition[] {
  const values = shownValues(definition, params, shown);
  const routeKeys = hasRoutes(definition) ? shown.map((param) => param.key) : undefined;
  return shown.filter((param) => !param.hidden && paramShown(param, values, routeKeys));
}

/** `params` with every unset param (undefined, null, "" or blank) at its
 * default, as a run reads them. Other keys (wired markers) are kept
 * (node_route.effective_values). */
export function effectiveValues(definition: RoutedDefinition, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = { ...(params ?? {}) };
  for (const param of allParamDefinitions(definition)) {
    if (!hasValue(values[param.key]) && param.default !== undefined && param.default !== null) values[param.key] = param.default;
  }
  return values;
}

/** The params a run on `route` sends with these values: the route's list
 * less each one paramShown hides (its own `visibleWhen`, or the route's
 * `paramVisibleWhen`); nodes without `routes` send their route's list
 * unchanged (node_route.route_sent_keys). */
export function routeSentKeys(definition: ModelNodeDefinition, route: RouteKind | string | null | undefined, params: Record<string, unknown> | undefined): Set<string> {
  const offered = routeParamDefinitions(definition, route);
  if (!hasRoutes(definition)) return new Set(offered.map((param) => param.key));
  const listed = offered.map((param) => param.key);
  const values = effectiveValues(definition, params);
  return new Set(offered.filter((param) => paramShown(param, values, listed)).map((param) => param.key));
}

function optionLabelOf(param: ParamDefinition | undefined, value: unknown): string {
  const option = param?.options?.find((candidate) => matchValue(candidate.value) === matchValue(value));
  return option?.label ?? matchValue(value);
}

/** A setting and its value as the card shows them: "Safety 5", "Seed 42",
 * "Grounding off", "Draft (fast preview)" (a switch that is on), or just the
 * label for text (node_route._setting_text). */
export function settingText(param: ParamDefinition | undefined, key: string, value: unknown): string {
  const label = param?.label || key;
  if (Array.isArray(param?.options) && param.options.length) return `${label} ${optionLabelOf(param, value)}`;
  if (typeof value === 'boolean') return value ? label : `${label} off`;
  if (typeof value === 'number') return `${label} ${matchValue(value)}`;
  return label;
}

/** One saved value rule H stops a route on: the param, the route that would
 * honor it, and the controllers that hide it here (node_route.HiddenStop). */
export interface HiddenStop { param: string; honoredBy: string; controllers: string[] }

/** Every saved value rule H stops `route` on (node_route.hidden_stops): a
 * param the route doesn't show with these values whose saved value is set
 * and isn't its default, that some other route shows with these values,
 * takes on its own (routeTakesValue), whose rules don't block these values
 * (keys don't matter), and which isn't itself stopped by a hidden value one
 * level down (there only its rules are read), leaving out what it hides only
 * because of this very value (BFL hides Resolution under the Draft it
 * honors). Any other hidden value is ignored. */
export function hiddenStops(definition: RoutedDefinition, route: RouteSpec, params: Record<string, unknown>, depth = 0): HiddenStop[] {
  if (!hasRoutes(definition)) return [];
  const full = definition as ModelNodeDefinition;
  const sent = routeSentKeys(full, route.id, params);
  const others = routesOf(definition).filter((spec) => spec.id !== route.id);
  const offered = new Map(routeParamDefinitions(full, route.id).map((param) => [param.key, param]));
  const effective = effectiveValues(definition, params);
  const stops: HiddenStop[] = [];
  for (const param of allParamDefinitions(definition)) {
    if (BILLING_PARAMS.includes(param.key) || sent.has(param.key)) continue;
    const value = params[param.key];
    if (!hasValue(value) || value === WIRED) continue;
    if (param.default !== undefined && param.default !== null && matchValue(value) === matchValue(param.default)) continue;
    const honored = others.find((spec) => routeSentKeys(full, spec.id, params).has(param.key)
      && routeTakesValue(spec, param.key, value) && shownRulesBlock(definition, spec, params) === null
      && (depth > 0 || hiddenStops(definition, spec, params, depth + 1)
        .every((stop) => stop.controllers.includes(param.key))));
    if (!honored) continue;
    const condition = offered.get(param.key)?.visibleWhen ?? {};
    const controllers = Object.keys(condition).filter((ctrl) => offered.has(ctrl)
      && !visibleWhenHolds({ [ctrl]: condition[ctrl] }, effective));
    stops.push({ param: param.key, honoredBy: honored.id, controllers });
  }
  return stops;
}

/** The first of hiddenStops as a `hidden` block (node_route.hidden_block). */
export function hiddenBlock(definition: RoutedDefinition, route: RouteSpec, params: Record<string, unknown>): DirectBlock | null {
  const stop = hiddenStops(definition, route, params)[0];
  if (!stop) return null;
  const effective = effectiveValues(definition, params);
  const defs = new Map(allParamDefinitions(definition).map((param) => [param.key, param]));
  const when = stop.controllers.map((ctrl) => settingText(defs.get(ctrl), ctrl, effective[ctrl])).join(' and ');
  const block: DirectBlock = { reason: 'hidden', param: stop.param, on: stop.honoredBy,
    detail: settingText(defs.get(stop.param), stop.param, params[stop.param]) };
  if (when) block.when = when;
  return block;
}

/** The one-click fix for a `hidden` stop: the param back to its default
 * (`value` null: cleared when it has none) (node_route.hidden_fix). */
export interface RouteFix { param: string; value: unknown }
export function hiddenFix(definition: RoutedDefinition, param: string): RouteFix {
  const def = allParamDefinitions(definition).find((candidate) => candidate.key === param);
  return { param, value: def?.default ?? null };
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
  if (block.reason === 'hidden') return `it doesn't offer ${block.detail}${block.when ? ` with ${block.when}` : ''}`;
  if (block.reason === 'unsupported') return `it doesn't take ${block.detail}`;
  if (block.reason === 'blocked') return `it doesn't take ${block.param}`;
  if (block.reason === 'requires') return `it needs ${block.param} set`;
  if (block.reason === 'size') return `it can't render that ${block.param} exactly`;
  if (block.reason === 'retired') return `the maker retired this model on ${block.on}`;
  if (block.reason === 'ports') {
    const limit = route.rules?.ports?.[block.param ?? ''];
    const name = portLimitName(block.param ?? '', limit);
    return limit?.max ? `it takes at most ${limit.max} wired ${name}` : `it doesn't take wired ${name}`;
  }
  return String(block.detail ?? block.reason);
}

function acceptedValues(route: RouteSpec, block: DirectBlock): string[] {
  if (block.reason !== 'unsupported' || !block.param) return [];
  const rule = routeRules(route).accepts?.[block.param];
  return (rule?.values ?? []).map(matchValue);
}

/** How a `hidden` stop is fixed without a switch: the setting back to its
 * default, or cleared when it has none (node_route._hidden_fix_sentence). */
function hiddenFixSentence(definition: ModelNodeDefinition, param: string): string {
  const spec = allParamDefinitions(definition).find((candidate) => candidate.key === param);
  const label = spec?.label || param;
  const fallback = spec?.default;
  if (fallback === undefined || fallback === null) return `Clear ${label}, or switch provider.`;
  if (typeof fallback === 'boolean') return `Turn ${label} ${fallback ? 'on' : 'off'}, or switch provider.`;
  return `Set ${label} back to ${optionLabelOf(spec, fallback)}, or switch provider.`;
}

/** Why a route-table run can't start, in the words the router, the engine's
 * preflight and the switcher use (node_route.route_unavailable_message).
 * `keyless` are routes that would take the run but have no key set: a
 * `hidden` stop with no alternative names them. */
export function routeUnavailableMessage(definition: ModelNodeDefinition, route: NodeRoute, alternatives: string[] = [], keyless: string[] = []): string {
  const name = definition.displayName || definition.id || 'This node';
  const spec = route.routeId ? routeById(definition, route.routeId) : undefined;
  const others = alternatives.map((alt) => providerLabel(routeById(definition, alt)?.provider));
  const keylessLabels = keyless.map((alt) => providerLabel(routeById(definition, alt)?.provider));
  const also = others.length ? ` ${orList(others)} can take it.`
    : keylessLabels.length ? ` ${orList(keylessLabels)} can take it (add its key in Settings > Providers).` : '';
  const block = route.block;
  if (block?.reason === 'unknown-provider') {
    const ids = [AUTO, ...routesOf(definition).map((candidate) => candidate.id)];
    return `${name} is set to provider '${block.detail}', which it doesn't have. Choose ${orList(ids)}.`;
  }
  if (block && spec) {
    const values = acceptedValues(spec, block);
    const fix = block.reason === 'hidden' ? hiddenFixSentence(definition, block.param ?? '')
      : values.length ? `Pick ${orList(values)}, or switch provider.`
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
  /** One-click param edits that let it run where it is (`value` null:
   * clear): a `hidden` stop's setting back to its default, else none. */
  fixes: RouteFix[];
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
  const hidden = route.block?.reason === 'hidden';
  const honoredBy = hidden ? route.block?.on : null;
  const honoredSpec = honoredBy ? routeById(definition, honoredBy) : undefined;
  const keyless = hidden && !alternatives.length && honoredBy && honoredSpec && !setKeys(honoredSpec, apiKeys).length
    ? [honoredBy] : [];
  return {
    routeId: route.routeId ?? null,
    missing: route.missing ?? [],
    block: blockFields(route.block),
    alternatives,
    fixes: hidden ? [hiddenFix(definition, route.block?.param ?? '')] : [],
    message: routeUnavailableMessage(definition, route, alternatives, keyless),
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
 * can be picked. A param the route's `paramVisibleWhen` marks `false` is
 * left out, and a condition there is merged into the param's own
 * `visibleWhen` (mergeVisibleWhen), so every reader hides it the same way
 * (paramShown). `_provider` and `_kreaAuth` are the switcher's, never in
 * this list (node_route.route_param_keys). */
export function routeParamDefinitions(definition: ModelNodeDefinition, route: RouteKind | string | null | undefined): ParamDefinition[] {
  if (hasRoutes(definition)) {
    const spec = routeById(definition, route);
    const rules = spec ? routeRules(spec) : {};
    const conditions = routeVisibleWhen(spec);
    const byKey = new Map<string, ParamDefinition>();
    for (const param of [...(definition.sharedParams ?? []), ...(spec?.params ?? [])]) {
      if (!param?.key) continue;
      const condition = Object.hasOwn(conditions, param.key) ? conditions[param.key] : undefined;
      if (condition === false) continue;
      const offered = narrowed(param, rules);
      byKey.set(param.key, condition ? { ...offered, visibleWhen: mergeVisibleWhen(offered.visibleWhen, condition) } : offered);
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
