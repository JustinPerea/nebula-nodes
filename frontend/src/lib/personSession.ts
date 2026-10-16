/**
 * The person's launch token: the one proof that a request comes from the
 * person and not an agent (backend/services/person_gate.py).
 *
 * Where it comes from, in order:
 *   1. Desktop: Electron main hands it over IPC (`nebulaDesktop.person`), and
 *      only to the trusted main frame. It's bound to the injected sidecar.
 *   2. Browser: the link the dev backend prints or opens,
 *      `#nebula-person=<token>&backend=<origin>` (the old `#commons-token=`
 *      still works). The fragment is moved into sessionStorage and stripped
 *      from the address bar at once.
 *   3. sessionStorage (this tab only), so a reload keeps it.
 *
 * The token is bound to the backend that issued it: while a tab holds one,
 * backend.ts pins that origin (no port discovery, no stored fallback) and the
 * header and the `/ws` hello go only there.
 *
 * A dev frontend pinned with VITE_NEBULA_BACKEND_PORT (devBackendPort.ts)
 * refuses a link or stored credential naming a backend on another port, and a
 * link without `backend=` defaults to the pinned port instead of 8000.
 */

import { originAllowedByPin, pinnedBackendPort, type BackendPortEnv } from './devBackendPort';

const STORAGE_KEY = 'nebula.person';
// Commons' old name for the same per-launch secret. Read once, then removed.
const LEGACY_STORAGE_KEY = 'nebula.commons.token';
const LINK_KEYS = ['nebula-person', 'commons-token', 'backend'] as const;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const DEFAULT_DEV_BACKEND = 'http://127.0.0.1:8000';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const PERSON_REQUIRED_EVENT = 'nebula:person-required';
/** A fresh person link was taken in by this tab (the canvas may re-say hello). */
export const PERSON_CONNECTED_EVENT = 'nebula:person-connected';

export interface PersonCredential {
  token: string;
  /** The backend origin that issued the token; the only place it is sent. */
  backend: string;
}

export type PersonUnavailableReason =
  | 'not-connected'
  | 'debug-port'
  | 'dev-renderer'
  | 'untrusted-sender'
  | 'desktop-unavailable';

interface DesktopTokenResult {
  ok: boolean;
  token?: string | null;
  error?: string;
}

let desktopLookup: Promise<PersonCredential | null> | null = null;
let desktopReason: PersonUnavailableReason | null = null;

/** `scheme://host:port` for a plain loopback http(s) origin, else null. */
export function loopbackOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function backendPortEnv(): BackendPortEnv {
  return { port: import.meta.env.VITE_NEBULA_BACKEND_PORT as string | undefined };
}

function defaultBackend(): string {
  const configured = (import.meta.env.VITE_NEBULA_API_BASE as string | undefined)?.trim();
  const pinned = pinnedBackendPort(backendPortEnv().port);
  return loopbackOrigin(configured)
    ?? (pinned === null ? DEFAULT_DEV_BACKEND : `http://127.0.0.1:${pinned}`);
}

/** A loopback backend this tab may hold a token for (the pin, when set). */
function allowedBackend(origin: string): boolean {
  return originAllowedByPin(origin, backendPortEnv());
}

function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.nebulaDesktop?.apiBaseUrl === 'string'
    && Boolean(window.nebulaDesktop.apiBaseUrl);
}

function valid(credential: unknown): credential is PersonCredential {
  if (!credential || typeof credential !== 'object') return false;
  const { token, backend } = credential as Record<string, unknown>;
  return typeof token === 'string' && TOKEN_SHAPE.test(token)
    && typeof backend === 'string' && loopbackOrigin(backend) === backend && allowedBackend(backend);
}

function readStored(): PersonCredential | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return valid(parsed) ? parsed : null;
    }
    const legacy = window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && TOKEN_SHAPE.test(legacy)) {
      const credential = { token: legacy, backend: defaultBackend() };
      writeStored(credential);
      return credential;
    }
  } catch {
    /* sessionStorage can be unavailable or hold junk; treat as not connected. */
  }
  return null;
}

function writeStored(credential: PersonCredential): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* Without storage the token lasts until this page unloads. */
  }
}

let memoryCredential: PersonCredential | null = null;

/** Move a person link out of the address bar. Returns its credential, if valid. */
function consumeLink(): PersonCredential | null | undefined {
  if (typeof window === 'undefined' || !window.location.hash) return undefined;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!LINK_KEYS.some((key) => params.has(key))) return undefined;
  const token = params.get('nebula-person') ?? params.get('commons-token');
  const backendParam = params.get('backend');
  for (const key of LINK_KEYS) params.delete(key);
  const remaining = params.toString();
  // Strip first, even when the link turns out to be invalid: the secret must
  // not stay in the address bar or the back/forward entry.
  window.history.replaceState(window.history.state, '',
    window.location.pathname + window.location.search + (remaining ? `#${remaining}` : ''));
  if (!token || !TOKEN_SHAPE.test(token)) return null;
  const backend = backendParam === null ? defaultBackend() : loopbackOrigin(backendParam);
  // A link that names a non-loopback backend is refused outright, and so is
  // one for another port when this frontend is pinned to one backend.
  if (!backend || !allowedBackend(backend)) return null;
  return { token, backend };
}

