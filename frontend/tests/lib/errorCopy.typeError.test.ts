import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import {
  CONNECTION_LOST_COPY, ConnectionLostError, REFUSED_FALLBACK_COPY,
  copyForError, failureCopy, failureMessage, isConnectionFailure, isNoAnswer,
} from '../../src/lib/errorCopy';
import { fetchUrl } from '../../src/lib/backend';
import { downloadSelectedOutputs } from '../../src/lib/canvasSelection';
import { downloadWorldAsset } from '../../src/lib/worldDownload';
import { fetchWorldSplatBytes } from '../../src/lib/worldSplat';

/**
 * 2026-10-24 (typeerror): copyForError said "Nebula's server isn't answering"
 * for ANY TypeError, because isConnectionFailure was written for fetch's own
 * rejection. A bug or a data problem in the browser (JSON.stringify of a
 * BigInt or a cycle, a property of undefined, a bad argument to a DOM API) is
 * a TypeError too, and sent the person to restart a server that was fine.
 * fetch's no-answer is now classified where fetch is called (apiFetch,
 * fetchUrl): a ConnectionLostError. Downstream, only that (and an AbortError
 * the caller didn't ask for) means no answer.
 */

const LOST = CONNECTION_LOST_COPY;
const GENERAL = REFUSED_FALLBACK_COPY;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const bigint = () => thrown(() => JSON.stringify({ a: 1n }));
const cycle = () => thrown(() => {
  const value: Record<string, unknown> = {};
  value.self = value;
  return JSON.stringify(value);
});
const ofUndefined = () => thrown(() => (undefined as unknown as { a: { b: number } }).a.b);
const badUrl = () => thrown(() => new URL('not a url'));

describe('copyForError: only a classified no-answer is the connection line', () => {
  it.each([
    ['JSON.stringify of a BigInt', bigint],
    ['JSON.stringify of a cycle', cycle],
    ['a property of undefined', ofUndefined],
    ['a bad argument to a DOM API (new URL)', badUrl],
  ])('%s is a TypeError that says GM\'s general line', (_name, make) => {
    const error = make();
    expect(error).toBeInstanceOf(TypeError);
    expect(copyForError(error)).toBe(GENERAL);
    expect(failureCopy(error, { heading: "Couldn't save." })).toEqual({ heading: "Couldn't save.", reason: GENERAL });
    expect(failureMessage(error, "Couldn't save.")).toBe(`Couldn't save. ${GENERAL}`);
    expect(isNoAnswer(error)).toBe(false);
  });

  it('a bare TypeError with fetch\'s words that nothing classified is not a lost connection either', () => {
    expect(copyForError(new TypeError('Failed to fetch'))).toBe(GENERAL);
  });

  it('a ConnectionLostError still says the connection line, with or without a heading', () => {
    const lost = new ConnectionLostError(new TypeError('Failed to fetch'));
    expect(copyForError(lost)).toBe(LOST);
    expect(isNoAnswer(lost)).toBe(true);
    expect(failureMessage(lost, "Couldn't save.")).toBe(`Couldn't save. ${LOST}`);
    expect(failureMessage(lost.withHeading("Couldn't load."), "Couldn't save.")).toBe(`Couldn't load. ${LOST}`);
  });

  it('an AbortError the caller didn\'t ask for is still no answer; the caller\'s own abort is not', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect(copyForError(abort)).toBe(LOST);
    const caller = new AbortController();
    caller.abort();
    expect(copyForError(abort, caller.signal)).toBe(GENERAL);
    expect(copyForError(new ConnectionLostError(abort), caller.signal)).toBe(GENERAL);
  });

  it('isConnectionFailure keeps its fetch-site meaning: fetch\'s own TypeError rejection', () => {
    expect(isConnectionFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isConnectionFailure(new TypeError('Load failed'))).toBe(true);
  });
});

describe('fetchUrl: fetch for a URL apiFetch does not make', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns fetch\'s no-answer into a ConnectionLostError under the heading, keeping the cause', async () => {
    const raw = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(raw));
    const error = await fetchUrl('/api/outputs/a.png', {}, "Couldn't load it.").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).cause).toBe(raw);
    expect((error as Error).message).toBe(`Couldn't load it. ${LOST}`);
  });

  it('passes the caller\'s own abort through as fetch threw it', async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(fetchUrl('/x', { signal: controller.signal })).rejects.toBe(abort);
  });

  it('returns the answer as fetch gave it, without Nebula\'s API headers', async () => {
    const answer = new Response('ok');
    const fetchMock = vi.fn().mockResolvedValue(answer);
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchUrl('https://example.test/a.json', { cache: 'no-store' })).resolves.toBe(answer);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/a.json', { cache: 'no-store' });
  });
});

/** URL.createObjectURL throwing a DOM TypeError: a browser-side failure after the answer came. */
function brokenObjectUrl() {
  const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => { throw new TypeError("Failed to execute 'createObjectURL' on 'URL': Overload resolution failed."); },
  });
  return () => {
    if (original) Object.defineProperty(URL, 'createObjectURL', original);
    else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  };
}

describe('each raw-fetch site: no answer is the connection line, a browser TypeError after the answer is not', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const selection = (): Node<NodeData>[] => [{
    id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
    data: { label: 'Hero', definitionId: 'flux-1-1-ultra', params: {}, state: 'complete',
      outputs: { image: { type: 'Image', value: '/api/outputs/example.png' } } } as unknown as NodeData,
  }];

  it('canvasSelection download (SelectionToolbar reads it with failureMessage)', async () => {
    const heading = "Couldn't download the outputs.";
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const lost = await downloadSelectedOutputs(selection()).catch((e: unknown) => e);
    expect(failureMessage(lost, heading)).toBe(`${heading} ${LOST}`);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })));
    restore = brokenObjectUrl();
    const broken = await downloadSelectedOutputs(selection()).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(TypeError);
    expect(broken).not.toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(broken, heading)).toBe(`${heading} ${GENERAL}`);
  });

  it('worldDownload (ModelNode, WorldPreview and MeshPreview read it with failureMessage)', async () => {
    const heading = "Couldn't download the world.";
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const lost = await downloadWorldAsset('/api/outputs/world.spz', 'world.spz').catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(lost, heading)).toBe(`${heading} ${LOST}`);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    restore = brokenObjectUrl();
    const broken = await downloadWorldAsset('/api/outputs/world.spz', 'world.spz').catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(TypeError);
    expect(failureMessage(broken, heading)).toBe(`${heading} ${GENERAL}`);
  });

  it('worldSplat: no answer is a ConnectionLostError (the viewer shows its own line)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const lost = await fetchWorldSplatBytes('/api/outputs/world.spz').catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(ConnectionLostError);
    expect(copyForError(lost)).toBe(LOST);
  });
});
