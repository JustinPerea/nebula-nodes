import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../types';
import { supportsKreaAccount, usesKreaAccount, type CredentialReadiness } from './kreaConnection';
import {
  directBlock, directKeyNames, fallbackKeyNames, isKeylessRoute, KEY_PROVIDERS, routeById, selectRoute,
  type DirectBlock, type NodeRoute,
} from './directRoute';
import { modelChoice, paramCallsProvider, paramRoute, paramValue } from './nodeKeys';

export type ProviderSetupTarget =
  | { kind: 'api-key'; key: string }
  | { kind: 'krea-mcp' }
  | { kind: 'external'; provider: 'nous' };

export type ProviderHealthStatus = 'not_configured' | 'configured_unverified' | 'valid'
  | 'invalid' | 'unauthorized' | 'insufficient_credits' | 'rate_limited' | 'error';
export interface ProviderHealthEntry {
  configured: boolean;
  status: ProviderHealthStatus;
  last_checked: string;
}
export interface ProviderHealthState {
  providers: Record<string, ProviderHealthEntry>;
  checkedAt: number | null;
  loading: boolean;
  error: string | null;
}
export interface ModelReadiness {
  label: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning';
  setupTarget?: ProviderSetupTarget;
  connectionLabel?: string;
  /** Muted words after the connection label ("Optional", GM PR #203 r1). */
  connectionNote?: string;
}

export const PROVIDER_HEALTH_TTL_MS = 5 * 60 * 1000;
export const PROVIDER_KEY_LABELS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'OpenAI', ANTHROPIC_API_KEY: 'Anthropic', GOOGLE_API_KEY: 'Google',
  GOOGLE_VERTEX_CREDENTIALS: 'Google Vertex',
  OPENROUTER_API_KEY: 'OpenRouter', REPLICATE_API_TOKEN: 'Replicate', FAL_KEY: 'FAL',
  MESHY_API_KEY: 'Meshy', RUNWAY_API_KEY: 'Runway', ELEVENLABS_API_KEY: 'ElevenLabs',
  MINIMAX_API_KEY: 'MiniMax', XAI_API_KEY: 'xAI', HIGGSFIELD_API_KEY: 'Higgsfield',
  QUIVER_API_KEY: 'QuiverAI', KREA_API_TOKEN: 'Krea', KREA_USAGE_KEY: 'Krea usage', IDEOGRAM_API_KEY: 'Ideogram',
  WORLDLABS_API_KEY: 'World Labs', TYPESAFE_API_KEY: 'TypeSafe', BYTEPLUS_API_KEY: 'BytePlus',
  BFL_API_KEY: 'Black Forest Labs', HF_TOKEN: 'Hugging Face',
};

export function providerCheckIsCurrent(entry: ProviderHealthEntry | undefined, completedAt: number | null, now = Date.now()): entry is ProviderHealthEntry {
  if (!entry || completedAt === null || !Number.isFinite(completedAt)) return false;
  const checkedAt = Date.parse(entry.last_checked);
  return Number.isFinite(checkedAt) && checkedAt <= now && completedAt <= now
    && now - Math.min(checkedAt, completedAt) < PROVIDER_HEALTH_TTL_MS;
}

