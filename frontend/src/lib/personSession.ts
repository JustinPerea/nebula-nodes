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
/** A person link was taken in by this tab (the canvas says hello again, or
 * reconnects to). Not proof: only the server's promote clears the hold. */
export const PERSON_CONNECTED_EVENT = 'nebula:person-connected';
/** The server promoted this tab's canvas socket as the person (a verified
 * hello, by any path: a new link, the same link reopened, a reconnect, the
 * desktop app's token). See notePersonPromoted. */
export const PERSON_PROMOTED_EVENT = 'nebula:person-promoted';

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

/** Whether this page runs in the desktop app (its shell hands over the
 * person token), not a plain browser tab. Error copy reads it (GM,
 * error-copy round 2): a reload helps in the app, a fresh link in a tab. */
export function inDesktopShell(): boolean {
  return hasDesktopBridge();
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

/** Whether an address's hash (`#…`) is a person link, before it is taken in. */
export function isPersonLinkHash(hash: string): boolean {
  if (!hash || hash === '#') return false;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return LINK_KEYS.some((key) => params.has(key));
}

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
    memoryCredential = fromLink;
    writeStored(fromLink);
    // GM r29 item 3 (fix round 19): the same link reopened (the banner's own
    // fix) is said hello with too, so the server can promote this tab again.
    window.dispatchEvent(new CustomEvent(PERSON_CONNECTED_EVENT));
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

/** Whether this tab holds the person's credential right now. Not proof (the
 * backend checks the token), but it is what decides whether this tab's zoom
 * and pan are the project's saved view (design-canvas gap 19). */
export function holdsPersonCredential(): boolean {
  if (typeof window === 'undefined') return false;
  if (hasDesktopBridge()) return desktopReason === null;
  return browserPersonCredential() !== null;
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
    // GM, round 4 (2026-10-23), verbatim: a banner stays up, so it fits one
    // line at the region's 560 px (the dev-renderer one is developer-only and
    // may wrap). Line 3 on the refusal still says what to do.
    case 'debug-port':
      return 'Debug mode: a debugging port is open, so Settings, proposals and chats are off.';
    case 'dev-renderer':
      return "Dev mode: the Vite renderer can’t use your token. Set NEBULA_DESKTOP_DEV_PERSON=1 to allow it.";
    case 'untrusted-sender':
    case 'desktop-unavailable':
      // GM, round 4 (2026-10-23), verbatim: one line, ending like the app
      // banner, since the window can close while Nebula keeps running in the Dock.
      return "Nebula couldn’t confirm this window is yours. Quit Nebula and open it again.";
    default:
      // The desktop app gets here when its backend refuses the token the
      // shell handed over (desktopReason stays null then): GM's app banner
      // (round 4, 2026-10-23, verbatim). A quit and reopen starts a fresh
      // backend with a fresh token; a reload asks the same shell for the same
      // token, which the same backend refuses again.
      if (hasDesktopBridge()) {
        return "This window isn’t connected as you. Quit Nebula and open it again.";
      }
      // GM - Design, round 4 (2026-10-23), verbatim.
      return "This tab isn’t connected as you. Open the link Nebula printed when it started.";
  }
}

// GM r24 (PR #200 fix round 15): whether the person-gate banner is showing
// now, its line or null. PersonRequiredBanner keeps it; the note dialog
// reads it (Send note waits for the tab to be connected, and a refused
// send's toast leaves the fix to the banner).
let personBannerLine: string | null = null;
const personBannerListeners = new Set<() => void>();
export function setPersonBannerLine(line: string | null): void {
  if (line === personBannerLine) return;
  personBannerLine = line;
  personBannerListeners.forEach((listener) => listener());
}
export const personBannerShown = (): boolean => personBannerLine !== null;
export const currentPersonBannerLine = (): string | null => personBannerLine;
export function subscribePersonBanner(listener: () => void): () => void {
  personBannerListeners.add(listener);
  return () => { personBannerListeners.delete(listener); };
}

