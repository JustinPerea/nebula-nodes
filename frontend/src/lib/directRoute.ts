import type { APIProvider, ModelNodeDefinition, ParamDefinition } from '../types';
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

/** A direct route the maker shuts down on a date (node_route.DIRECT_RETIRES):
 * from that day the fal or Krea copy runs it. `param`/`values` narrow it to
 * the saved model choices that call the retiring model. gemini-2.5-flash-image:
 * "March 15, 2027" in Google's deprecations table (checked 2026-10-14). */
interface DirectRetirement { on: string; param?: string; values?: readonly string[] }
const GEMINI_25_FLASH_IMAGE_SHUTDOWN = '2027-03-15';
export const DIRECT_RETIRES: Readonly<Record<string, DirectRetirement>> = {
  'nano-banana-fal': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN, param: 'model', values: ['nano-banana', 'gemini-25-flash-image'] },
  'nano-banana-fal-edit': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN, param: 'model', values: ['nano-banana', 'gemini-25-flash-image'] },
  'krea-image-google-nano-banana': { on: GEMINI_25_FLASH_IMAGE_SHUTDOWN },
};

/** Why the direct route can't take a run (node_route.direct_block):
 * `requires` a direct param that isn't set (DIRECT_REQUIRES), `blocked` by a
 * copy-only param that is set (directRoute.blockedBy: a Krea copy's explicit
 * width/height), `unsupported` by a shared param's value the maker can't
 * render (directRoute.blockedWhen: Veo 3.1 Fast at 4K on Vertex), or
 * `retired` by the maker on `on` (DIRECT_RETIRES). */
export interface DirectBlock {
  reason: 'requires' | 'blocked' | 'unsupported' | 'retired';
  param: string | null;
  on: string | null;
}

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

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Today's local date as YYYY-MM-DD, as Python's date.today() reads it. */
function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A param's value as a run reads it: the saved value, else the definition default. */
function effectiveValue(definition: ModelNodeDefinition, params: Record<string, unknown>, key: string): unknown {
  if (hasValue(params[key])) return params[key];
  for (const group of [definition.sharedParams, definition.directParams, definition.falParams, definition.params]) {
    const param = group?.find((candidate) => candidate.key === key);
    if (param) return param.default;
  }
  return undefined;
}

/** Why the direct route can't take a run with these params, or null when it can. */
export function directBlock(definition: ModelNodeDefinition, params: Record<string, unknown>): DirectBlock | null {
  const needed = Object.hasOwn(DIRECT_REQUIRES, definition.id) ? DIRECT_REQUIRES[definition.id] : undefined;
  if (needed && !params[needed]) return { reason: 'requires', param: needed, on: null };
  for (const key of definition.directRoute?.blockedBy ?? []) {
    if (hasValue(params[key])) return { reason: 'blocked', param: key, on: null };
  }
  for (const [key, unsupported] of Object.entries(definition.directRoute?.blockedWhen ?? {})) {
    if (unsupported.includes(effectiveValue(definition, params, key) as string | number | boolean)) {
      return { reason: 'unsupported', param: key, on: null };
    }
  }
  const retires = Object.hasOwn(DIRECT_RETIRES, definition.id) ? DIRECT_RETIRES[definition.id] : undefined;
  if (retires && todayIso() >= retires.on) {
    const value = retires.param ? effectiveValue(definition, params, retires.param) : undefined;
    if (!retires.param || (retires.values ?? []).includes(value as string)) {
      return { reason: 'retired', param: retires.param ?? null, on: retires.on };
    }
  }
  return null;
}

export function directAllowed(definition: ModelNodeDefinition, params: Record<string, unknown>): boolean {
  return directBlock(definition, params) === null;
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

/** The params to show for a node's next run: its route's (routeParamDefinitions),
 * plus the one direct param the maker route still needs (DIRECT_REQUIRES) when
 * the maker key is set, so the person can opt in. Ideogram Reframe saved
 * without `resolution` (an agent-made node) would otherwise hide the only
 * control that moves it onto the person's Ideogram key. Create seeds that
 * param's default (as a new node always did); the Inspector passes
 * `seedOptIn: false` so it shows unset ("Choose…") until the person picks. */
export function paramDefinitionsForRun(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  apiKeys: ApiKeys,
  { seedOptIn = true }: { seedOptIn?: boolean } = {},
): ParamDefinition[] {
  const values = params ?? {};
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
