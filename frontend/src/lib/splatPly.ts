/**
 * A bounded preflight for 3D Gaussian Splatting PLY files (the "3DGS" layout
 * Idol and most splat tools write) before any byte reaches Spark. The same
 * rules as backend/services/splat_ply.py `parse_splat_ply_header` /
 * `validate_splat_ply`, with the World preview's caps (lib/worldSplat.ts):
 * at most 2,000,000 Gaussians and 128 MiB.
 *
 * Layout: `ply`, `format binary_little_endian 1.0`, one `element vertex N`,
 * float properties x y z, optional nx ny nz, f_dc_0..2, optional f_rest_*
 * (0, 9, 24 or 45 of them), opacity, scale_0..2, rot_0..3, `end_header`,
 * then exactly N records of 4 bytes per property.
 */

export const SPLAT_PLY_MAX_POINTS = 2_000_000;
export const SPLAT_PLY_MAX_BYTES = 128 * 1024 * 1024;
export const SPLAT_PLY_MAX_HEADER_BYTES = 64 * 1024;

export const SPLAT_PLY_REQUIRED_PROPERTIES: readonly string[] = [
  'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
];
const OPTIONAL_PROPERTY = /^(?:nx|ny|nz|f_rest_[0-9]{1,2})$/;
const FLOAT_TYPES = new Set(['float', 'float32']);
const SH_REST_BY_DEGREE: readonly [number, number][] = [[0, 0], [1, 9], [2, 24], [3, 45]];
const END_HEADER = 'end_header\n';

export class SplatPlyFormatError extends Error {}
export class SplatPlyTooLargeError extends Error {}

export interface SplatPlyHeader {
  vertexCount: number;
  properties: readonly string[];
  headerBytes: number;
  stride: number;
  shDegree: number;
  expectedBytes: number;
}

function invalid(message: string): never {
  throw new SplatPlyFormatError(`The splat preview is not a supported 3DGS PLY file (${message}).`);
}

/** The header of a 3DGS PLY, checked against the layout above and the point
 * cap. `totalBytes` (the whole file's length, when known) must match it. */
export function parseSplatPlyHeader(
  bytes: Uint8Array,
  options: { maxPoints?: number; totalBytes?: number } = {},
): SplatPlyHeader {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, SPLAT_PLY_MAX_HEADER_BYTES));
  let text = '';
  for (let index = 0; index < window.byteLength; index += 1) {
    const code = window[index];
    if (code > 0x7f) break;
    text += String.fromCharCode(code);
    if (code === 0x0a && text.endsWith(`\n${END_HEADER}`)) break;
  }
  if (!text.startsWith('ply\n')) invalid('missing ply signature');
  if (!text.endsWith(`\n${END_HEADER}`)) invalid('no end_header in the first 64 KiB');
  const headerBytes = text.length;
  const lines = text.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  let vertexCount: number | null = null;
  let sawFormat = false;
  const properties: string[] = [];
  for (const line of lines.slice(0, -1)) {
    const parts = line.split(/\s+/);
    const [kind] = parts;
    if (kind === 'comment' || kind === 'obj_info') continue;
    if (kind === 'format') {
      if (parts[1] !== 'binary_little_endian' || parts[2] !== '1.0' || parts.length !== 3) {
        invalid('only binary little-endian is supported');
      }
      sawFormat = true;
    } else if (kind === 'element') {
      if (parts.length !== 3 || parts[1] !== 'vertex' || vertexCount !== null) invalid('one vertex element only');
      if (!/^[0-9]{1,10}$/.test(parts[2])) invalid('vertex count is not a whole number');
      vertexCount = Number(parts[2]);
    } else if (kind === 'property') {
      if (vertexCount === null) invalid('property before the vertex element');
      if (parts.length !== 3 || !FLOAT_TYPES.has(parts[1])) invalid('every property must be a float');
      const name = parts[2];
      if (properties.includes(name)) invalid(`duplicate property ${name}`);
      if (!SPLAT_PLY_REQUIRED_PROPERTIES.includes(name) && !OPTIONAL_PROPERTY.test(name)) {
        invalid(`unexpected property ${name}`);
      }
      properties.push(name);
    } else {
      invalid(`unexpected header line ${kind}`);
    }
  }
  if (!sawFormat) invalid('no format line');
  if (vertexCount === null || vertexCount <= 0) invalid('no Gaussians');
  const missing = SPLAT_PLY_REQUIRED_PROPERTIES.filter((name) => !properties.includes(name));
  if (missing.length) invalid(`missing ${missing.join(', ')}`);
  const rest = properties.filter((name) => name.startsWith('f_rest_')).length;
  const degree = SH_REST_BY_DEGREE.find(([, count]) => count === rest)?.[0];
  if (degree === undefined) invalid(`${rest} f_rest properties match no spherical-harmonics degree`);

  const maxPoints = Math.min(options.maxPoints ?? SPLAT_PLY_MAX_POINTS, SPLAT_PLY_MAX_POINTS);
  if (vertexCount > maxPoints) {
    throw new SplatPlyTooLargeError(
      `This splat declares ${vertexCount.toLocaleString()} Gaussians, above the safe `
      + `${maxPoints.toLocaleString()}-Gaussian limit.`,
    );
  }
  const stride = 4 * properties.length;
  const expectedBytes = headerBytes + vertexCount * stride;
  if (options.totalBytes !== undefined && options.totalBytes !== expectedBytes) {
    invalid('file length does not match its header');
  }
  return { vertexCount, properties, headerBytes, stride, shDegree: degree, expectedBytes };
}

/** The whole-file check the World preview runs before Spark sees the bytes. */
export function preflightSplatPly(fileBytes: Uint8Array, options: { maxPoints?: number } = {}): SplatPlyHeader {
  if (fileBytes.byteLength > SPLAT_PLY_MAX_BYTES) {
    throw new SplatPlyTooLargeError('This splat is too large to open safely in the browser. Download it for a desktop 3D viewer instead.');
  }
  return parseSplatPlyHeader(fileBytes, { ...options, totalBytes: fileBytes.byteLength });
}
