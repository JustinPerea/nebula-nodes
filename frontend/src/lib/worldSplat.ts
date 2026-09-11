import { utils as sparkUtils } from '@sparkjsdev/spark';
import { backendAssetUrlSync } from './backend';
import { AssetByteLimitError, readBoundedAssetResponse } from './boundedAsset';
import { isSafeWorldUrl } from './worldValue';

// Spark expands compressed SPZ data into substantially larger GPU buffers.
// Keep the source ceiling below the graph/download ceilings so an imported
// URL cannot make Explore allocate an arbitrary response before Spark starts.
export const WORLD_SPLAT_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const WORLD_SPLAT_MAX_POINTS = 2_000_000;

const SPZ_HEADER_BYTES = 16;
const SPZ_MAGIC = 0x5053474e;
const SPZ_ALLOWED_FLAGS = 0x01 | 0x80;
const SPZ_MAX_FRACTIONAL_BITS = 23;
const SPZ_SH_BYTES_PER_POINT = [0, 9, 24, 45] as const;
const LOD_POINT_LIMITS: Readonly<Record<string, number>> = {
  '100k': 100_000,
  '150k': 150_000,
  '500k': 500_000,
};

export class WorldSplatTooLargeError extends Error {}
export class WorldSplatFormatError extends Error {}

export interface FetchWorldSplatOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  variant?: string;
}

export interface WorldSpzHeader {
  version: number;
  numSplats: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
  expectedUncompressedBytes: number;
}

function invalidSpz(message: string): never {
  throw new WorldSplatFormatError(`The spatial preview is not a valid supported SPZ file (${message}).`);
}

/** Validate Spark's supported legacy gzip SPZ v1-v3 envelope before handing
 * bytes to the renderer. In particular, `numSplats` must never reach Spark's
 * allocation path until it is tied to both the chosen LOD and the gzip size. */
export function preflightWorldSpz(
  fileBytes: Uint8Array<ArrayBuffer>,
  variant?: string,
): WorldSpzHeader {
  if (fileBytes.byteLength < 18 || fileBytes[0] !== 0x1f || fileBytes[1] !== 0x8b) {
    invalidSpz('missing gzip framing');
  }

  let headerBytes: Uint8Array;
  try {
    headerBytes = sparkUtils.decompressPartialGzip(fileBytes, SPZ_HEADER_BYTES);
  } catch {
    invalidSpz('header could not be decompressed');
  }
  if (headerBytes.byteLength !== SPZ_HEADER_BYTES) invalidSpz('truncated header');

  const header = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength,
  );
  const magic = header.getUint32(0, true);
  const version = header.getUint32(4, true);
  const numSplats = header.getUint32(8, true);
  const shDegree = header.getUint8(12);
  const fractionalBits = header.getUint8(13);
  const flags = header.getUint8(14);
  const reserved = header.getUint8(15);

  if (magic !== SPZ_MAGIC) invalidSpz('invalid NGSP magic');
  if (version < 1 || version > 3) invalidSpz('unsupported version');
  if (shDegree > 3) invalidSpz('unsupported spherical-harmonics degree');
  if (fractionalBits > SPZ_MAX_FRACTIONAL_BITS) invalidSpz('invalid coordinate precision');
  if ((flags & ~SPZ_ALLOWED_FLAGS) !== 0) invalidSpz('unsupported flags');
  if (reserved !== 0) invalidSpz('reserved byte is not zero');
  if (numSplats === 0) invalidSpz('empty splat set');

  const pointLimit = Math.min(LOD_POINT_LIMITS[variant ?? ''] ?? WORLD_SPLAT_MAX_POINTS, WORLD_SPLAT_MAX_POINTS);
  if (numSplats > pointLimit) {
    throw new WorldSplatTooLargeError(
      `This spatial preview declares ${numSplats.toLocaleString()} splats, above the safe ${pointLimit.toLocaleString()}-splat limit.`,
    );
  }

  const positionBytes = version === 1 ? 6 : 9;
  const rotationBytes = version === 3 ? 4 : 3;
  const lodBytes = (flags & 0x80) !== 0 ? 6 : 0;
  const bytesPerPoint = positionBytes + 1 + 3 + 3 + rotationBytes
    + SPZ_SH_BYTES_PER_POINT[shDegree] + lodBytes;
  const expectedUncompressedBytes = SPZ_HEADER_BYTES + numSplats * bytesPerPoint;
  if (!Number.isSafeInteger(expectedUncompressedBytes)) invalidSpz('declared size overflow');

  // Fast size check against the final gzip trailer. Full streamed inflation
  // below also verifies CRC/integrity and rejects extra concatenated payload.
  if (expectedUncompressedBytes < 0x1_0000_0000) {
    const compressed = new DataView(
      fileBytes.buffer,
      fileBytes.byteOffset,
      fileBytes.byteLength,
    );
    const gzipISize = compressed.getUint32(fileBytes.byteLength - 4, true);
    if (gzipISize !== expectedUncompressedBytes) invalidSpz('gzip size does not match its header');
  }

  return { version, numSplats, shDegree, fractionalBits, flags, expectedUncompressedBytes };
}