/** The browser tab's credential (null in the desktop app; see personCredential). */
export function browserPersonCredential(): PersonCredential | null {
  if (typeof window === 'undefined' || hasDesktopBridge()) return null;
  const fromLink = consumeLink();
  if (fromLink) {
    // A fresh link supersedes whatever this tab held before.
    const changed = memoryCredential?.token !== fromLink.token || memoryCredential?.backend !== fromLink.backend;
    memoryCredential = fromLink;
    writeStored(fromLink);
    if (changed) window.dispatchEvent(new CustomEvent(PERSON_CONNECTED_EVENT));
    return fromLink;
  }
  if (memoryCredential) return memoryCredential;
  memoryCredential = readStored();
  return memoryCredential;
}

async function desktopCredential(): Promise<PersonCredential | null> {
  const bridge = window.nebulaDesktop;
  const backend = loopbackOrigin(bridge?.apiBaseUrl ?? null);
  const person = bridge?.person;
  if (!backend || !person || typeof person.token !== 'function') {
    desktopReason = 'desktop-unavailable';
    return null;
  }
  try {
    const result = (await person.token()) as DesktopTokenResult | null;
    if (result?.ok && typeof result.token === 'string' && TOKEN_SHAPE.test(result.token)) {
      desktopReason = null;
      return { token: result.token, backend };
    }
    desktopReason = result?.error === 'DEBUG_PORT' ? 'debug-port'
      : result?.error === 'DEV_RENDERER' ? 'dev-renderer'
        : result?.error === 'UNTRUSTED_SENDER' ? 'untrusted-sender'
          : 'desktop-unavailable';
  } catch {
    desktopReason = 'desktop-unavailable';
  }
  return null;
}

/** This tab's person credential, or null when it isn't connected as the person. */
export async function personCredential(): Promise<PersonCredential | null> {
  if (typeof window === 'undefined') return null;
  if (!hasDesktopBridge()) return browserPersonCredential();
  if (!desktopLookup) desktopLookup = desktopCredential();
  return desktopLookup;
}

export async function personToken(): Promise<string | null> {
  return (await personCredential())?.token ?? null;
}

/** Ask the desktop shell again next time (a refused token may have been
 * replaced). Keeps a browser tab's stored link: only a new link replaces it. */
export function refreshPersonCredential(): void {
  desktopLookup = null;
}

/** Drop a token the backend no longer knows (it restarted with a new one). */
export function forgetPersonCredential(): void {
  memoryCredential = null;
  desktopLookup = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

export function personUnavailableReason(): PersonUnavailableReason {
  return hasDesktopBridge() && desktopReason ? desktopReason : 'not-connected';
}

export function personRequiredMessage(reason: PersonUnavailableReason = personUnavailableReason()): string {
  switch (reason) {
    case 'debug-port':
      return 'Debug mode: a remote-debugging port is open, so actions only you can take (Settings, proposals, chats) are off.';
    case 'dev-renderer':
      return 'Desktop dev mode: the Vite renderer is not trusted with your token, so Settings, proposals and chats are off. '
        + 'Set NEBULA_DESKTOP_DEV_PERSON=1 to opt in.';
    case 'untrusted-sender':
    case 'desktop-unavailable':
      return "Nebula couldn't confirm this window is yours, so Settings, proposals and chats are off. Restart the app.";
    default:
      return "This tab isn't connected as you, so Settings, proposals and chats are locked. "
        + 'Open the link the backend printed at launch (or restart it with --open).';
  }
}

/** Tell the canvas a person-only action was refused here (shows the banner). */
export function reportPersonRequired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PERSON_REQUIRED_EVENT));
}

export function onPersonRequired(listener: () => void): () => void {
  window.addEventListener(PERSON_REQUIRED_EVENT, listener);
  return () => window.removeEventListener(PERSON_REQUIRED_EVENT, listener);
}

export function onPersonConnected(listener: () => void): () => void {
  window.addEventListener(PERSON_CONNECTED_EVENT, listener);
  return () => window.removeEventListener(PERSON_CONNECTED_EVENT, listener);
}

// Pasting the link into a tab that is already open changes only the hash, so
// nothing reloads: take it in (and strip it) right away.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (!hasDesktopBridge()) browserPersonCredential();
  });
}

export function resetPersonSessionForTests(): void {
  memoryCredential = null;
  desktopLookup = null;
  desktopReason = null;
}