/** Verification concerns the selected credential, never model entitlement or a paid run. */
function checkedReadiness(provider: string, target: ProviderSetupTarget, health: ProviderHealthState): ModelReadiness | undefined {
  const entry = health.providers[provider];
  if (!providerCheckIsCurrent(entry, health.checkedAt)) return undefined;
  const base = { setupTarget: target };
  switch (entry.status) {
    case 'valid': return entry.configured ? { ...base, label: 'Verified credential', tone: 'success',
      detail: `${provider} accepted the credential check. Model access, available credits and generation are checked separately.` } : undefined;
    case 'configured_unverified': return { ...base, label: 'Configured · not checked', tone: 'neutral',
      detail: `${provider} is configured. No safe credential check is available; generation was not used to test it.` };
    case 'not_configured': return { ...base, label: 'Setup required', tone: 'warning',
      detail: `${provider} is not configured. Open setup to connect it.` };
    case 'invalid': return { ...base, label: 'Credential rejected', tone: 'warning',
      detail: `${provider} rejected the saved credential. Update it in setup before running.` };
    case 'unauthorized': return { ...base, label: 'Authorization required', tone: 'warning',
      detail: `${provider} denied access to the credential check. Review the account's API access in setup.` };
    case 'insufficient_credits': return { ...base, label: 'Credits required', tone: 'warning',
      detail: `${provider} reported insufficient credits during the check. Review the provider account before running.` };
    case 'rate_limited': return { ...base, label: 'Check rate limited', tone: 'warning',
      detail: `${provider} limited the credential check. Try Check connections again later.` };
    case 'error': return { ...base, label: 'Check unavailable', tone: 'warning',
      detail: `Couldn't check ${provider}. The saved connection is unchanged. Use Check connections to try again.` };
  }
}

export function keyReadiness(key: string, cache: CredentialReadiness, health: ProviderHealthState): ModelReadiness {
  const target: ProviderSetupTarget = { kind: 'api-key', key };
  const provider = PROVIDER_KEY_LABELS[key] ?? key;
  if (!cache.loaded) return { label: 'Connection not loaded', detail: 'Saved connection settings have not loaded yet.', tone: 'neutral', setupTarget: target };
  if (!cache.apiKeys[key]?.trim()) return { label: 'Setup required',
    detail: `Add a ${provider} API credential in Settings. You can browse and add models before connecting.`, tone: 'warning', setupTarget: target };
  if (health.loading) return { label: 'Checking connection', tone: 'neutral', setupTarget: target,
    detail: `${provider} saved credential is being checked without generating.` };
  const checked = checkedReadiness(provider, target, health);
  if (checked) return checked;
  return { label: health.error ? 'Check unavailable' : 'Configured · not checked', tone: health.error ? 'warning' : 'neutral',
    detail: health.error ? `${provider} is configured, but Nebula couldn't check the connections. Use Check connections to try again.`
      : `${provider} API credential is saved. Use Check connections to verify it without generating.`, setupTarget: target };
}

