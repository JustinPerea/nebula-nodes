import { getProjectContext, type ProjectContext } from './projectContext';
import { refuseWriteWhileOffline } from './backendConnection';
import { BACKEND_NOT_RUNNING_COPY, ConnectionLostError, isConnectionFailure } from './errorCopy';
import { TAB_HEADER, TAB_ID } from './tabId';
import { noteParamsOutdated, PARAMS_VERSION_HEADER } from './paramsOutdated';
import { GRAPH_PARAMS_VERSION } from './savedParamsUpgrades';
import {
  browserPersonCredential, noteSentBeforePromote, personCredential, personPromotions, reportPersonRequired, sentBeforePromote,
} from './personSession';
import {
  DEFAULT_BACKEND_PORT,
  assertBackendEnvConsistent,
  backendPortsFor,
  originAllowedByPin,
  pinnedBackendPort,
  type BackendPortEnv,
} from './devBackendPort';
const DISCOVERY_TIMEOUT_MS = 650;
const STORAGE_KEY = 'nebula:backendBaseUrl';
const TRANSIENT_PROXY_STATUSES = new Set([500, 502, 503, 504]);

type BackendSource = 'explicit' | 'test' | 'discovered' | 'injected' | 'person';

let cachedBaseUrl: string | null = null;
let cachedSource: BackendSource | null = null;
let discoveryPromise: Promise<string> | null = null;

// Synchronously initialize from the Electron-injected sidecar endpoint if the
// bridge is present. This makes getCachedBackendBaseUrl() non-null before the
// first async request, so synchronous helpers (backendUrlSync,
// backendAssetUrlSync) resolve against the injected origin immediately —
// before any renderer fetch or WebSocket opens.
{
  const injected = getInjectedApiBaseUrl();
  if (injected) {
    cachedBaseUrl = injected;
    cachedSource = 'injected';
  } else {
    // A tab connected as the person is pinned to the backend that issued its
    // token, before anything else can discover a different one.
    const person = browserPersonCredential();
    if (person) {
      cachedBaseUrl = person.backend;
      cachedSource = 'person';
    }
  }
}

function isTestMode(): boolean {
  return import.meta.env.MODE === 'test';
}

// Electron injects immutable HTTP/WS base URLs through the sandboxed preload
// bridge (window.nebulaDesktop). When present, the injected endpoint is the
// single authoritative source for the entire renderer lifetime — no Vite env,
// localStorage, same-origin proxy, port discovery, or health probing may
// override it. The bridge is absent in browser/Vite mode, preserving the
// existing discovery chain.
function getInjectedApiBaseUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.nebulaDesktop;
  const url = bridge?.apiBaseUrl;
  return typeof url === 'string' && url ? normalizeBaseUrl(url) : null;
}

function getInjectedWsBaseUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.nebulaDesktop;
  const url = bridge?.wsBaseUrl;
  return typeof url === 'string' && url ? normalizeBaseUrl(url) : null;
}

function configuredBackendBaseUrl(): string | null {
  const raw = (import.meta.env.VITE_NEBULA_API_BASE as string | undefined)?.trim();
  return raw ? normalizeBaseUrl(raw) : null;
}

function backendPortEnv(): BackendPortEnv {
  return {
    port: import.meta.env.VITE_NEBULA_BACKEND_PORT as string | undefined,
    ports: import.meta.env.VITE_NEBULA_BACKEND_PORTS as string | undefined,
    apiBase: import.meta.env.VITE_NEBULA_API_BASE as string | undefined,
  };
}

