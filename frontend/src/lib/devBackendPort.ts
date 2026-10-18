/**
 * Which backend port(s) a browser/Vite dev frontend may talk to.
 *
 * Shared by vite.config.ts (the /api and /ws proxy) and the page itself
 * (backend.ts discovery, personSession.ts links), so one setting moves both:
 *
 *   VITE_NEBULA_BACKEND_PORT=8155 npm run dev -- --port 5275 --strictPort
 *
 * With it set, the proxy goes to 127.0.0.1:8155 and the page talks to port
 * 8155 only: no 8000-8010 scan, no stored URL from an earlier run, and a
 * person link naming another backend is refused. That keeps a second, test
 * frontend off the person's own backend on 8000.
 *
 * With nothing set, nothing changes: the proxy goes to 8000 and the page scans
 * DEFAULT_BACKEND_PORTS (or VITE_NEBULA_BACKEND_PORTS, the older scan-list
 * override). The desktop app ignores all of this; its preload bridge injects
 * the sidecar's address and backend.ts uses that first.
 *
 * Pure functions only: this file is bundled into vite.config.ts (Node) as well
 * as the browser build, so it must not read import.meta.env or window.
 */

export const DEFAULT_BACKEND_PORT = 8000;
export const DEFAULT_BACKEND_PORTS: readonly number[] = [
  8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010,
];

export const BACKEND_PORT_ENV = 'VITE_NEBULA_BACKEND_PORT';

export interface BackendPortEnv {
  /** VITE_NEBULA_BACKEND_PORT: the one backend this frontend may use. */
  port?: string;
  /** VITE_NEBULA_BACKEND_PORTS: the scan list (comma-separated). */
  ports?: string;
  /** VITE_NEBULA_API_BASE: an explicit backend origin. */
  apiBase?: string;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/**
 * The pinned backend port, or null when VITE_NEBULA_BACKEND_PORT is unset.
 * A value that is set but isn't a port throws: falling back to the 8000-8010
 * scan would quietly undo the isolation the setting asks for.
 */
export function pinnedBackendPort(raw: string | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!validPort(port)) {
    throw new Error(`${BACKEND_PORT_ENV}=${JSON.stringify(text)} is not a port number (1-65535).`);
  }
  return port;
}

/** The ports discovery may probe, in order. */
export function backendPortsFor(env: BackendPortEnv): number[] {
  const pinned = pinnedBackendPort(env.port);
  if (pinned !== null) return [pinned];

  const raw = env.ports?.trim();
  if (!raw) return [...DEFAULT_BACKEND_PORTS];

  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter(validPort);

  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_BACKEND_PORTS];
}

/** The port the Vite dev server proxies /api and /ws to. */
export function devProxyPort(env: BackendPortEnv): number {
  return pinnedBackendPort(env.port) ?? DEFAULT_BACKEND_PORT;
}

/** The port of an http(s) origin, filling in the scheme's default. */
export function originPort(origin: string): number | null {
  try {
    const url = new URL(origin);
    if (url.port) return Number(url.port);
    if (url.protocol === 'http:') return 80;
    if (url.protocol === 'https:') return 443;
    return null;
  } catch {
    return null;
  }
}

/** True unless a pin is set and `origin` is on a different port. */
export function originAllowedByPin(origin: string, env: BackendPortEnv): boolean {
  const pinned = pinnedBackendPort(env.port);
  return pinned === null || originPort(origin) === pinned;
}

/**
 * Throw when the settings contradict each other: a pin plus an explicit
 * VITE_NEBULA_API_BASE on another port. vite.config.ts calls this at startup
 * so the mistake stops the dev server instead of reaching the wrong backend.
 */
export function assertBackendEnvConsistent(env: BackendPortEnv): void {
  const pinned = pinnedBackendPort(env.port);
  const apiBase = env.apiBase?.trim();
  if (pinned === null || !apiBase) return;
  if (originPort(apiBase) !== pinned) {
    throw new Error(
      `${BACKEND_PORT_ENV}=${pinned} and VITE_NEBULA_API_BASE=${apiBase} name different backends. ` +
        'Set one of them.',
    );
  }
}