/**
 * GM r27 item 2 (PR #200 fix round 18): the banner's × hides the banner, not
 * the condition. Whether this tab is known not to be connected as the person:
 * set by any person-only refusal (PERSON_REQUIRED_EVENT, which also shows the
 * banner), cleared only when a person link connects the tab. The note dialog
 * holds Send note on it, so after × Send note stays disabled with its reason
 * and never brings up the Q116a toast.
 */
let personGateHeldNow = false;
/**
 * GM, PR #204 r5 item 2 ("held is a state, not a path"): whether this page's
 * canvas socket has answered who it is since the page loaded, either way: the
 * person-only `proposalSync` (promoted) or a refusal (`personRequired`, no
 * token, a 403 person_required). Until then the tab isn't confirmed as the
 * person, so what only the person may open stays locked (heldLock). Tests
 * start answered, as the connected tab they render; a test of the load
 * window resets to unanswered (resetPersonSessionForTests).
 */
let personGateAnsweredNow = import.meta.env.MODE === 'test';
const personGateListeners = new Set<() => void>();
function setPersonGateHeld(held: boolean): void {
  if (held === personGateHeldNow && personGateAnsweredNow) return;
  personGateHeldNow = held;
  personGateAnsweredNow = true;
  personGateListeners.forEach((listener) => listener());
}
export const personGateHeld = (): boolean => personGateHeldNow;
/** The socket has answered since load (promoted or refused). */
export const personGateAnswered = (): boolean => personGateAnsweredNow;
/** Not confirmed as the person: held, or no answer yet since load. One state
 * for every lock on what only the person may open (GM r5 item 2). */
export const personUnconfirmed = (): boolean => personGateHeldNow || !personGateAnsweredNow;
export function subscribePersonGate(listener: () => void): () => void {
  personGateListeners.add(listener);
  return () => { personGateListeners.delete(listener); };
}
// GM r29 item 3 (fix round 19): the hold follows the server's state both
// ways. Demoted (a hello the server refuses, its `personRequired` frame, or a
// person-only request refused 403 person_required, all PERSON_REQUIRED_EVENT):
// the hold and the banner come back. Promoted (notePersonPromoted, from the
// socket): both clear. A link the tab takes in isn't proof by itself.
if (typeof window !== 'undefined') {
  window.addEventListener(PERSON_REQUIRED_EVENT, () => setPersonGateHeld(true));
}

/**
 * Review 3 LOW-1 (#204 r5): how many times the server has promoted this tab,
 * and which answers came to requests sent before the latest promote. A
 * refusal of such a request is the old state's answer, not the tab's now:
 * it holds nothing (lib/backend notePersonRequired), and a line it puts up
 * clears at once (lib/clearsOnPromote), since the sweep it waited for has run.
 */
let personPromotionsNow = 0;
export const personPromotions = (): number => personPromotionsNow;
const answeredAfterPromote = new WeakSet<object>();
/** Mark an answer whose request was sent before the latest promote. */
export function noteSentBeforePromote(response: object): void {
  answeredAfterPromote.add(response);
}
export function sentBeforePromote(response: object): boolean {
  return answeredAfterPromote.has(response);
}

/** The server promoted this tab's canvas socket as the person: its hello was
 * verified (lib/wsClient sees the person-only `proposalSync` the backend sends
 * on promote, and only then). Clears the hold and the banner. */
export function notePersonPromoted(): void {
  personPromotionsNow += 1;
  setPersonGateHeld(false);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PERSON_PROMOTED_EVENT));
}

export function onPersonPromoted(listener: () => void): () => void {
  window.addEventListener(PERSON_PROMOTED_EVENT, listener);
  return () => window.removeEventListener(PERSON_PROMOTED_EVENT, listener);
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

export function resetPersonSessionForTests({ unanswered = false }: { unanswered?: boolean } = {}): void {
  setPersonBannerLine(null);
  setPersonGateHeld(false);
  if (unanswered) {
    personGateAnsweredNow = false;
    personGateListeners.forEach((listener) => listener());
  }
  memoryCredential = null;
  desktopLookup = null;
  desktopReason = null;
}