async function validateWorldSpzInflation(
  fileBytes: Uint8Array<ArrayBuffer>,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof DecompressionStream === 'undefined') {
    invalidSpz('this browser cannot verify gzip integrity');
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const abort = () => {
    void reader?.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  let inflatedBytes = 0;
  try {
    signal?.throwIfAborted();
    const compressed = new Response(fileBytes).body;
    if (!compressed) invalidSpz('gzip stream is unavailable');
    const inflated = compressed.pipeThrough(new DecompressionStream('gzip'));
    reader = inflated.getReader();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      inflatedBytes += value.byteLength;
      if (inflatedBytes > expectedBytes) {
        await reader.cancel('SPZ inflated beyond its declared size');
        invalidSpz('gzip payload exceeds its declared point data');
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (error instanceof WorldSplatFormatError) throw error;
    invalidSpz('gzip integrity check failed');
  } finally {
    signal?.removeEventListener('abort', abort);
    reader?.releaseLock();
  }

  if (inflatedBytes !== expectedBytes) {
    invalidSpz('gzip payload does not match its declared point data');
  }
}

/** Fetch one SPZ source with both declared-size and streamed-size bounds.
 * This applies to every resolution, including explicitly selected full or
 * future variants whose labels cannot be trusted as a size declaration. */
export async function fetchWorldSplatBytes(
  url: string,
  options: FetchWorldSplatOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isSafeWorldUrl(url)) throw new Error('The spatial preview URL is not safe to load.');

  let response: Response;
  try {
    response = await fetch(backendAssetUrlSync(url), {
      signal: options.signal,
      // Output files can be archived or deleted independently of the graph.
      // Never let the browser resurrect an SPZ that the backend no longer owns.
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The spatial preview could not be reached.');
  }

  if (!response.ok) {
    throw new Error(`The spatial preview server returned HTTP ${response.status}.`);
  }

  try {
    const bytes = await readBoundedAssetResponse(
      response,
      options.maxBytes ?? WORLD_SPLAT_MAX_SOURCE_BYTES,
    );
    const header = preflightWorldSpz(bytes, options.variant);
    await validateWorldSpzInflation(bytes, header.expectedUncompressedBytes, options.signal);
    return bytes;
  } catch (error) {
    if (error instanceof AssetByteLimitError || error instanceof WorldSplatTooLargeError) {
      throw new WorldSplatTooLargeError(
        error instanceof WorldSplatTooLargeError
          ? error.message
          : 'This spatial preview is too large to open safely in the browser. Download it for a desktop 3D viewer instead.',
      );
    }
    throw error;
  }
}
