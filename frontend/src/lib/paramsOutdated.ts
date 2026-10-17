/**
 * A tab built for another params version (lib/savedParamsUpgrades.ts) is
 * stale: the backend refuses its writes and runs with 409 `params_outdated`
 * (backend/main.py `project_workspace_fence`), and graphSync and the project
 * listing carry the backend's `paramsVersion`. projectStore listens here and
 * reloads the tab, so it never saves or runs values from before an upgrade.
 */
export const PARAMS_VERSION_HEADER = 'X-Nebula-Params-Version';

/** The params version a backend reports (graphSync, the project listing,
 * create and open replies). A backend that sends none predates the gate, and
 * with it the version marker: version 0. Its values may be from before an
 * upgrade, so this bundle must not load, save or run through it. */
export function backendParamsVersion(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

/** `backendVersion` is null when the refusal didn't say. */
type Listener = (backendVersion: number | null) => void;
const listeners = new Set<Listener>();

export function onParamsOutdated(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportParamsOutdated(backendVersion: number | null): void {
  for (const listener of [...listeners]) listener(backendVersion);
}

/** Reads a refusal's body without consuming the caller's response. */
export function noteParamsOutdated(response: Response): void {
  if (response.status !== 409 || typeof response.clone !== 'function') return;
  void response.clone().json()
    .then((body: { code?: unknown; paramsVersion?: unknown } | null) => {
      if (body?.code !== 'params_outdated') return;
      reportParamsOutdated(Number.isInteger(body.paramsVersion) ? body.paramsVersion as number : null);
    })
    .catch(() => { /* not JSON: not a params-version refusal */ });
}

/** A seam for tests: jsdom can't reload. */
export function reloadPage(): void {
  window.location.reload();
}
