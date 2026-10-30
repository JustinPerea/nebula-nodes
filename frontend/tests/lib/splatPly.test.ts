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

  it.each([[9, 1], [24, 2], [45, 3]])('reads %i f_rest properties as degree %i', (rest, degree) => {
    const names = [...IDOL.slice(0, 9), ...Array.from({ length: rest }, (_, i) => `f_rest_${i}`), ...IDOL.slice(9)];
    expect(parseSplatPlyHeader(text(header(2, names))).shDegree).toBe(degree);
  });
});

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

  it('turns a PLY over the Gaussian cap into the viewer\'s size error', async () => {
    // A header that declares 2,000,001 Gaussians is refused before its length is checked.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text(header(SPLAT_PLY_MAX_POINTS + 1)))));
    await expect(fetchWorldSplatBytes('/api/outputs/run/idol.ply', { format: 'ply' }))
      .rejects.toBeInstanceOf(WorldSplatTooLargeError);
  });
});
