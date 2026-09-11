import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWorldSplatBytes,
  preflightWorldSpz,
  WorldSplatFormatError,
  WorldSplatTooLargeError,
} from '../../src/lib/worldSplat';

function spzBytes({
  version = 3,
  numSplats = 1,
  shDegree = 0,
  fractionalBits = 12,
  flags = 0,
  reserved = 0,
  magic = 0x5053474e,
}: {
  version?: number;
  numSplats?: number;
  shDegree?: number;
  fractionalBits?: number;
  flags?: number;
  reserved?: number;
  magic?: number;
} = {}): Uint8Array<ArrayBuffer> {
  const positionBytes = version === 1 ? 6 : 9;
  const rotationBytes = version === 3 ? 4 : 3;
  const shBytes = [0, 9, 24, 45][shDegree] ?? 0;
  const lodBytes = (flags & 0x80) !== 0 ? 6 : 0;
  const bytesPerPoint = positionBytes + 1 + 3 + 3 + rotationBytes + shBytes + lodBytes;
  const payloadSize = 16 + Math.min(numSplats, 10) * bytesPerPoint;
  const payload = new Uint8Array(payloadSize);
  const header = new DataView(payload.buffer);
  header.setUint32(0, magic, true);
  header.setUint32(4, version, true);
  header.setUint32(8, numSplats, true);
  header.setUint8(12, shDegree);
  header.setUint8(13, fractionalBits);
  header.setUint8(14, flags);
  header.setUint8(15, reserved);
  return new Uint8Array(gzipSync(payload));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded World splat loading', () => {
  it('loads a local SPZ without reusing a browser-cached deleted output', async () => {
    const bytes = spzBytes();
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorldSplatBytes('/api/outputs/run/world.spz', { maxBytes: bytes.byteLength }))
      .resolves.toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/outputs/run/world.spz',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('rejects a declared oversized source before reading it', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': '101' },
    });
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(fetchWorldSplatBytes('/api/outputs/world.spz', { maxBytes: 100 }))
      .rejects.toBeInstanceOf(WorldSplatTooLargeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('cancels an undeclared stream as soon as actual bytes exceed the cap', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => {
          let readCount = 0;
          return {
            read: vi.fn(async () => {
              readCount += 1;
              return readCount === 1
                ? { done: false, value: new Uint8Array([1, 2, 3, 4]) }
                : { done: true, value: undefined };
            }),
            cancel,
            releaseLock: vi.fn(),
          };
        },
      },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(fetchWorldSplatBytes('/api/outputs/imported.spz', { maxBytes: 3 }))
      .rejects.toBeInstanceOf(WorldSplatTooLargeError);
    expect(cancel).toHaveBeenCalledWith('Asset exceeded its byte allowance');
  });

  it('rejects a remote source before issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWorldSplatBytes('http://127.0.0.1:9090/private.spz'))
      .rejects.toThrow('not safe to load');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a forged huge point count before the gzip-size check or Spark allocation', () => {
    const bytes = spzBytes({ numSplats: 0xffff_ffff });

    expect(() => preflightWorldSpz(bytes, '500k')).toThrow(WorldSplatTooLargeError);
    expect(() => preflightWorldSpz(bytes, '500k')).toThrow('safe 500,000-splat limit');
  });

  it.each([
    ['magic', { magic: 0x12345678 }, 'invalid NGSP magic'],
    ['version', { version: 4 }, 'unsupported version'],
    ['SH degree', { shDegree: 4 }, 'unsupported spherical-harmonics degree'],
    ['fractional bits', { fractionalBits: 24 }, 'invalid coordinate precision'],
    ['flags', { flags: 0x04 }, 'unsupported flags'],
    ['reserved byte', { reserved: 1 }, 'reserved byte is not zero'],
  ] as const)('rejects an invalid %s header field', (_field, values, message) => {
    expect(() => preflightWorldSpz(spzBytes(values))).toThrow(WorldSplatFormatError);
    expect(() => preflightWorldSpz(spzBytes(values))).toThrow(message);
  });

  it('rejects a point count that does not match gzip ISIZE', () => {
    const bytes = spzBytes({ numSplats: 11 });

    expect(() => preflightWorldSpz(bytes)).toThrow('gzip size does not match its header');
  });

  it('accepts Spark-supported antialias and LOD flags when the size matches', () => {
    expect(preflightWorldSpz(spzBytes({ flags: 0x81 }), '100k')).toMatchObject({
      flags: 0x81,
      numSplats: 1,
    });
  });

  it('rejects concatenated gzip payload before handing bytes to Spark', async () => {
    const first = spzBytes();
    const second = spzBytes();
    const concatenated = new Uint8Array(first.byteLength + second.byteLength);
    concatenated.set(first);
    concatenated.set(second, first.byteLength);
    // The last member advertises the same ISIZE, so header/trailer-only checks
    // would accept this while Spark could inflate twice the declared payload.
    expect(() => preflightWorldSpz(concatenated)).not.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(concatenated)));

    await expect(fetchWorldSplatBytes('/api/outputs/concatenated.spz'))
      .rejects.toThrow('gzip payload exceeds its declared point data');
  });

  it('rejects a corrupt gzip checksum before handing bytes to Spark', async () => {
    const bytes = spzBytes();
    bytes[bytes.byteLength - 8] ^= 0xff;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));

    await expect(fetchWorldSplatBytes('/api/outputs/corrupt.spz'))
      .rejects.toThrow('gzip integrity check failed');
  });
});
