/**
 * Error copy round 3f (GM - Design): the Projects startup line and the
 * provider-readiness line.
 *
 * GM: "Projects startup: drop "That didn't work." → "Couldn't load your
 * projects. Try again, or reload the page if it keeps happening." A full disk
 * is the one cause a person can fix, so give it its own line: "Couldn't load
 * your projects. Your disk is full. Free up some space, then try again.""
 *
 * The full disk is read from the answer, not its words: the backend's storage
 * refusal (507) carries an additive `storage: "full"` when an ENOSPC/EDQUOT
 * OSError is in its causes (main._storage_error_body).
 *
 * GM: the provider-readiness line "should become "Couldn't check the
 * connections. Nebula's server isn't answering. Make sure it's running, then
 * try again."" That is a request with no answer; an answered failure says
 * the request's own line under the same heading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(), apiFetch: fetch,
}));
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  holdsPersonCredential: () => true,
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { resetProjectStoreForTests, useProjectStore } from '../src/store/projectStore';
import { useProviderReadinessStore } from '../src/store/providerReadinessStore';
import { RequestFailedError, requestError } from '../src/lib/errorCopy';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });
const FULL = { detail: 'Project storage could not be written: [Errno 28] No space left on device', storage: 'full' };

const initial = useProjectStore.getState();
beforeEach(() => { fetch.mockReset(); useProjectStore.setState(initial, true); resetProjectStoreForTests(); });
afterEach(() => { useProviderReadinessStore.getState().invalidate(); });

describe('a storage refusal says whether the disk is full, from the answer', () => {
  it('reads the additive storage field', async () => {
    const error = await requestError("Couldn't load your projects.", json(507, FULL));
    expect(error).toBeInstanceOf(RequestFailedError);
    expect(error.storageFull).toBe(true);
    // The agents' text stays the error's detail, word for word.
    expect(error.detail).toBe(FULL.detail);
  });

  it('never from the words', async () => {
    const error = await requestError("Couldn't load your projects.", json(507, { detail: FULL.detail }));
    expect(error.storageFull).toBe(false);
  });
});

describe('the Projects startup line', () => {
  it('a full disk gets its own line', async () => {
    fetch.mockResolvedValueOnce(json(507, FULL));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error)
      .toBe("Couldn't load your projects. Your disk is full. Free up some space, then try again.");
  });

  it('a storage refusal that isn\'t a full disk keeps the status line', async () => {
    fetch.mockResolvedValueOnce(json(507, { detail: 'Project storage could not be written: [Errno 13] Permission denied' }));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error).toBe("Couldn't load your projects. Nebula didn't respond. Try again.");
  });

  it('anything else drops "That didn\'t work." and says "reload the page"', async () => {
    fetch.mockRejectedValueOnce(new Error('internal: snapshot.nodes is not iterable'));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error)
      .toBe("Couldn't load your projects. Try again, or reload the page if it keeps happening.");
  });

  it('no answer: the server on this computer', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useProjectStore.getState().initialize();
    expect(useProjectStore.getState().error)
      .toBe("Couldn't load your projects. Nebula's server isn't answering. Make sure it's running, then try again.");
  });
});

describe('the provider-readiness line', () => {
  it('no answer: GM\'s line', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState().error)
      .toBe("Couldn't check the connections. Nebula's server isn't answering. Make sure it's running, then try again.");
  });

  it('an answered failure is not "isn\'t answering"', async () => {
    fetch.mockResolvedValueOnce(json(503, {}));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState().error).toBe("Couldn't check the connections. Nebula didn't respond. Try again.");
  });
});