export function modelReadiness(def: ModelNodeDefinition, params: Record<string, unknown>, cache: CredentialReadiness, health: ProviderHealthState): ModelReadiness {
  if (usesKreaAccount(def, params)) {
    const setupTarget: ProviderSetupTarget = { kind: 'krea-mcp' };
    const status = cache.kreaConnection?.status;
    if (!status) return { label: 'Connection not loaded', tone: 'neutral', setupTarget, connectionLabel: 'Krea sign-in',
      detail: 'The saved Krea sign-in status has not loaded yet. This recipe keeps its Krea workspace billing connection.' };
    if (status === 'connected') return { label: 'Krea signed in', tone: 'neutral', setupTarget, connectionLabel: 'Krea sign-in',
      detail: 'Uses the signed-in Krea workspace and its compute units. This model is checked against that account when you explicitly run it.' };
    return { label: status === 'connecting' ? 'Finish Krea sign-in' : status === 'error' ? 'Connection unavailable' : 'Krea sign-in required',
      tone: 'warning', setupTarget, connectionLabel: 'Krea sign-in', detail: 'This recipe uses Krea sign-in. Connect or check Krea in Settings; an API token does not replace this connection.' };
  }
  if (def.apiProvider === 'nous') {
    const target: ProviderSetupTarget = { kind: 'external', provider: 'nous' };
    const ready: ModelReadiness = health.loading ? { label: 'Checking connection', tone: 'neutral', setupTarget: target,
      detail: 'The local Nous OAuth credential is being checked without generating.' }
      : checkedReadiness('Nous', target, health) ?? { label: health.error ? 'Check unavailable' : 'Sign-in not checked',
      tone: health.error ? 'warning' : 'neutral', setupTarget: target,
      detail: 'Nous uses a local Hermes OAuth login, not an API-key field. Open setup for the sign-in instructions and use Check connections.' };
    return { ...ready, connectionLabel: 'Nous sign-in' };
  }
  if (def.id === 'paper-source') {
    const source = params._paperSource && typeof params._paperSource === 'object' ? params._paperSource as Record<string, unknown> : undefined;
    if (source?.snapshot) return { label: source.state === 'current' ? 'Paper snapshot linked' : 'Paper source unavailable',
      tone: source.state === 'current' ? 'neutral' : 'warning', detail: 'The saved Paper snapshot is retained. Open its source node to refresh or reconnect the editable artwork; refresh never generates.' };
    return { label: 'Paper link required', tone: 'neutral', detail: 'Link an editable element from your local Paper app. Linking and refreshing never generate.' };
  }
  if (def.providerVia?.kind === 'model') {
    const model = modelChoice(def, params);
    const definition = model ? NODE_DEFINITIONS[model] : undefined;
    if (!definition) return { label: 'Scene model unavailable', tone: 'warning', detail: 'Choose a supported base model in Cinema scene settings before generating.' };
    const ready = modelReadiness(definition, {}, cache, health);
    return { ...ready, detail: `${definition.displayName} is the scene base model. ${ready.detail}` };
  }
  if (def.providerVia?.kind === 'param') {
    const via = def.providerVia;
    if (!paramCallsProvider(def, params)) {
      const own = Object.entries(via.byValue ?? {}).map(([value, route]) => `; ${via.param} ${value} calls ${route.provider} with ${route.anyKey.join(' or ')}`).join('');
      return { label: 'No API key required', tone: 'neutral',
        detail: `This ${via.param} runs locally. Other ${via.param} values call a ${via.provider} model and need ${via.anyKey.join(', ')}${own}.` };
    }
    const value = paramValue(def, params);
    const route = paramRoute(via, value);
    // The price, when there is one, is the run estimate's (lib/runScope.ts).
    const own = typeof value === 'string' && Boolean(via.byValue && Object.hasOwn(via.byValue, value));
    // The handler calls the first model whose key is set.
    const key = route.anyKey.find((candidate) => cache.apiKeys[candidate]?.trim()) ?? route.anyKey[0];
    const ready = keyReadiness(key, cache, health);
    const how = route.anyKey.length > 1 ? `the first of ${route.anyKey.join(', ')} that is set` : route.anyKey[0];
    return { ...ready, connectionLabel: `${PROVIDER_KEY_LABELS[key] ?? key} API`,
      detail: `Calls a ${route.provider} model with ${how}${own ? '' : '; no list price'}. ${ready.detail}` };
  }
  const space = spaceReadiness(def, params, cache, health);
  if (space) return space;
  const keys = (Array.isArray(def.envKeyName) ? def.envKeyName : [def.envKeyName]).filter(Boolean);
  if (!keys.length) return { label: 'No API key required', tone: 'neutral',
    detail: 'This node has no API-key requirement. Its inputs and local tools may still need setup.' };
  // The run's route (lib/directRoute.ts, the backend's rule): a configured
  // direct key first, so a valid alternate never masks a rejected direct key.
  // With none of a multi-route node's keys set, setup points at the maker's
  // key, unless this recipe can't take the direct route (directBlock: Ideogram
  // Reframe saved without a direct resolution, a Krea copy with explicit
  // width/height, a size the maker can't render exactly, a value the maker
  // doesn't take, or a model the maker has retired), or the node asks to
  // suggest the copy's key first (directRoute.setup: BytePlus Seedream).
  const route = selectRoute(def, params, cache.loaded ? cache.apiKeys : {});
  const block = keys.length > 1 && directKeyNames(def).length ? directBlock(def, params) : null;
  const directOk = block === null;
  const suggestDirect = directOk && def.directRoute?.setup !== 'fallback';
  const key = route.key ?? (suggestDirect ? directKeyNames(def)[0] : fallbackKeyNames(def)[0]) ?? keys[0];
  const ready = keyReadiness(key, cache, health);
  const blockNote = block ? ` ${directBlockNote(def, block)}` : '';
  return { ...ready, connectionLabel: connectionLabelFor(key),
    detail: `${routeDetail(def, route, key, directOk)}${blockNote} ${ready.detail}` };
}

