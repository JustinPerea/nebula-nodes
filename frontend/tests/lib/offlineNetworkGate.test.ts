import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getBackendBaseUrl } from '../../src/lib/backend';
import {
  noteBackendConnection, OfflineRefusal, resetBackendConnectionForTests, subscribeBlockedEdits,
} from '../../src/lib/backendConnection';
import { copyForError, failureCopy, failureUnder } from '../../src/lib/errorCopy';
import { CANVAS_NOTICE_EVENT, showNotice } from '../../src/lib/canvasNotice';

/**
 * Round 15 of PR #114 (review 14, M2: "one gate" was not one gate). The
 * network layer is the gate every write passes: while Nebula is offline,
 * apiFetch sends no request but GET and HEAD, throws an OfflineRefusal and
 * pulses the banner; the refusal has no words of its own (no toast).
 */

let blocked = 0;
let stop: () => void = () => {};
beforeAll(async () => { await getBackendBaseUrl(); });
beforeEach(() => {
  resetBackendConnectionForTests();
  blocked = 0;
  stop = subscribeBlockedEdits(() => { blocked += 1; });
});
afterEach(() => { stop(); vi.unstubAllGlobals(); });

describe('apiFetch while offline', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('a %s is not sent: OfflineRefusal, and the banner pulses', async (method) => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    noteBackendConnection('offline');
    const error = await apiFetch('/api/projects/A', { method }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineRefusal);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(blocked).toBe(1);
  });

  it.each(['GET', 'HEAD', undefined])('a %s still goes (reads, and the health probe)', async (method) => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    noteBackendConnection('offline');
    await apiFetch('/api/health', method ? { method } : undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(blocked).toBe(0);
  });

  it('back online, the same write is sent', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    noteBackendConnection('offline');
    noteBackendConnection('online');
    await apiFetch('/api/projects/A', { method: 'PUT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('an OfflineRefusal has no words (no toast, no line)', () => {
  const refusal = new OfflineRefusal('POST', '/api/execute');
  it('errorCopy gives it none', () => {
    expect(failureCopy(refusal)).toEqual({ heading: '', reason: '' });
    expect(failureUnder(refusal, "Couldn't start the run.")).toBe('');
    expect(copyForError(refusal)).toBe('');
  });
  it('an empty canvas notice shows nothing', () => {
    const seen: unknown[] = [];
    const listener = (event: Event) => { seen.push(event); };
    window.addEventListener(CANVAS_NOTICE_EVENT, listener);
    showNotice('');
    window.removeEventListener(CANVAS_NOTICE_EVENT, listener);
    expect(seen).toEqual([]);
  });
});
