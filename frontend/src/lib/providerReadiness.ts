import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition } from '../types';
import { supportsKreaAccount, usesKreaAccount, type CredentialReadiness } from './kreaConnection';

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
}

export const PROVIDER_HEALTH_TTL_MS = 5 * 60 * 1000;
export const PROVIDER_KEY_LABELS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'OpenAI', ANTHROPIC_API_KEY: 'Anthropic', GOOGLE_API_KEY: 'Google',
  OPENROUTER_API_KEY: 'OpenRouter', REPLICATE_API_TOKEN: 'Replicate', FAL_KEY: 'FAL',
  MESHY_API_KEY: 'Meshy', RUNWAY_API_KEY: 'Runway', ELEVENLABS_API_KEY: 'ElevenLabs',
  MINIMAX_API_KEY: 'MiniMax', XAI_API_KEY: 'xAI', HIGGSFIELD_API_KEY: 'Higgsfield',
  QUIVER_API_KEY: 'QuiverAI', KREA_API_TOKEN: 'Krea', IDEOGRAM_API_KEY: 'Ideogram',
  WORLDLABS_API_KEY: 'World Labs',
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
      detail: `${provider} could not be checked. The saved connection is unchanged; retry Check connections.` };
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
    detail: health.error ? `${provider} is configured, but connections could not be checked. Retry Check connections.`
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
  if (def.id === 'cinema-scene') {
    const scene = params.scene && typeof params.scene === 'object' ? params.scene as Record<string, unknown> : {};
    const base = scene.base && typeof scene.base === 'object' ? scene.base as Record<string, unknown> : {};
    const savedModel = String(base.model ?? '').trim().toLowerCase();
    const model = !savedModel || ['flux-1-dev', 'flux.1-dev', 'flux-dev'].includes(savedModel) ? 'seedream-4-5' : savedModel;
    const definition = ['seedream-4-5', 'nano-banana', 'nano-banana-fal-edit', 'flux-kontext'].includes(model) ? NODE_DEFINITIONS[model] : undefined;
    if (!definition) return { label: 'Scene model unavailable', tone: 'warning', detail: 'Choose a supported base model in Cinema scene settings before generating.' };
    const ready = modelReadiness(definition, {}, cache, health);
    return { ...ready, detail: `${definition.displayName} is the scene base model. ${ready.detail}` };
  }
  const keys = (Array.isArray(def.envKeyName) ? def.envKeyName : [def.envKeyName]).filter(Boolean);
  if (!keys.length) return { label: 'No API key required', tone: 'neutral',
    detail: 'This node has no API-key requirement. Its inputs and local tools may still need setup.' };
  // Runtime selects a configured direct route first. A valid alternate must not mask a rejected direct key.
  const needsFalReframe = def.id === 'ideogram-reframe' && !params.resolution;
  const key = needsFalReframe ? 'FAL_KEY' : def.directKeyName && cache.apiKeys[def.directKeyName]?.trim() ? def.directKeyName
    : keys.find((candidate) => cache.apiKeys[candidate]?.trim()) ?? def.directKeyName ?? keys[0];
  const ready = keyReadiness(key, cache, health);
  return { ...ready, connectionLabel: key === 'KREA_API_TOKEN' ? 'Krea API token' : `${key === 'FAL_KEY' ? 'fal.ai' : PROVIDER_KEY_LABELS[key] ?? key} API`,
    detail: `${PROVIDER_KEY_LABELS[key] ?? key}${supportsKreaAccount(def) ? ' API token · API balance' : keys.length > 1 ? ' route' : ''}.${needsFalReframe ? ' This saved recipe has no direct resolution, so it uses FAL.' : ''} ${ready.detail}` };
}