/** A maker's Hugging Face Space route (handler hf-space: Idol). Keyless
 * (PR #203 round 7: the first live call ran with no token), in GM's r12
 * words: without the token "Hugging Face · Free" and that it can be busy;
 * with it "Hugging Face token · Saved" (the shared key vocabulary: "Saved"
 * until a check runs, "Connected" after one passes, "Not connected" after
 * one fails) and "Idol uses your Hugging Face allowance." A keyed Space route
 * (one with `keys`, as Idol's was in rounds 4 to 6) says what is needed
 * (GM r5 item 1). The specific line replaces the generic one, never both (GM r3). */
function spaceReadiness(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  cache: CredentialReadiness,
  health: ProviderHealthState,
): ModelReadiness | null {
  if (!def.routes?.length) return null;
  const route = selectRoute(def, params, cache.loaded ? cache.apiKeys : {});
  // Auto with no key names no route: a one-route node's is that one.
  const spec = route.routeId ? routeById(def, route.routeId) : def.routes.length === 1 ? def.routes[0] : undefined;
  if (!spec || (spec.handler !== 'hf-space' && !isKeylessRoute(spec))) return null;
  const keyless = isKeylessRoute(spec);
  const tokenKey = (keyless ? spec.optionalKeys?.[0] : spec.keys[0]) ?? null;
  const name = tokenKey ? PROVIDER_KEY_LABELS[tokenKey] ?? tokenKey : null;
  const connectionLabel = name ? `${name} token` : undefined;
  if (route.key) {
    const ready = keyReadiness(route.key, cache, health);
    const target: ProviderSetupTarget = { kind: 'api-key', key: route.key };
    const checked = checkedReadiness(PROVIDER_KEY_LABELS[route.key] ?? route.key, target, health);
    const allowance = `${def.displayName} uses your ${PROVIDER_KEY_LABELS[route.key] ?? route.key} allowance.`;
    if (checked?.tone === 'success') return { ...checked, label: 'Connected', connectionLabel, detail: allowance };
    if (checked?.tone === 'warning' && checked.label !== 'Check unavailable' && checked.label !== 'Check rate limited') {
      return { ...checked, label: 'Not connected', connectionLabel };
    }
    if (ready.label === 'Checking connection') return { ...ready, connectionLabel };
    return { label: 'Saved', tone: 'neutral', setupTarget: target, connectionLabel, detail: allowance };
  }
  if (!keyless && tokenKey) {
    if (!cache.loaded) return { ...keyReadiness(tokenKey, cache, health), connectionLabel };
    // GM r5 item 1: "Hugging Face token · Needed": the connection label
    // says what is needed, the status only that it is.
    return {
      label: 'Needed', tone: 'warning', setupTarget: { kind: 'api-key', key: tokenKey }, connectionLabel,
      detail: `Add your ${name} token in Settings to run ${def.displayName}.`,
    };
  }
  // GM, PR #203 r12 item 1: no allowance numbers, and no "your allowance"
  // without a token: whose pool an anonymous call uses isn't known.
  return {
    label: 'Free', tone: 'neutral',
    ...(tokenKey ? { setupTarget: { kind: 'api-key', key: tokenKey } as const } : {}),
    ...(name ? { connectionLabel: name } : {}),
    detail: name
      ? `${def.displayName} runs free on ${name}’s shared GPUs, which can be busy. Add your ${name} token in Settings to use your own allowance.`
      : `${def.displayName} runs free on shared GPUs, which can be busy.`,
  };
}

