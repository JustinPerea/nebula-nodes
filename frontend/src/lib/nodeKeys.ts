import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, ProviderVia } from '../types';
import { allParamDefinitions } from './directRoute';

/**
 * What a node needs to run, for the utility nodes that still call a provider
 * (`providerVia` on the definition). One rule for the canvas badge
 * (kreaConnection.nodeKeyStatus), the readiness line (providerReadiness) and
 * the run estimate (runScope). Mirrors backend services/node_readiness.py;
 * the backend's handler constants stay the boundary, and a backend test pins
 * the definitions to them.
 */

type Definitions = Record<string, ModelNodeDefinition>;
type Params = Record<string, unknown>;

function paramDefault(def: ModelNodeDefinition, key: string): unknown {
  return allParamDefinitions(def).find((candidate) => candidate.key === key)?.default;
}

/** For a `param` node: whether these params pick the provider work. An absent
 * param is the definition's default (the handler's own); any other value that
 * isn't exactly one of `freeWhen`, including '' and null, calls the provider.
 * Fail closed: the handler refuses such a value anyway. */
export function paramCallsProvider(def: ModelNodeDefinition, params: Params | undefined): boolean {
  const via = def.providerVia;
  if (via?.kind !== 'param') return false;
  const given = params ?? {};
  const value = given[via.param] === undefined ? paramDefault(def, via.param) : given[via.param];
  return !(typeof value === 'string' && via.freeWhen.includes(value));
}

/** The value a `param` node's params pick: the param, or its default. */
export function paramValue(def: ModelNodeDefinition, params: Params | undefined): unknown {
  const via = def.providerVia;
  if (via?.kind !== 'param') return undefined;
  const given = params ?? {};
  return given[via.param] === undefined ? paramDefault(def, via.param) : given[via.param];
}

/** The keys and provider one value of a `param` node calls: its `byValue`
 * entry, else the node's `anyKey` / `provider`. Mirrors param_route in
 * backend services/node_readiness.py. */
export function paramRoute(via: Extract<ProviderVia, { kind: 'param' }>, value: unknown): { anyKey: string[]; provider: string } {
  const own = typeof value === 'string' && via.byValue && Object.hasOwn(via.byValue, value) ? via.byValue[value] : undefined;
  return own ?? { anyKey: via.anyKey, provider: via.provider };
}

/** For a `model` node: the model these params run, normalized the way the
 * handler guard does (an empty or fallback value runs the default), or null
 * when the value can't be read or isn't one of its models. A missing level
 * reads as empty, so a fresh node runs the default. */
export function modelChoice(def: ModelNodeDefinition, params: Params | undefined): string | null {
  const via = def.providerVia;
  if (via?.kind !== 'model' || via.path.length === 0) return null;
  let node: unknown = params ?? {};
  for (const [depth, part] of via.path.entries()) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    node = (node as Params)[part];
    if (depth < via.path.length - 1 && !node) node = {};
  }
  const chosen = String(node ?? '').trim().toLowerCase();
  const model = !chosen || via.fallbackFor.some((value) => value.toLowerCase() === chosen) ? via.default : chosen;
  return via.models.includes(model) ? model : null;
}

/** A node whose run bills nobody, with these params. */
export function isLocalRun(def: ModelNodeDefinition, params: Params | undefined): boolean {
  if (def.apiProvider !== 'utility') return false;
  const via = def.providerVia;
  if (!via) return true;
  return via.kind === 'param' && !paramCallsProvider(def, params);
}

export interface KeyNeed {
  /** The definition whose keys apply: the node itself, the model it runs, or
   * a stand-in carrying a param node's keys. */
  definition: ModelNodeDefinition;
  params: Params;
  /** What the badge names, e.g. "base seedream-4-5" or "mode vision-llm". */
  reason?: string;
}

/** What this node, with these params, needs: [] when it runs locally, null
 * when it can't be read (fail closed: the badge says something is missing). */
export function keysNeeded(def: ModelNodeDefinition, params: Params | undefined, defs: Definitions = NODE_DEFINITIONS): KeyNeed[] | null {
  const via: ProviderVia | undefined = def.providerVia;
  if (!via) return [{ definition: def, params: params ?? {} }];
  if (via.kind === 'param') {
    if (!paramCallsProvider(def, params)) return [];
    const value = paramValue(def, params);
    const route = paramRoute(via, value);
    return [{ definition: { ...def, envKeyName: route.anyKey, providerVia: undefined }, params: {}, reason: `${via.param} ${String(value)}` }];
  }
  const model = modelChoice(def, params);
  const target = model ? defs[model] : undefined;
  return target ? [{ definition: target, params: {}, reason: `base ${model}` }] : null;
}

function keyNames(def: ModelNodeDefinition): string[] {
  return (Array.isArray(def.envKeyName) ? def.envKeyName : [def.envKeyName]).filter(Boolean);
}

/** The missing-key badge's title: which keys, and for what. */
export function missingKeyTitle(def: ModelNodeDefinition, params: Params | undefined, defs: Definitions = NODE_DEFINITIONS): string {
  const needs = keysNeeded(def, params, defs);
  if (needs === null) return 'Scene base model unavailable: choose a supported one in the Studio';
  const parts = needs.filter((need) => keyNames(need.definition).length)
    .map((need) => `${keyNames(need.definition).join(' or ')}${need.reason ? ` for ${need.reason}` : ''}`);
  return parts.length ? `Needs ${parts.join('; ')}` : 'API Key Missing';
}

/** The model a cinema scene's run calls, the params it sends, and its shot
 * count; null when the scene can't be read or its base would be refused.
 * Mirrors cinema_scene_base in backend services/model_pricing.py (which
 * uses the handler's own guard), reading the allowlist from the definition. */
// How the handler's request builder sends the scene's aspect ratio to each base.
const SEEDREAM_BASE = 'seedream-4-5';
const SNAKE_ASPECT_BASES = new Set(['nano-banana', 'nano-banana-fal-edit', 'flux-kontext']);

export function cinemaSceneBase(
  params: Params,
  def: ModelNodeDefinition = NODE_DEFINITIONS['cinema-scene'],
): { model: string; params: Params; shots: number } | null {
  const via = def.providerVia;
  if (via?.kind !== 'model') return null;
  const scene = params.scene;
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return null;
  const { base: rawBase, shots, aspectRatio } = scene as Params;
  const base = rawBase ?? {};
  if (typeof base !== 'object' || Array.isArray(base)) return null;
  const model = modelChoice(def, params);
  if (!model) return null;
  const extra = { ...((base as Params).params as Params | undefined ?? {}) };
  // The backend also derives Seedream's image_size; no price row matches on it.
  const sent = model === SEEDREAM_BASE
    ? extra
    : { [SNAKE_ASPECT_BASES.has(model) ? 'aspect_ratio' : 'aspectRatio']: String(aspectRatio || '16:9'), ...extra };
  const count = Array.isArray(shots)
    ? shots.filter((shot) => shot !== null && typeof shot === 'object' && !Array.isArray(shot)).length
    : 0;
  return { model, params: sent, shots: count };
}
