import { apiFetch } from './backend';
import type { ModelNodeDefinition } from '../types';

export type KreaConnectionMode = 'api-token' | 'mcp';
export interface KreaConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'needs_auth' | 'error';
  authorizationUrl?: string;
  error?: string;
  tools?: string[];
}

export interface CredentialReadiness {
  apiKeys: Record<string, string>;
  loaded: boolean;
  kreaConnection?: KreaConnectionState;
  kreaConnectionMode?: KreaConnectionMode;
}

export function normalizeKreaMode(value: unknown): KreaConnectionMode {
  return value === 'mcp' ? 'mcp' : 'api-token';
}

function kreaAuthParam(def: ModelNodeDefinition | undefined) {
  return def?.apiProvider === 'krea' ? def.params?.find((param) => param.key === '_kreaAuth') : undefined;
}

/** Any Krea node whose definition offers Krea-account billing. */
export function supportsKreaAccount(def: ModelNodeDefinition | undefined): boolean {
  return Boolean(kreaAuthParam(def));
}

/** Features Krea only offers to a signed-in account (moodboards, Krea Files, ...). */
export function isKreaAccountOnly(def: ModelNodeDefinition | undefined): boolean {
  const options = kreaAuthParam(def)?.options ?? [];
  return options.length === 1 && options[0].value === 'mcp';
}

/** Missing modes on old nodes always retain API billing. */
export function kreaModeFor(def: ModelNodeDefinition | undefined, params: Record<string, unknown>): KreaConnectionMode {
  return isKreaAccountOnly(def) ? 'mcp' : normalizeKreaMode(params._kreaAuth);
}

export function usesKreaAccount(def: ModelNodeDefinition | undefined, params: Record<string, unknown>): boolean {
  return supportsKreaAccount(def) && kreaModeFor(def, params) === 'mcp';
}

/** Only call when authoring a new node, never while loading a saved recipe. */
export function withNewKreaMode(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  mode: KreaConnectionMode = 'api-token',
): Record<string, unknown> {
  if (!supportsKreaAccount(def)) return params;
  return { ...params, _kreaAuth: isKreaAccountOnly(def) ? 'mcp' : normalizeKreaMode(mode) };
}

export function nodeKeyStatus(
  def: ModelNodeDefinition | undefined,
  params: Record<string, unknown>,
  cache: CredentialReadiness,
): 'missing' | undefined {
  if (!def || !cache.loaded) return undefined;
  if (usesKreaAccount(def, params)) {
    return cache.kreaConnection?.status === 'connected' ? undefined : 'missing';
  }
  const keys = Array.isArray(def.envKeyName) ? def.envKeyName : [def.envKeyName];
  return keys.filter(Boolean).length > 0 && !keys.some((key) => Boolean(cache.apiKeys[key]))
    ? 'missing' : undefined;
}

export function isKreaAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.krea.ai'
      && url.pathname === '/auth/v1/oauth/authorize'
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function requestConnection(method: 'GET' | 'POST' | 'DELETE', suffix = ''): Promise<KreaConnectionState> {
  try {
    const response = await apiFetch(`/api/krea/connection${suffix}`, { method });
    if (!response.ok) throw new Error('Connection request failed');
    return await response.json();
  } catch {
    // Network and parsing exceptions can contain credential-bearing URLs.
    throw new Error('Could not update the Krea connection. Check that the Nebula backend is available.');
  }
}

export const getKreaConnection = () => requestConnection('GET');
export const connectKrea = () => requestConnection('POST', '/connect');
export const checkKreaConnection = () => requestConnection('POST', '/check');
export const disconnectKrea = () => requestConnection('DELETE');