/** Why this recipe can't run on the maker's own API (lib/directRoute.ts directBlock). */
function directBlockNote(def: ModelNodeDefinition, block: DirectBlock): string {
  const direct = directKeyNames(def)[0];
  const fallback = fallbackKeyNames(def)[0];
  const directName = direct ? keyProviderName(direct) : 'the maker';
  const fallbackName = fallback ? (fallback === 'FAL_KEY' ? 'FAL' : keyProviderName(fallback)) : 'the copy';
  if (block.reason === 'requires') {
    // Ideogram Reframe without a direct resolution; Runway TTS/STS without an
    // ElevenLabs voice_id (Runway's voice presets don't map to one).
    return `This recipe sets no ${directName} ${block.param}, so it uses ${fallbackName}. Set it to run on ${directName}.`;
  }
  if (block.reason === 'blocked') {
    return `This recipe sets ${block.param}, which only ${fallbackName} takes, so it runs on ${fallbackName}. Clear it to run on ${directName}.`;
  }
  if (block.reason === 'unsupported') {
    // directRoute.accepts / rejects / rejectsWhen: "resolution 4K", "1080p at 10 seconds".
    return `${directName}'s own API doesn't take ${block.detail}, so it runs on ${fallbackName}. Change ${block.param} to run on ${directName}.`;
  }
  if (block.reason === 'size') {
    return `${directName} can't render this recipe's ${block.param} exactly, so it runs on ${fallbackName}. Pick a size ${directName} takes to run on ${directName}.`;
  }
  return `${directName} retires this model on its own API from ${block.on}, so it runs on ${fallbackName}.`;
}

function connectionLabelFor(key: string): string {
  if (key === 'KREA_API_TOKEN') return 'Krea API token';
  return `${key === 'FAL_KEY' ? 'fal.ai' : PROVIDER_KEY_LABELS[key] ?? key} API`;
}

function keyProviderName(key: string): string {
  const provider = Object.hasOwn(KEY_PROVIDERS, key) ? KEY_PROVIDERS[key] : undefined;
  return provider === 'fal' ? 'fal.ai' : PROVIDER_KEY_LABELS[key] ?? key;
}

/** Which route the run takes and whose key it uses: "Runs on Google with your
 * Google key" on the maker route, the fal or Krea copy's key otherwise. */
function routeDetail(def: ModelNodeDefinition, route: NodeRoute, key: string, directOk: boolean): string {
  const label = PROVIDER_KEY_LABELS[key] ?? key;
  const kreaToken = key === 'KREA_API_TOKEN' && supportsKreaAccount(def);
  const fallback = fallbackKeyNames(def)[0];
  const direct = directKeyNames(def)[0];
  if (!direct || !fallback) {
    return `${label}${kreaToken ? ' API token · API balance' : (Array.isArray(def.envKeyName) && def.envKeyName.length > 1) ? ' route' : ''}.`;
  }
  const directName = keyProviderName(direct);
  const fallbackName = keyProviderName(fallback);
  const fallbackKey = fallback === 'KREA_API_TOKEN' ? 'Krea API token' : `${PROVIDER_KEY_LABELS[fallback] ?? fallback} key`;
  const fallbackCopy = `${fallbackName} with your ${fallbackKey}${kreaToken ? ' (API balance)' : ''}`;
  if (route.kind === 'direct') {
    return `Runs on ${directName}'s own API with your ${PROVIDER_KEY_LABELS[key] ?? key} key, billed by ${directName}.`;
  }
  if (route.kind === 'fallback') {
    const directLabel = PROVIDER_KEY_LABELS[direct] ?? direct;
    const article = /^[AEIOU]/i.test(directLabel) ? 'an' : 'a';
    return `Runs on ${fallbackCopy}.${directOk ? ` Add ${article} ${directLabel} key to run on ${directName} directly.` : ''}`;
  }
  return directOk
    ? `Runs on ${directName} with your ${PROVIDER_KEY_LABELS[direct] ?? direct} key, or on ${fallbackName} with a ${fallbackKey}.`
    : `Runs on ${fallbackCopy}.`;
}
