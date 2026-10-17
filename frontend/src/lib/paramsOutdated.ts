/**
 * A tab built for another params version (lib/savedParamsUpgrades.ts) is
 * stale: the backend refuses its writes and runs with 409 `params_outdated`
 * (backend/main.py `project_workspace_fence`), and graphSync and the project
 * listing carry the backend's `paramsVersion`. projectStore listens here and
 * reloads the tab, so it never saves or runs values from before an upgrade.
 */
export const PARAMS_VERSION_HEADER = 'X-Nebula-Params-Version';

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
