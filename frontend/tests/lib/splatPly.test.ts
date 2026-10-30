import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSplatPlyHeader,
  preflightSplatPly,
  SPLAT_PLY_MAX_BYTES,
  SPLAT_PLY_MAX_POINTS,
  SplatPlyFormatError,
  SplatPlyTooLargeError,
} from '../../src/lib/splatPly';
import { fetchWorldSplatBytes, WorldSplatFormatError, WorldSplatTooLargeError } from '../../src/lib/worldSplat';

/** Idol's save_ply layout: SH0, 17 float32 properties (68 bytes a Gaussian). */
const IDOL = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

function header(count: number, properties: readonly string[] = IDOL, format = 'binary_little_endian 1.0', extra = ''): string {
  return `ply\nformat ${format}\n${extra}element vertex ${count}\n${properties.map((name) => `property float ${name}\n`).join('')}end_header\n`;
}

function ply(count: number, properties: readonly string[] = IDOL, trailing = 0): Uint8Array {
  const head = new TextEncoder().encode(header(count, properties));
  const bytes = new Uint8Array(head.byteLength + count * properties.length * 4 + trailing);
  bytes.set(head);
  return bytes;
}

const text = (value: string) => new TextEncoder().encode(value);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('3DGS PLY preflight (the twin of backend services/splat_ply.py)', () => {
  it('reads Idol\'s layout', () => {
    const parsed = preflightSplatPly(ply(64));
    expect(parsed).toMatchObject({ vertexCount: 64, stride: 68, shDegree: 0 });
    expect(parsed.expectedBytes).toBe(ply(64).byteLength);
  });

  it('holds the 2,000,000-Gaussian cap at its edge', () => {
    expect(SPLAT_PLY_MAX_POINTS).toBe(2_000_000);
    expect(parseSplatPlyHeader(text(header(SPLAT_PLY_MAX_POINTS))).vertexCount).toBe(SPLAT_PLY_MAX_POINTS);
    expect(() => parseSplatPlyHeader(text(header(SPLAT_PLY_MAX_POINTS + 1)))).toThrow(SplatPlyTooLargeError);
    expect(() => parseSplatPlyHeader(text(header(11)), { maxPoints: 10 })).toThrow(SplatPlyTooLargeError);
    expect(parseSplatPlyHeader(text(header(10)), { maxPoints: 10 }).vertexCount).toBe(10);
    // A caller can lower the cap, never raise it.
    expect(() => parseSplatPlyHeader(text(header(SPLAT_PLY_MAX_POINTS + 1)), { maxPoints: 5_000_000 }))
      .toThrow(SplatPlyTooLargeError);
  });

  it('holds the 128 MiB cap before reading the header', () => {
    expect(SPLAT_PLY_MAX_BYTES).toBe(128 * 1024 * 1024);
    const huge = { byteLength: SPLAT_PLY_MAX_BYTES + 1 } as Uint8Array;
    expect(() => preflightSplatPly(huge)).toThrow(SplatPlyTooLargeError);
  });

  it('wants exactly the header plus one record per Gaussian', () => {
    expect(() => preflightSplatPly(ply(8).subarray(0, ply(8).byteLength - 1))).toThrow(/does not match/);
    expect(() => preflightSplatPly(ply(8, IDOL, 1))).toThrow(/does not match/);
  });

  it.each([
    ['ascii', header(4, IDOL, 'ascii 1.0'), /binary little-endian/],
    ['big endian', header(4, IDOL, 'binary_big_endian 1.0'), /binary little-endian/],
    ['no signature', `PLY\n${header(4).slice(4)}`, /ply signature/],
    ['no end', 'ply\nformat binary_little_endian 1.0\nelement vertex 4\n', /end_header/],
    ['no Gaussians', header(0), /no Gaussians/],
    ['missing opacity', header(4, IDOL.filter((name) => name !== 'opacity')), /missing opacity/],
    ['duplicate', header(4, [...IDOL, 'x']), /duplicate/],
    ['unknown property', header(4, [...IDOL, 'red']), /unexpected property red/],
    ['odd SH', header(4, [...IDOL, 'f_rest_0']), /spherical-harmonics/],
    ['a face element', header(4, IDOL, 'binary_little_endian 1.0', 'element face 2\n'), /one vertex element/],
    ['a double', 'ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty double x\nend_header\n', /float/],
  ])('refuses %s', (_name, value, message) => {
    expect(() => parseSplatPlyHeader(text(value))).toThrow(SplatPlyFormatError);
    expect(() => parseSplatPlyHeader(text(value))).toThrow(message);
  });

  it.each([
    ['a gap', [...Array.from({ length: 8 }, (_, i) => `f_rest_${i}`), 'f_rest_20']],
    ['a leading zero', [...Array.from({ length: 8 }, (_, i) => `f_rest_${i}`), 'f_rest_08']],
    ['an index past the count', [...Array.from({ length: 8 }, (_, i) => `f_rest_${i + 1}`), 'f_rest_9']],
  ])('refuses f_rest properties with %s, as Spark reads them by name', (_, rest) => {
    const names = [...IDOL.slice(0, 9), ...rest, ...IDOL.slice(9)];
    expect(() => parseSplatPlyHeader(text(header(2, names))))
      .toThrow(/f_rest properties aren't f_rest_0 to f_rest_8/);
  });

  it('takes f_rest_0 to f_rest_8 in any order', () => {
    const rest = Array.from({ length: 9 }, (_, i) => `f_rest_${8 - i}`);
    expect(parseSplatPlyHeader(text(header(2, [...IDOL.slice(0, 9), ...rest, ...IDOL.slice(9)]))).shDegree).toBe(1);
  });

  it.each([[9, 1], [24, 2], [45, 3]])('reads %i f_rest properties as degree %i', (rest, degree) => {
    const names = [...IDOL.slice(0, 9), ...Array.from({ length: rest }, (_, i) => `f_rest_${i}`), ...IDOL.slice(9)];
    expect(parseSplatPlyHeader(text(header(2, names))).shDegree).toBe(degree);
  });
});

/** A streamed body of `chunks` (64 KiB each after the first), counting reads and cancels. */
function streamed(first: Uint8Array, chunkCount: number, headers: HeadersInit = {}) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  let reads = 0;
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: first };
          if (reads <= chunkCount) return { done: false, value: new Uint8Array(64 * 1024) };
          return { done: true, value: undefined };
        }),
        cancel,
        releaseLock: vi.fn(),
      }),
    },
  } as unknown as Response;
  return { response, cancel, reads: () => reads };
}

