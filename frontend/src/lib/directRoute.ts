import type { APIProvider, ModelNodeDefinition, ParamDefinition } from '../types';
import { usesKreaAccount } from './kreaConnection';

/**
 * Which route one run of a node takes, and so which provider it bills.
 * The same rule as backend/services/node_route.py `select_route`; both are
 * tested against backend/tests/fixtures/route_cases.json.
 *
 * 1. `_kreaAuth == "mcp"` (or an account-only Krea node): the Krea plan. A
 *    maker key never overrides that explicit choice.
 * 2. a direct (maker) key is set: the maker's API.
 * 3. otherwise the first other key that is set (FAL_KEY, KREA_API_TOKEN).
 */

/** Which provider bills a run that uses this key (node_route.KEY_PROVIDERS). */
export const KEY_PROVIDERS: Readonly<Record<string, APIProvider>> = {
  OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', GOOGLE_API_KEY: 'google',
  GOOGLE_VERTEX_CREDENTIALS: 'google',
  OPENROUTER_API_KEY: 'openrouter', REPLICATE_API_TOKEN: 'replicate', FAL_KEY: 'fal',
  MESHY_API_KEY: 'meshy', RUNWAY_API_KEY: 'runway', ELEVENLABS_API_KEY: 'elevenlabs',
  MINIMAX_API_KEY: 'minimax', XAI_API_KEY: 'xai', HIGGSFIELD_API_KEY: 'higgsfield',
  QUIVER_API_KEY: 'quiver', KREA_API_TOKEN: 'krea', IDEOGRAM_API_KEY: 'ideogram',
  WORLDLABS_API_KEY: 'worldlabs',
};

/** A direct route that also needs a param set, else the run takes the fallback
 * (node_route.DIRECT_REQUIRES): Ideogram's direct reframe sizes by `resolution`. */
export const DIRECT_REQUIRES: Readonly<Record<string, string>> = { 'ideogram-reframe': 'resolution' };

export type RouteKind = 'local' | 'plan' | 'only' | 'direct' | 'fallback' | 'unset';

export interface NodeRoute {
  kind: RouteKind;
  provider: string | null;
  key: string | null;
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

/** Who runs a dual-route node without its maker key: 'fal' or 'krea'. */
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

export function directAllowed(definition: Pick<ModelNodeDefinition, 'id'>, params: Record<string, unknown>): boolean {
  const needed = Object.hasOwn(DIRECT_REQUIRES, definition.id) ? DIRECT_REQUIRES[definition.id] : undefined;
  return !needed || Boolean(params[needed]);
}

/** The route a run of this node takes with these params and keys. */
export function selectRoute(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
): NodeRoute {
  const values = params ?? {};
  if (definition.apiProvider === 'utility') return { kind: 'local', provider: null, key: null };
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

/** The params a route shows and sends: sharedParams plus that route's own
 * group (directParams on the maker route, falParams on the fal or Krea copy
 * and on the Krea plan). Nodes without a split keep `params`. */
export function routeParamDefinitions(definition: ModelNodeDefinition, kind: RouteKind): ParamDefinition[] {
  if (!definition.sharedParams) return definition.params;
  const group = kind === 'direct' ? (definition.directParams ?? []) : (definition.falParams ?? []);
  // Route selection should already make keys unique; keep this boundary so
  // malformed catalog data can never create duplicate controls.
  const byKey = new Map<string, ParamDefinition>();
  for (const param of [...definition.sharedParams, ...group]) byKey.set(param.key, param);
  return [...byKey.values()];
}
