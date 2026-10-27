import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getBackendBaseUrl } from '../../src/lib/backend';
import {
  OFFLINE_CANCEL_ALLOWLIST, OFFLINE_QUIET_WRITES, OfflineRefusal, isOfflineCancel, noteBackendConnection,
  resetBackendConnectionForTests, subscribeBlockedEdits, subscribeOfflinePulse,
} from '../../src/lib/backendConnection';
import { cancelExecution } from '../../src/lib/api';
import { cancelRenderJob } from '../../src/lib/renderJobs';

/**
 * Round 16 of PR #114, M1: Stop gets through the offline gate. Every request
 * that only reduces work or spend is on one named allowlist and is sent while
 * the tab thinks Nebula is offline (a false offline must never trap a paid run
 * the person wants stopped). Nothing that starts work or spends is on it.
 */

let blocked = 0;
let pulses = 0;
const stops: (() => void)[] = [];
beforeAll(async () => { await getBackendBaseUrl(); });
beforeEach(() => {
  resetBackendConnectionForTests();
  blocked = 0;
  pulses = 0;
  stops.push(subscribeBlockedEdits(() => { blocked += 1; }), subscribeOfflinePulse(() => { pulses += 1; }));
});
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('the cancel allowlist', () => {
  it('is exactly these three requests', () => {
    expect(OFFLINE_CANCEL_ALLOWLIST.map(({ method, pattern }) => `${method} ${pattern.source}`)).toEqual([
      'DELETE ^\\/api\\/executions\\/[A-Za-z0-9_-]{1,128}$',
      'DELETE ^\\/api\\/render-jobs\\/[A-Za-z0-9_-]{1,128}$',
      'POST ^\\/api\\/commons\\/worker\\/stop$',
    ]);
  });

  // Every Stop control's request: the bottom Stop, Run History's Cancel,
  // Create's "Stop N" and Cinema's Stop scene / Stop shot all call
  // cancelExecution; the editor's render Cancel calls cancelRenderJob; the
  // Commons status line's Stop calls commonsApi.workerStop.
  it.each([
    ['run Stop', () => cancelExecution('0b8e7c1e-5d3c-4e6a-9d5f-4f2b8a1c9e70')],
    ['Cinema shot Stop', () => cancelExecution('cinema-shot-3f2a9c')],
    ['render Cancel', () => cancelRenderJob('job_42')],
    ['Commons worker Stop', () => apiFetch('/api/commons/worker/stop', { method: 'POST' })],
  ])('%s is sent while offline, with no pulse', async (_name, send) => {
    const fetchMock = vi.fn(async () => json({ runId: 'x', status: 'cancelled' }));
    vi.stubGlobal('fetch', fetchMock);
    noteBackendConnection('offline');
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(blocked).toBe(0);
    expect(pulses).toBe(0);
  });

  // Anything that starts work, spends, or lowers a safeguard stays refused.
  it.each([
    ['POST', '/api/execute'],
    ['POST', '/api/execute-node'],
    ['POST', '/api/cinema/generate-shot'],
    ['POST', '/api/commons/worker/start'],
    ['POST', '/api/remotion-render'],
    ['POST', '/api/canvas/proposals/p1/accept'],
    ['DELETE', '/api/graph?force=true'],
    ['DELETE', '/api/provider-recoveries/run/n1?resume_operation_id=op'],
    ['DELETE', '/api/provider-start-ambiguities/worldlabs-environment/n1/run'],
    ['DELETE', '/api/executions/'],
    ['DELETE', '/api/executions/..'],
    ['DELETE', '/api/executions/%2e%2e'],
    ['DELETE', '/api/executions/run/../../graph'],
    ['DELETE', '/api/executions/run?force=true'],
    ['POST', '/api/executions/run'],
    ['PUT', '/api/commons/worker/stop'],
    ['POST', '/api/commons/worker/stop/../start'],
  ])('%s %s is not on it', async (method, path) => {
    expect(isOfflineCancel(method, path)).toBe(false);
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    noteBackendConnection('offline');
    const error = await apiFetch(path, { method }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineRefusal);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('view-state reports while offline (L1: allowed, no pulse)', () => {
  it('lists the background reports that are not edits', () => {
    expect(OFFLINE_QUIET_WRITES.map(({ method, pattern }) => `${method} ${pattern.source}`)).toEqual([
      'POST ^\\/api\\/canvas\\/selection$',
      'POST ^\\/api\\/canvas\\/view$',
      'POST ^\\/api\\/pricing\\/input-sizes$',
      'POST ^\\/api\\/zoom-manifest\\/(?:init|entry)$',
    ]);
  });

  it.each(['/api/canvas/selection', '/api/canvas/view', '/api/pricing/input-sizes', '/api/zoom-manifest/entry'])(
    '%s is held back without a pulse', async (path) => {
      const fetchMock = vi.fn(async () => json({}));
      vi.stubGlobal('fetch', fetchMock);
      noteBackendConnection('offline');
      const error = await apiFetch(path, { method: 'POST' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OfflineRefusal);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(blocked).toBe(0);
      expect(pulses).toBe(0);
    });
});
