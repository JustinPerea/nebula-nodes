import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { readBoundedAssetResponse } from '../../src/lib/boundedAsset';
import { downloadWorldAsset } from '../../src/lib/worldDownload';
import { fetchWorldSplatBytes } from '../../src/lib/worldSplat';
import { downloadSelectedOutputs } from '../../src/lib/canvasSelection';
import {
  CONNECTION_LOST_COPY,
  ConnectionLostError,
  REFUSED_FALLBACK_COPY,
  failureMessage,
} from '../../src/lib/errorCopy';

// typeerror review (2026-10-24): fetch answers, then the connection drops
// while the body streams. The read rejects with fetch's own TypeError, which
// is a no-answer and must be classified at the read, the way fetchUrl
// classifies fetch()'s own rejection.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function droppingBody(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    pull(controller) { controller.error(new TypeError('network error')); },
  }));
}

describe('readBoundedAssetResponse body drops', () => {
  it('turns a stream that errors mid-body into a ConnectionLostError under the caller heading', async () => {
    const error = await readBoundedAssetResponse(droppingBody(), 1000, { heading: 'Couldn\'t load it.' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as ConnectionLostError).heading).toBe("Couldn't load it.");
    expect(failureMessage(error, 'Other heading.')).toBe(`Couldn't load it. ${CONNECTION_LOST_COPY}`);
  });

  it('without a heading, the catch supplies its own', async () => {
    const error = await readBoundedAssetResponse(droppingBody(), 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, 'Mine.')).toBe(`Mine. ${CONNECTION_LOST_COPY}`);
  });

  it('a TypeError outside the read (a locked body, a bug) stays a TypeError and reads the general line', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    response.body!.getReader(); // locks the body
    const error = await readBoundedAssetResponse(response, 1000, { heading: 'H.' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, 'H.')).toBe(`H. ${REFUSED_FALLBACK_COPY}`);
  });

  it('a used body is a bug, not a no-answer', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    await response.arrayBuffer();
    const error = await readBoundedAssetResponse(response, 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConnectionLostError);
  });

  it("the caller's own abort comes back unchanged", async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(abort); },
    }));
    const error = await readBoundedAssetResponse(response, 1000, { heading: 'H.' }).catch((e: unknown) => e);
    expect(error).toBe(abort);
  });
});

describe('asset sites keep the connection line for a body drop', () => {
  it('downloadWorldAsset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => droppingBody()));
    const error = await downloadWorldAsset('/api/outputs/world.spz', 'world.spz', {
      heading: "Couldn't download the 3D model.",
    }).catch((e: unknown) => e);
    expect(failureMessage(error, "Couldn't download the 3D model."))
      .toBe(`Couldn't download the 3D model. ${CONNECTION_LOST_COPY}`);
  });

  it('fetchWorldSplatBytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => droppingBody()));
    const error = await fetchWorldSplatBytes('/api/outputs/world.spz').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(failureMessage(error, 'X.')).toBe(`Couldn't load the world. ${CONNECTION_LOST_COPY}`);
  });

  it('downloadSelectedOutputs says the connection line, not "too large"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => droppingBody()));
    const selection = [{
      id: 'n1',
      type: 'model-node',
      position: { x: 0, y: 0 },
      selected: true,
      data: { label: 'Node n1', definitionId: 'text-input', params: {}, state: 'idle', outputs: { image: { type: 'Image', value: '/api/outputs/n1.png' } } },
    }] as unknown as Node<NodeData>[];
    const error = await downloadSelectedOutputs(selection).catch((e: unknown) => e);
    expect(failureMessage(error, "Couldn't download the outputs."))
      .toBe(`Couldn't download the outputs. ${CONNECTION_LOST_COPY}`);
  });
});
