import type { DirectSizeSnap, DirectStartShape, ModelNodeDefinition } from '../types';

/**
 * The size a maker with a fixed size list makes for a Krea copy's free
 * width x height, on the maker route. The same rule as backend
 * services/maker_sizes.py (nearest, SizeSnap.note); both are tested against
 * backend/tests/fixtures/maker_size_cases.json. The lists come from each
 * node's directRoute.snap, which scripts/sync-krea-catalog.py copies from
 * maker_sizes.SNAPS.
 *
 * Only the maker route snaps: on the Krea or fal copy the size is sent as
 * given, and how the copy sizes it isn't known, so nothing is claimed there.
 */

/** Two shapes this close in log ratio count as the same shape (maker_sizes._SAME). */
const SAME = 1e-9;

function parts(choice: string, sep: string): [number, number] {
  const [a, b] = choice.split(sep);
  return [Number(a), Number(b)];
}

/** The choice closest in shape to width x height, then closest in pixel
 * count; on a full tie, the one listed first (maker_sizes.nearest). */
export function nearestChoice(width: number, height: number, choices: readonly string[], sep: string): string {
  const targetShape = Math.log(width / height);
  const targetArea = Math.log(width * height);
  let best: string | undefined;
  let bestShape = Infinity;
  let bestArea = Infinity;
  for (const choice of choices) {
    const [a, b] = parts(choice, sep);
    const shape = Math.abs(Math.log(a / b) - targetShape);
    const area = Math.abs(Math.log(a * b) - targetArea);
    if (shape < bestShape - SAME || (Math.abs(shape - bestShape) <= SAME && area < bestArea)) {
      best = choice;
      bestShape = shape;
      bestArea = area;
    }
  }
  if (best === undefined) throw new Error('no sizes to choose from');
  return best;
}

export interface SizeSnap {
  maker: string;
  kind: DirectSizeSnap['kind'];
  width: number;
  height: number;
  /** The maker's value, in its own spelling ("1312x736", "16x9", "1360:768"). */
  value: string;
  /** The value's two numbers: pixels for 'size', the ratio's terms for 'shape'. */
  a: number;
  b: number;
  /** The maker can make what was asked (same pixels; for a shape list, the same shape). */
  exact: boolean;
}

export function snapSize(spec: DirectSizeSnap, width: number, height: number): SizeSnap {
  const value = nearestChoice(width, height, spec.choices, spec.sep);
  const [a, b] = parts(value, spec.sep);
  const exact = spec.kind === 'size' ? a === width && b === height : a * height === b * width;
  return { maker: spec.maker, kind: spec.kind, width, height, value, a, b, exact };
}

function effective(definition: ModelNodeDefinition, params: Record<string, unknown>, key: string): unknown {
  const value = params[key];
  if (value !== undefined && value !== null && value !== '') return value;
  for (const group of [definition.sharedParams, definition.directParams, definition.falParams, definition.params]) {
    const param = group?.find((candidate) => candidate.key === key);
    if (param) return param.default;
  }
  return undefined;
}

/** The size a maker-route run of this node gets, or null when the node has
 * no size list or its width/height aren't usable numbers
 * (maker_sizes.definition_snap). The caller checks the route first. */
export function definitionSnap(definition: ModelNodeDefinition, params: Record<string, unknown> | undefined): SizeSnap | null {
  const spec = definition.directRoute?.snap;
  if (!spec) return null;
  const values = params ?? {};
  const width = effective(definition, values, spec.widthParam);
  const height = effective(definition, values, spec.heightParam);
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return snapSize(spec, width, height);
}

/** What the Inspector shows before a maker-route run, or null when the maker
 * can make the size asked for (SizeSnap.note). */
export function sizeNote(snap: SizeSnap | null): string | null {
  if (!snap || snap.exact) return null;
  const asked = `${snap.width}x${snap.height}`;
  if (snap.kind === 'size') return `${snap.maker} makes ${snap.a}x${snap.b}, the closest it can get to your ${asked}.`;
  return `${snap.maker} makes a ${snap.a}:${snap.b} image at a size it picks, the closest shape it has to your ${asked}.`;
}

/** What the Inspector shows before a maker-route run with a start image when
 * the maker doesn't use the aspect ratio then (maker_sizes.start_shape_note). */
export function startShapeNote(spec: DirectStartShape, aspect: unknown): string {
  return `${spec.maker} makes this video in your start image's shape: ${spec.model} doesn't use the ${String(aspect)} aspect ratio when it starts from an image.`;
}

/** The start-shape note for a maker-route run of this node, or null when the
 * maker uses the aspect ratio as given (maker_sizes.definition_start_shape_note).
 * `wired` lists the node's wired input ports. The caller checks the route first. */
export function definitionStartShapeNote(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  wired: readonly string[] = [],
): string | null {
  const spec = definition.directRoute?.startShape;
  if (!spec) return null;
  const values = params ?? {};
  const image = values[spec.imageParam];
  const empty = image === undefined || image === null || image === '' || (Array.isArray(image) && image.length === 0);
  if (!wired.includes(spec.imageParam) && empty) return null;
  return startShapeNote(spec, effective(definition, values, spec.ratioParam));
}
