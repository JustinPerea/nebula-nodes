const DEFAULT_BACKEND_PORT = 8000;
const DEFAULT_BACKEND_PORTS = [8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010];
const DISCOVERY_TIMEOUT_MS = 650;
const STORAGE_KEY = 'nebula:backendBaseUrl';
const TRANSIENT_PROXY_STATUSES = new Set([500, 502, 503, 504]);

type BackendSource = 'explicit' | 'test' | 'discovered';

let cachedBaseUrl: string | null = null;
let cachedSource: BackendSource | null = null;
let discoveryPromise: Promise<string> | null = null;

function isTestMode(): boolean {
  return import.meta.env.MODE === 'test';
}

function configuredBackendBaseUrl(): string | null {
  const raw = (import.meta.env.VITE_NEBULA_API_BASE as string | undefined)?.trim();
  return raw ? normalizeBaseUrl(raw) : null;
}

function configuredBackendPorts(): number[] {
  const raw = (import.meta.env.VITE_NEBULA_BACKEND_PORTS as string | undefined)?.trim();
  if (!raw) return DEFAULT_BACKEND_PORTS;

  const parsed = raw
    .split(',')
    .map((part: string) => Number(part.trim()))
    .filter((port: number) => Number.isInteger(port) && port > 0 && port < 65536);

  return parsed.length > 0 ? [...new Set(parsed)] : DEFAULT_BACKEND_PORTS;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function joinBackendPath(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

function readStoredBaseUrl(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredBaseUrl(baseUrl: string): void {
  try {
    if (baseUrl) window.localStorage.setItem(STORAGE_KEY, baseUrl);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage can be unavailable in private contexts. */
  }
}

function sameOriginCandidate(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return null;
  return '';
}

function localHostCandidates(): string[] {
  if (typeof window === 'undefined') return ['localhost', '127.0.0.1'];
  const hosts = [window.location.hostname, 'localhost', '127.0.0.1'];
  return [...new Set(hosts.filter(Boolean))];
}

function candidateBaseUrls(): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  const add = (baseUrl: string | null) => {
    if (baseUrl == null) return;
    const normalized = normalizeBaseUrl(baseUrl);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(readStoredBaseUrl());
  add(sameOriginCandidate());

  for (const host of localHostCandidates()) {
    for (const port of configuredBackendPorts()) {
      add(`http://${host}:${port}`);
    }
  }

  return candidates;
}

async function probeBackendBaseUrl(baseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetch(joinBackendPath(baseUrl, '/api/health'), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body = (await response.json().catch(() => null)) as { status?: unknown; version?: unknown; app?: unknown } | null;
    if (body?.status === 'ok' && (body.app === 'nebula' || typeof body.version === 'string')) {
      return baseUrl;
    }
    return null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function discoverBackendBaseUrl(): Promise<string> {
  if (isTestMode()) {
    cachedSource = 'test';
    return `http://localhost:${DEFAULT_BACKEND_PORT}`;
  }

  const explicit = configuredBackendBaseUrl();
  if (explicit) {
    cachedSource = 'explicit';
    return explicit;
  }

  const candidates = candidateBaseUrls();
  const results = await Promise.all(candidates.map((candidate) => probeBackendBaseUrl(candidate)));
  const found = results.find((candidate): candidate is string => candidate != null);
  if (found == null) {
    throw new Error(`Nebula backend not found on localhost ports ${configuredBackendPorts().join(', ')}`);
  }

  cachedSource = 'discovered';
  writeStoredBaseUrl(found);
  return found;
}

export async function getBackendBaseUrl(options: { force?: boolean } = {}): Promise<string> {
  if (!options.force && cachedBaseUrl != null) return cachedBaseUrl;
  if (!options.force && discoveryPromise) return discoveryPromise;

  discoveryPromise = discoverBackendBaseUrl()
    .then((baseUrl) => {
      cachedBaseUrl = baseUrl;
      return baseUrl;
    })
    .finally(() => {
      discoveryPromise = null;
    });

  return discoveryPromise;
}

export function getCachedBackendBaseUrl(): string | null {
  return cachedBaseUrl;
}

export async function backendUrl(path: string): Promise<string> {
  return joinBackendPath(await getBackendBaseUrl(), path);
}

export function backendUrlSync(path: string): string {
  return joinBackendPath(cachedBaseUrl ?? '', path);
}

function shouldRetryWithDiscovery(baseUrl: string, response?: Response): boolean {
  if (cachedSource === 'explicit' || cachedSource === 'test') return false;
  if (!response) return true;
  return baseUrl === '' && TRANSIENT_PROXY_STATUSES.has(response.status);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = await getBackendBaseUrl();
  const requestUrl = joinBackendPath(baseUrl, path);
  const send = (url: string) => (init === undefined ? fetch(url) : fetch(url, init));

  try {
    const response = await send(requestUrl);
    if (shouldRetryWithDiscovery(baseUrl, response)) {
      const retryBaseUrl = await getBackendBaseUrl({ force: true });
      if (retryBaseUrl !== baseUrl) {
        return send(joinBackendPath(retryBaseUrl, path));
      }
    }
    return response;
  } catch (err) {
    if (!shouldRetryWithDiscovery(baseUrl)) throw err;
    const retryBaseUrl = await getBackendBaseUrl({ force: true });
    if (retryBaseUrl === baseUrl) throw err;
    return send(joinBackendPath(retryBaseUrl, path));
  }
}

export async function backendWebSocketUrl(path: string): Promise<string> {
  const baseUrl = await getBackendBaseUrl();
  const origin = baseUrl || window.location.origin;
  const url = new URL(joinBackendPath(origin, path));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function isLocalBackendAssetUrl(value: string): boolean {
  if (value.startsWith('/api/outputs/')) return true;

  try {
    const url = new URL(value);
    return (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.pathname.startsWith('/api/outputs/')
    );
  } catch {
    return false;
  }
}

export function backendAssetUrlSync(value: string): string {
  if (value.startsWith('/api/outputs/')) return backendUrlSync(value);

  try {
    const url = new URL(value);
    if (isLocalBackendAssetUrl(value)) return backendUrlSync(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* Non-URL strings are handled by the prefix check above. */
  }

  return value;
}

export function rewriteBackendAssetUrls<T>(value: T): T {
  if (typeof value === 'string') return backendAssetUrlSync(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteBackendAssetUrls(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteBackendAssetUrls(entry)]),
    ) as T;
  }
  return value;
}