describe('World splat loading of a PLY', () => {
  it('loads a local PLY that passes the preflight', async () => {
    const bytes = ply(16);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply', maxBytes: bytes.byteLength }))
      .resolves.toEqual(bytes);
  });

  it('turns a damaged PLY into the viewer\'s format error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text('ply\nnope\n'))));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' }))
      .rejects.toBeInstanceOf(WorldSplatFormatError);
  });

  it('stops a PLY with a bad header after its first 64 KiB, not after the whole file', async () => {
    const first = new Uint8Array(64 * 1024);
    first.set(text('ply\nformat ascii 1.0\nelement vertex 9\n'));
    const body = streamed(first, 1_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' }))
      .rejects.toBeInstanceOf(WorldSplatFormatError);
    expect(body.reads()).toBe(1);
    expect(body.cancel).toHaveBeenCalledWith('Asset failed its header check');
  });

  it('stops a PLY whose header declares more bytes than the allowance before reading them', async () => {
    // 1,000,000 Gaussians of 68 bytes: 68 MB, above a 1 MiB allowance.
    const first = new Uint8Array(64 * 1024);
    first.set(text(header(1_000_000)));
    const body = streamed(first, 1_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply', maxBytes: 1024 * 1024 }))
      .rejects.toBeInstanceOf(WorldSplatTooLargeError);
    expect(body.reads()).toBe(1);
  });

  it('stops a PLY whose Content-Length disagrees with its header', async () => {
    const first = new Uint8Array(64 * 1024);
    first.set(text(header(4)));
    const body = streamed(first, 3, { 'content-length': String(4 * 64 * 1024) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(body.response));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' }))
      .rejects.toBeInstanceOf(WorldSplatFormatError);
    expect(body.reads()).toBe(1);
  });

  it('checks the header of a PLY that arrives in small pieces once 64 KiB are in', async () => {
    const bytes = ply(2_000);
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 1000) pieces.push(bytes.subarray(offset, offset + 1000));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }))));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' })).resolves.toEqual(bytes);
  });

  it('turns a PLY over the Gaussian cap into the viewer\'s size error', async () => {
    // A header that declares 2,000,001 Gaussians is refused before its length is checked.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text(header(SPLAT_PLY_MAX_POINTS + 1)))));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' }))
      .rejects.toBeInstanceOf(WorldSplatTooLargeError);
  });
});
