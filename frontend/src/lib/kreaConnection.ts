import { apiFetch } from './backend';
import { copyForError, copyForStatus, FailureNotice, REFUSED_FALLBACK_COPY } from './errorCopy';
import { hasRoutes, routeUnavailable, usesRoutePlan } from './directRoute';
import { keysNeeded } from './nodeKeys';
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

/** The node's `_kreaAuth` param: on a Krea node, or on a route-table node
 * with a Krea route that can bill the plan (node_route.krea_auth_param). */
function kreaAuthParam(def: ModelNodeDefinition | undefined) {
  const offersPlan = def?.apiProvider === 'krea' || Boolean(hasRoutes(def) && def?.routes?.some((route) => route.plan));
  return offersPlan ? def?.params?.find((param) => param.key === '_kreaAuth') : undefined;
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

/** A run billed to the signed-in Krea plan. On a route-table node, exactly
 * when selectRoute returns `plan` (its Krea route chosen with the plan, or
 * the plan picked on a Krea-maker node under Auto). */
export function usesKreaAccount(def: ModelNodeDefinition | undefined, params: Record<string, unknown>): boolean {
  if (def && hasRoutes(def)) return usesRoutePlan(def, params);
  return supportsKreaAccount(def) && kreaModeFor(def, params) === 'mcp';
}

/** Only call when authoring a new node, never while loading a saved recipe.
 * The global "use my Krea plan" default only applies where Krea is the
 * maker (apiProvider 'krea'); a FLUX node with a Krea route starts on the
 * API token, and the person picks the "Krea · plan" row to bill the plan. */
export function withNewKreaMode(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  mode: KreaConnectionMode = 'api-token',
): Record<string, unknown> {
  if (!supportsKreaAccount(def)) return params;
  if (def.apiProvider !== 'krea') return { ...params, _kreaAuth: 'api-token' };
  return { ...params, _kreaAuth: isKreaAccountOnly(def) ? 'mcp' : normalizeKreaMode(mode) };
}

/** 'missing' when this node, with these params, can't run with what is set
 * up: its key, its Krea sign-in, or for a local node that calls a provider
 * (`providerVia`), the key of the model or mode it picks (lib/nodeKeys.ts). */
export function nodeKeyStatus(
  def: ModelNodeDefinition | undefined,
  params: Record<string, unknown>,
  cache: CredentialReadiness,
): 'missing' | undefined {
  if (!def || !cache.loaded) return undefined;
  if (def.providerVia) {
    const needs = keysNeeded(def, params);
    if (needs === null) return 'missing';
    return needs.some((need) => ownKeyStatus(need.definition, need.params, cache) === 'missing') ? 'missing' : undefined;
  }
  return ownKeyStatus(def, params, cache);
}

function ownKeyStatus(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  cache: CredentialReadiness,
): 'missing' | undefined {
  if (usesKreaAccount(def, params)) {
    return cache.kreaConnection?.status === 'connected' ? undefined : 'missing';
  }
  // A route-table node needs its chosen (or Auto's) route to be runnable,
  // not just any of its keys (lib/directRoute.ts routeUnavailable).
  if (hasRoutes(def)) return routeUnavailable(def, params, cache.apiKeys) ? 'missing' : undefined;
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

/**
 * A Krea call, one line on failure (error copy round 3e, GM: "Couldn't
 * {verb} {object}." then the reason). The reason comes from what kind of
 * failure it was, never from the error or the answer's body: network and
 * parsing exceptions, and Krea's own answers, can contain credential-bearing
 * URLs, so nothing of theirs is kept, shown or logged.
 */
async function kreaJson<T>(heading: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await (init === undefined ? apiFetch(path) : apiFetch(path, init));
  } catch (error) {
    throw new FailureNotice(heading, copyForError(error));
  }
  if (!response.ok) throw new FailureNotice(heading, copyForStatus(response.status, undefined));
  try {
    return await response.json() as T;
  } catch {
    throw new FailureNotice(heading, REFUSED_FALLBACK_COPY);
  }
}

const KREA_CONNECTION_HEADING = "Couldn't update the Krea connection.";

function requestConnection(method: 'GET' | 'POST' | 'DELETE', suffix = ''): Promise<KreaConnectionState> {
  return kreaJson(KREA_CONNECTION_HEADING, `/api/krea/connection${suffix}`, { method });
}

export const getKreaConnection = () => requestConnection('GET');
export const connectKrea = () => requestConnection('POST', '/connect');
export const checkKreaConnection = () => requestConnection('POST', '/check');
export const disconnectKrea = () => requestConnection('DELETE');

export interface KreaPlan {
  id: string | null;
  name: string;
  prominent: boolean;
  units: number | null;
  price: number | null;
  annualPrice: number | null;
  examples: string[];
  features: { text: string; included: boolean; isNew: boolean }[];
  checkoutUrl: string | null;
  annualCheckoutUrl: string | null;
}

export interface KreaPlans {
  plans: KreaPlan[];
  trialAvailable: boolean;
  annualSavingsPct: number | null;
  manageUrl: string | null;
}

const PLAN_HOSTS = new Set(['www.krea.ai', 'krea.ai']);
const TRIAL_HOSTS = new Set([...PLAN_HOSTS, 'checkout.stripe.com']);

/** Same rule as the backend: https, no credentials, default port, known host. */
export function isSafeKreaBillingUrl(value: unknown, trial = false): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (trial ? TRIAL_HOSTS : PLAN_HOSTS).has(url.hostname);
  } catch {
    return false;
  }
}

export async function getKreaPlans(): Promise<KreaPlans> {
  const body = await kreaJson<KreaPlans>("Couldn't load the Krea plans.", '/api/krea/plans');
  const link = (value: unknown) => (isSafeKreaBillingUrl(value) ? value : null);
  return {
    plans: (Array.isArray(body.plans) ? body.plans : []).map((plan) => ({
      ...plan, checkoutUrl: link(plan.checkoutUrl), annualCheckoutUrl: link(plan.annualCheckoutUrl),
    })),
    trialAvailable: body.trialAvailable === true,
    annualSavingsPct: typeof body.annualSavingsPct === 'number' ? body.annualSavingsPct : null,
    manageUrl: link(body.manageUrl),
  };
}

/** Starts Krea's trial checkout; payment details are entered on that page, never in Nebula. */
export async function startKreaTrial(): Promise<string> {
  const heading = "Couldn't start the Krea trial.";
  const url = (await kreaJson<{ url?: unknown }>(heading, '/api/krea/trial', { method: 'POST' }))?.url;
  if (!isSafeKreaBillingUrl(url, true)) {
    throw new FailureNotice(heading, "Krea sent back an unexpected trial link, so Nebula didn't open it.");
  }
  return url;
}