// VITE_NEBULA_BACKEND_PORT pins one port (no scan); else VITE_NEBULA_BACKEND_PORTS
// or 8000-8010. See devBackendPort.ts.
function configuredBackendPorts(): number[] {
  return backendPortsFor(backendPortEnv());
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

  // A URL stored by an earlier run on this origin may be another backend; a
  // pinned frontend skips it unless it is on the pinned port.
  const stored = readStoredBaseUrl();
  if (stored && originAllowedByPin(stored, backendPortEnv())) add(stored);
  // Same-origin goes through the Vite proxy, which follows the same pin.
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

/** The last "not found" logged, so a reconnect loop warns once (GM: keep it in the console). */
let lastNotFound: string | null = null;

async function discoverBackendBaseUrl(): Promise<string> {
  // Injected sidecar endpoint is authoritative — no discovery probes or
  // localStorage writes when the Electron bridge is present.
  const injected = getInjectedApiBaseUrl();
  if (injected) {
    cachedSource = 'injected';
    return injected;
  }

  if (isTestMode()) {
    cachedSource = 'test';
    return `http://localhost:${DEFAULT_BACKEND_PORT}`;
  }

  // Fail closed: a pin that is invalid, or that contradicts
  // VITE_NEBULA_API_BASE, throws instead of falling back to the scan.
  assertBackendEnvConsistent(backendPortEnv());

  const explicit = configuredBackendBaseUrl();
  if (explicit) {
    cachedSource = 'explicit';
    return explicit;
  }

  const candidates = candidateBaseUrls();
  const results = await Promise.all(candidates.map((candidate) => probeBackendBaseUrl(candidate)));
  const found = results.find((candidate): candidate is string => candidate != null);
  if (found == null) {
    const pinned = pinnedBackendPort(backendPortEnv().port);
    const ports = pinned === null
      ? `Nebula backend not found on localhost ports ${configuredBackendPorts().join(', ')}`
      : `Nebula backend not found on port ${pinned} (VITE_NEBULA_BACKEND_PORT); not scanning other ports`;
    // A plain browser tab with no backend (GM, error-copy round 2): GM's line
    // for the person, the ports it tried for the console. No answer at all,
    // so it is a ConnectionLostError (status 0) like a dropped request.
    if (lastNotFound !== ports) console.warn(`[nebula] ${ports}`);
    lastNotFound = ports;
    throw new ConnectionLostError(new Error(ports), { reason: BACKEND_NOT_RUNNING_COPY, detail: ports });
  }

  lastNotFound = null;
  cachedSource = 'discovered';
  writeStoredBaseUrl(found);
  return found;
}

export async function getBackendBaseUrl(options: { force?: boolean } = {}): Promise<string> {
  // Injected sidecar endpoint is authoritative for the process lifetime.
  // Forced resolution must not rediscover — the injected endpoint always wins.
  const injected = getInjectedApiBaseUrl();
  if (injected) {
    cachedBaseUrl = injected;
    cachedSource = 'injected';
    return injected;
  }

  // The person's token belongs to one backend: pin it, with no port discovery
  // or stored fallback, so the token can never reach another process.
  const person = browserPersonCredential();
  if (person) {
    cachedBaseUrl = person.backend;
    cachedSource = 'person';
    return person.backend;
  }

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

/** The person token for a socket opened by backendWebSocketUrl(), or null.
 * Given only when the socket's backend is the one that issued the token. */
export async function personTokenForSocket(socketUrl: string): Promise<string | null> {
  const person = await personCredential();
  if (!person) return null;
  try {
    const url = new URL(socketUrl);
    const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
    return origin === person.backend ? person.token : null;
  } catch {
    return null;
  }
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
  // No rediscovery when the Electron bridge is present — the injected
  // endpoint is authoritative and failed reads must not probe other backends.
  if (getInjectedApiBaseUrl() || cachedSource === 'injected') return false;
  if (cachedSource === 'explicit' || cachedSource === 'test' || cachedSource === 'person') return false;
  if (!response) return true;
  return baseUrl === '' && TRANSIENT_PROXY_STATUSES.has(response.status);
}

// Reads that need the person token: the agent spend view (the person isn't
// limited) and the Krea connector (an opaque desktop origin must prove it is
// the person). Every write carries it. Other reads don't, so a plain GET never
// carries the secret. The packaged app sends it on every request to its own
// sidecar. (Its file: page sends no Origin on fetches and isn't held to CORS,
// checked live in the desktop pass; the backend's opaque-origin CORS branch
// only matters if that changes. See desktop_renderer_cors in backend/main.py.)
const PERSON_READ_PREFIXES = ['/api/agent/spend', '/api/krea/', '/api/personal-agents'];
// Settings answers saved keys' endings only to the person (Justin, Q55 a);
// everyone else learns which keys are set.
const PERSON_READ_PATHS = ['/api/settings'];

function wantsPersonHeader(path: string, method: string): boolean {
  if (getInjectedApiBaseUrl()) return true;
  if (method !== 'GET' && method !== 'HEAD') return true;
  const route = path.split(/[?#]/, 1)[0];
  return PERSON_READ_PATHS.includes(route) || PERSON_READ_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function notePersonRequired(response: Response): void {
  if (response.status !== 403 || typeof response.clone !== 'function') return;
  // An answer to a request sent before the latest promote is the old state's (review 3
  // LOW-1): the server has since promoted this tab, so it holds nothing.
  if (sentBeforePromote(response)) return;
  void response.clone().json()
    .then((body: { code?: unknown } | null) => { if (body?.code === 'person_required') reportPersonRequired(); })
    .catch(() => { /* not JSON: not a person-gate refusal */ });
}

/**
 * fetch for a URL that apiFetch doesn't make (an asset link from
 * backendAssetUrlSync, a public URL): no Nebula headers, no person token, no
 * discovery replay. Its no-answer is classified here, at the call, as
 * apiFetch's is: a ConnectionLostError under `heading`, with fetch's own
 * error as its cause. The caller's own abort comes back as fetch threw it.
 * Downstream code reads that class (isNoAnswer), never `instanceof
 * TypeError`, so a bug in the browser isn't told as a server that isn't
 * answering (typeerror, 2026-10-24).
 */
export function fetchUrl(url: string, init: RequestInit = {}, heading = ''): Promise<Response> {
  return fetch(url, init).then(
    (response) => classifyBodyReads(response, heading),
    (error: unknown) => {
      throw isConnectionFailure(error, init.signal) ? new ConnectionLostError(error, { heading }) : error;
    },
  );
}

/** The Response methods that read the whole body. formData() is left out:
 * it also rejects with a TypeError for a body that isn't form data. */
const BODY_READS = ['json', 'text', 'blob', 'arrayBuffer', 'bytes'] as const;

/**
 * The answer came, then the connection dropped while the caller read the
 * body: the read rejects with fetch's own TypeError, a no-answer like
 * fetch()'s rejection. It is classified here, on the Response fetchUrl (and
 * so apiFetch) hands out, as a ConnectionLostError under `heading` (none
 * for apiFetch: apiRequest's caller and the failure helpers add theirs),
 * with fetch's error as its cause (typeerror2, 2026-10-24).
 *
 * Narrow on purpose: the same Response object (status, headers, url,
 * instanceof, bodyUsed unchanged), with only its whole-body reads (and
 * clone(), so a clone's read is classified too) shadowed on the instance. A
 * read of a body that is already used or locked is a bug and keeps its
 * plain TypeError; a JSON SyntaxError and an AbortError come back as
 * thrown. A test double that isn't a real Response is handed out untouched.
 * A stream reader (`response.body`) isn't wrapped: the one consumer,
 * readBoundedAssetResponse (lib/boundedAsset.ts), classifies its own reads.
 */
function classifyBodyReads(response: Response, heading: string): Response {
  if (!(response instanceof Response) || !Object.isExtensible(response)) return response;
  for (const name of BODY_READS) {
    const read = (response as unknown as Record<string, unknown>)[name];
    if (typeof read !== 'function') continue;
    Object.defineProperty(response, name, {
      configurable: true,
      writable: true,
      value: function classifiedRead(this: Response, ...args: unknown[]) {
        const target = this ?? response;
        // Used or locked before this read: the read's TypeError is a bug.
        if (target.bodyUsed || target.body?.locked) return read.apply(target, args);
        return (read.apply(target, args) as Promise<unknown>).catch((error: unknown) => {
          if (error instanceof ConnectionLostError) throw error;
          throw error instanceof TypeError ? new ConnectionLostError(error, { heading }) : error;
        });
      },
    });
  }
  const clone = response.clone;
  if (typeof clone === 'function') {
    Object.defineProperty(response, 'clone', {
      configurable: true,
      writable: true,
      value: function classifiedClone(this: Response) {
        return classifyBodyReads(clone.call(this ?? response), heading);
      },
    });
  }
  return response;
}

/** `options.project`: the project the caller read when the person acted (a
 * graph write that waited behind an undo: graphStore.graphMutationFetch,
 * review 17 H-1). Its revision is the one sent, never one read later. */
export async function apiFetch(path: string, init?: RequestInit,
  options?: { project?: ProjectContext | null }): Promise<Response> {
  // Capture at admission, before discovery can await a later project switch.
  const project = options && 'project' in options ? options.project ?? null : getProjectContext();
  const method = String(init?.method ?? 'GET').toUpperCase();
  // Offline is read-only (round 15 of PR #114): a write is refused here,
  // before anything is sent, whichever path asked for it.
  refuseWriteWhileOffline(method, path);
  const baseUrl = await getBackendBaseUrl();
  const requestUrl = joinBackendPath(baseUrl, path);
  // Every request says which params version this bundle was built for, so the
  // backend refuses a tab loaded before a one-time upgrade (paramsOutdated.ts).
  const headers = new Headers(init?.headers);
  headers.set(PARAMS_VERSION_HEADER, String(GRAPH_PARAMS_VERSION));
  if (project && method !== 'GET' && method !== 'HEAD') {
    headers.set('X-Nebula-Workspace-Revision', project.revision);
    // Which canvas it was made for (round 19): Nebula refuses it after a clear or an import.
    if (project.canvas !== undefined) headers.set('X-Nebula-Canvas-Revision', project.canvas);
  }
  // Which tab wrote, so this tab can tell its own edits' graphSync echoes
  // from edits made elsewhere (lib/tabId.ts).
  if (method !== 'GET' && method !== 'HEAD') headers.set(TAB_HEADER, TAB_ID);
  let requestInit: RequestInit = { ...init, headers };
  // The graph goes back with the relative asset links the backend gave it,
  // whatever this tab shows (canonicalBackendAssetUrls).
  const body = canonicalGraphBody(path, method, init?.body);
  if (body !== init?.body) requestInit = { ...requestInit, body };
  if (wantsPersonHeader(path, method)) {
    const person = await personCredential();
    // Only to the exact backend that issued the token.
    if (person && person.backend === baseUrl) {
      const headers = new Headers(requestInit?.headers);
      headers.set('X-Nebula-Person', person.token);
      requestInit = { ...requestInit, headers };
    }
  }
  // No answer at all is said in words here, where every request is made, so
  // no screen shows the browser's "Failed to fetch" (error-copy, GM): a
  // ConnectionLostError, still a TypeError, with fetch's own as its cause.
  // The caller's own abort comes back as fetch threw it.
  const send = (url: string) => fetchUrl(url, requestInit);
  // Replaying a mutation against another discovered backend is not a retry: it
  // is a second side effect in a different process. This is especially
  // dangerous for paid provider starts, whose public APIs have no idempotency
  // key. Only read-only requests may transparently rediscover and replay.
  const mayReplayAfterDiscovery = method === 'GET' || method === 'HEAD';

  // Which promote this request was sent under (review 3 LOW-1, PR #204 r5).
  const promotions = personPromotions();
  const stamp = (response: Response): Response => {
    if (personPromotions() !== promotions) noteSentBeforePromote(response);
    return response;
  };
  try {
    const response = stamp(await send(requestUrl));
    notePersonRequired(response);
    noteParamsOutdated(response);
    if (mayReplayAfterDiscovery && shouldRetryWithDiscovery(baseUrl, response)) {
      const retryBaseUrl = await getBackendBaseUrl({ force: true });
      if (retryBaseUrl !== baseUrl) {
        return stamp(await send(joinBackendPath(retryBaseUrl, path)));
      }
    }
    return response;
  } catch (err) {
    if (!mayReplayAfterDiscovery || !shouldRetryWithDiscovery(baseUrl)) throw err;
    const retryBaseUrl = await getBackendBaseUrl({ force: true });
    if (retryBaseUrl === baseUrl) throw err;
    return stamp(await send(joinBackendPath(retryBaseUrl, path)));
  }
}

export async function backendWebSocketUrl(
  path: string,
  options: { forceDiscovery?: boolean } = {},
): Promise<string> {
  // Injected WS base is authoritative — no discovery, no probing.
  // forceDiscovery is deliberately ignored when the bridge is present so
  // that reconnect constructs the byte-identical injected URL.
  const injectedWs = getInjectedWsBaseUrl();
  if (injectedWs) {
    // The person proves itself inside the socket (the /ws hello frame and each
    // /ws/chat send), never in the URL, which servers log.
    return joinBackendPath(injectedWs, path);
  }

  const baseUrl = await getBackendBaseUrl({ force: options.forceDiscovery });
  const origin = baseUrl || window.location.origin;
  const url = new URL(joinBackendPath(origin, path));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// Server-relative paths the backend serves and that must be rewritten to the
// discovered backend origin (the frontend may be on a different origin/port,
// e.g. the Vite dev server or a packaged shell). Generated media live under
// /api/outputs/; shipped preset thumbnails under /api/presets/thumbnails/.
const BACKEND_ASSET_PREFIXES = ['/api/outputs/', '/api/presets/thumbnails/', '/api/paper/snapshots/'];

function hasBackendAssetPrefix(pathname: string): boolean {
  return BACKEND_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isLocalBackendAssetUrl(value: string): boolean {
  if (hasBackendAssetPrefix(value)) return true;

  try {
    const url = new URL(value);
    return (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      hasBackendAssetPrefix(url.pathname)
    );
  } catch {
    return false;
  }
}

export function backendAssetUrlSync(value: string): string {
  if (hasBackendAssetPrefix(value)) return backendUrlSync(value);

  try {
    const url = new URL(value);
    if (isLocalBackendAssetUrl(value)) return backendUrlSync(`${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* Non-URL strings are handled by the prefix check above. */
  }

  return value;
}

// Versioned spatial values (backend/models/spatial.py, lib/spatialValue.ts),
// by their own `kind`, so one on an Any port counts too.
const SPATIAL_VALUE_KINDS = new Set([
  'coordinate-system', 'camera-pose', 'camera-path', 'spatial-context', 'depth-map', 'depth-sequence',
  'point-cloud', 'sensor-rig', 'sensor-stream', 'spatial-session', 'world',
]);

/** A versioned spatial value keeps the relative /api/outputs links the
 * backend gave it, in the tab too: its contract allows nothing else, the
 * card's strict parser (lib/spatialValue.ts) refuses an absolute one ("World
 * unavailable"), and every viewer resolves each link when it draws or fetches
 * it (RepresentationViewer, worldSplat, worldDownload, canvasSelection). The
 * display rewrites below leave it as it is. */
function isVersionedSpatialValue(value: object): boolean {
  const candidate = value as { schemaVersion?: unknown; kind?: unknown };
  return typeof candidate.schemaVersion === 'number' && typeof candidate.kind === 'string'
    && SPATIAL_VALUE_KINDS.has(candidate.kind);
}

export function rewriteBackendAssetUrls<T>(value: T): T {
  if (typeof value === 'string') return backendAssetUrlSync(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteBackendAssetUrls(item)) as T;
  if (value && typeof value === 'object') {
    if (isVersionedSpatialValue(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteBackendAssetUrls(entry)]),
    ) as T;
  }
  return value;
}

/** Whether `url` is on this backend's origin: a loopback host (any port, as
 * isLocalBackendAssetUrl reads it on the way in) or the resolved base. */
function isThisBackendOrigin(url: URL): boolean {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  if (!cachedBaseUrl) return false;
  try {
    return url.origin === new URL(cachedBaseUrl).origin;
  } catch {
    return false;
  }
}

/** The backend-relative link an absolute asset link was made from, or null.
 * The path is kept as written (not as URL parsing re-encodes it), so a link
 * goes back out exactly as the backend gave it. */
function relativeBackendAssetUrl(value: string): string | null {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return null;
  const pathStart = value.indexOf('/', value.indexOf('://') + 3);
  if (pathStart < 0) return null;
  const raw = value.slice(pathStart);
  if (!hasBackendAssetPrefix(raw)) return null;
  try {
    const url = new URL(value);
    return isThisBackendOrigin(url) && hasBackendAssetPrefix(url.pathname) ? raw : null;
  } catch {
    return null;
  }
}

/** The inverse of the display rewrites (rewriteBackendAssetUrls,
 * rewriteExecutionAssetUrls, backendAssetUrlSync): every string that is one
 * of this backend's asset links made absolute for display goes back to the
 * relative /api/... link the backend gave. The tab shows absolute links; what
 * leaves it (project saves, graph edits, runs, Save graph) carries relative
 * ones, so a structured value the backend checks strictly (a World's asset
 * uris must be relative /api/outputs paths) passes, and a saved project
 * never holds the port this tab happened to reach the backend on. Whole
 * string values only, as the display rewrite: text that mentions a link and
 * links to anywhere else are left as they are. */
export function canonicalBackendAssetUrls<T>(value: T): T {
  if (typeof value === 'string') return (relativeBackendAssetUrl(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => canonicalBackendAssetUrls(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonicalBackendAssetUrls(entry)]),
    ) as T;
  }
  return value;
}

// Requests that carry graph content (nodes, params, outputs, project
// snapshots): the backend's params-gated prefixes (_PARAMS_GATED_PREFIXES).
// apiFetch sends their JSON bodies through canonicalBackendAssetUrls.
const GRAPH_BODY_PREFIXES = ['/api/graph', '/api/execute', '/api/cinema', '/api/quick', '/api/projects', '/api/presets'];

function canonicalGraphBody(path: string, method: string, body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (method === 'GET' || method === 'HEAD' || typeof body !== 'string') return body;
  if (!GRAPH_BODY_PREFIXES.some((prefix) => path.startsWith(prefix))) return body;
  // Cheap test first: autosaves send the whole project on every edit.
  if (!body.includes('://')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  return JSON.stringify(canonicalBackendAssetUrls(parsed));
}

/** Normalize an asset-bearing execution value, including structured World
 * outputs. The backend normally emits /api/outputs URLs; the filesystem-path
 * branch keeps older providers and replayed websocket fixtures usable without
 * ever rewriting arbitrary Text ports. */
export function rewriteExecutionAssetUrls<T>(value: T): T {
  if (typeof value === 'string') {
    if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/api/')) {
      return backendAssetUrlSync(value) as T;
    }

    const normalized = value.replaceAll('\\', '/');
    const outputMarker = normalized.lastIndexOf('/output/');
    if (outputMarker >= 0) {
      return backendAssetUrlSync(`/api/outputs/${normalized.slice(outputMarker + '/output/'.length)}`) as T;
    }
    if (normalized.startsWith('output/')) {
      return backendAssetUrlSync(`/api/outputs/${normalized.slice('output/'.length)}`) as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteExecutionAssetUrls(entry)) as T;
  if (value && typeof value === 'object') {
    // The backend checked it against its contract before sending it, so its
    // links are already relative /api/outputs paths (isVersionedSpatialValue).
    if (isVersionedSpatialValue(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteExecutionAssetUrls(entry)]),
    ) as T;
  }
  return value;
}
