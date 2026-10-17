import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetch, getBackendBaseUrl } from '../../src/lib/backend';
import { onParamsOutdated } from '../../src/lib/paramsOutdated';
import { setProjectContext } from '../../src/lib/projectContext';
import { GRAPH_PARAMS_VERSION } from '../../src/lib/savedParamsUpgrades';

// Every request says which params version this bundle was built for, so the
// backend can refuse a tab loaded before a one-time upgrade (backend/main.py
// project_workspace_fence). Its refusal (409 params_outdated) is reported.
beforeAll(async () => { await getBackendBaseUrl(); });
afterEach(() => { vi.unstubAllGlobals(); setProjectContext(null); });

function sent(fetchMock: ReturnType<typeof vi.fn>, index = 0): Headers {
  return new Headers((fetchMock.mock.calls[index][1] as RequestInit).headers);
}
const ok = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('params version header', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('is on every %s, with or without a project open', async (method) => {
    for (const project of [null, { id: 'alpha', revision: 'rev-a' }]) {
      setProjectContext(project);
      const fetchMock = vi.fn(async () => ok());
      vi.stubGlobal('fetch', fetchMock);
      await apiFetch('/api/projects', { method, headers: { 'Content-Type': 'application/json' } });
      const headers = sent(fetchMock);
      expect(headers.get('X-Nebula-Params-Version')).toBe(String(GRAPH_PARAMS_VERSION));
      expect(headers.get('Content-Type')).toBe('application/json');
      // The revision still goes only on a canvas write.
      expect(headers.get('X-Nebula-Workspace-Revision')).toBe(project && method !== 'GET' ? 'rev-a' : null);
    }
  });

  it('is on a request with no init at all', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/graph/export');
    expect(sent(fetchMock).get('X-Nebula-Params-Version')).toBe(String(GRAPH_PARAMS_VERSION));
  });
});

describe('params_outdated refusals', () => {
  it('reports the backend version from a 409 params_outdated and leaves the body for the caller', async () => {
    const seen: Array<number | null> = [];
    const stop = onParamsOutdated((version) => { seen.push(version); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'params_outdated', detail: 'Reload the tab', paramsVersion: GRAPH_PARAMS_VERSION + 1 }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));
    const response = await apiFetch('/api/execute', { method: 'POST' });
    expect((await response.json()).detail).toBe('Reload the tab');
    await vi.waitFor(() => expect(seen).toEqual([GRAPH_PARAMS_VERSION + 1]));
    stop();
  });

  it('ignores other conflicts', async () => {
    const seen: Array<number | null> = [];
    const stop = onParamsOutdated((version) => { seen.push(version); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'This canvas is out of date.' }), { status: 409 },
    )));
    await apiFetch('/api/execute', { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([]);
    stop();
  });
});
