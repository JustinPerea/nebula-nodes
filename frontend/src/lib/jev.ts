/**
 * The output contract of the TypeSafe Jev nodes (Decide, Pick Best, Box), for
 * the canvas and anything else that reads their results.
 *
 * Every value arrives as a string on a Text port (or a media reference on an
 * Image/Mask port). The formats are fixed by backend/services/jev_outputs.py
 * and described in docs/api-guides/typesafe.md; both sides test against
 * backend/tests/fixtures/jev_outputs.json.
 *
 * The parsers never throw. A malformed or missing required value gives null,
 * so a caller can fall back to showing the raw outputs.
 */

export const JEV_DECIDE = 'jev-decide';
export const JEV_PICK_BEST = 'jev-pick-best';
export const JEV_BOX = 'jev-box';
export const JEV_NODE_IDS = [JEV_DECIDE, JEV_PICK_BEST, JEV_BOX] as const;
export type JevNodeId = (typeof JEV_NODE_IDS)[number];

/** pass (Decide) and found (Box). "unsure" means below the node's minimum confidence. */
export type JevVerdict = 'true' | 'false' | 'unsure';

export interface JevReport {
  /** Line 1, e.g. "Jev Decide (yes/no)". */
  title: string;
  /** Every "Key: value" line, e.g. { Model: 'jev-1.14.0', 'Input tokens': '312' }. */
  fields: Record<string, string>;
  /** "Note: ..." lines, in order, without the prefix. */
  notes: string[];
  /** The versioned model id that answered (the alias asked for is in fields.Model). */
  model: string | null;
  inputTokens: number | null;
}

export interface JevDecideResult {
  kind: 'decide';
  /** "yes" / "no", the chosen option, or the most likely score level, in the user's words. */
  answer: string;
  pass: JevVerdict;
  /** Yes-probability (yes/no), winner probability (choice) or the score normalized to 0..1. */
  probability: number;
  confidence: number;
  /** Label -> probability. */
  probabilities: Record<string, number>;
  report: JevReport | null;
}

export interface JevPickBestResult {
  kind: 'pick-best';
  /** The winning candidate's value, unchanged (a media reference). */
  winner: string;
  /** 0-based position among the candidates. */
  index: number;
  /** "0", "1", ... -> probability. */
  probabilities: Record<string, number>;
  confidence: number;
  report: JevReport | null;
}

export interface JevBox {
  /** Fractions 0..1 of the original image (EXIF-rotated, as a browser shows it). */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** null when TypeSafe reports none; never read as 0. */
  confidence: number | null;
  /** Pixel rectangle in the original image. */
  px: { x: number; y: number; w: number; h: number };
  image: { w: number; h: number };
}

export interface JevBoxResult {
  kind: 'box';
  found: JevVerdict;
  /** Only when found is "true"; null when the target is missing or Jev is unsure. */
  box: JevBox | null;
  /** Only when found is "true". */
  crop: string | null;
  mask: string | null;
  annotated: string | null;
  report: JevReport | null;
}

export type JevResult = JevDecideResult | JevPickBestResult | JevBoxResult;

export function isJevNode(definitionId: unknown): definitionId is JevNodeId {
  return typeof definitionId === 'string' && (JEV_NODE_IDS as readonly string[]).includes(definitionId);
}

const NUMBER_RE = /^\d+(?:\.\d+)?$/;

/** Value of one output port, whether given as a PortValue or a bare string. */
function portValue(outputs: Record<string, unknown>, port: string): unknown {
  const entry = outputs[port];
  if (entry && typeof entry === 'object' && 'value' in entry) return (entry as { value: unknown }).value;
  return entry;
}

function text(outputs: Record<string, unknown>, port: string): string | null {
  const value = portValue(outputs, port);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A contract number: "0.93", "1", "0". */
export function parseJevNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !NUMBER_RE.test(value)) return null;
  const number = Number(value);
  return number >= 0 && number <= 1 ? number : null;
}

function parseVerdict(value: unknown): JevVerdict | null {
  return value === 'true' || value === 'false' || value === 'unsure' ? value : null;
}

function parseProbabilities(value: unknown): Record<string, number> | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.length) return null;
  const result: Record<string, number> = {};
  for (const [key, number] of entries) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) return null;
    result[key] = number;
  }
  return result;
}

const isFraction = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

/** The Box `box` output: a box, null for "not found", or undefined when malformed. */
export function parseJevBox(value: unknown): JevBox | null | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;
  const { top, bottom, left, right, confidence } = raw;
  if (!isFraction(top) || !isFraction(bottom) || !isFraction(left) || !isFraction(right)) return undefined;
  if (top > bottom || left > right) return undefined;
  if (confidence !== null && !isFraction(confidence)) return undefined;
  const px = raw.px as Record<string, unknown> | null;
  const image = raw.image as Record<string, unknown> | null;
  if (!px || typeof px !== 'object' || !image || typeof image !== 'object') return undefined;
  if (!isCount(px.x, 0) || !isCount(px.y, 0) || !isCount(px.w, 0) || !isCount(px.h, 0)) return undefined;
  if (!isCount(image.w, 1) || !isCount(image.h, 1)) return undefined;
  if (px.x + px.w > image.w || px.y + px.h > image.h) return undefined;
  return {
    top, bottom, left, right, confidence,
    px: { x: px.x, y: px.y, w: px.w, h: px.h },
    image: { w: image.w, h: image.h },
  };
}

/** The `report` output: title line, "Key: value" lines, "Note: ..." lines. */
export function parseJevReport(value: unknown): JevReport | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const [title, ...lines] = value.split('\n');
  const fields: Record<string, string> = {};
  const notes: string[] = [];
  for (const line of lines) {
    const at = line.indexOf(': ');
    if (at <= 0) return null;
    const key = line.slice(0, at);
    const rest = line.slice(at + 2);
    if (key === 'Note') notes.push(rest);
    else fields[key] = rest;
  }
  if (!('Model' in fields) || !('Input tokens' in fields)) return null;
  const model = fields.Model.split(' ')[0] || null;
  const tokens = /^\d+$/.test(fields['Input tokens']) ? Number(fields['Input tokens']) : null;
  return { title, fields, notes, model, inputTokens: tokens };
}

function parseDecide(outputs: Record<string, unknown>): JevDecideResult | null {
  const answer = text(outputs, 'answer');
  const pass = parseVerdict(portValue(outputs, 'pass'));
  const probability = parseJevNumber(portValue(outputs, 'probability'));
  const confidence = parseJevNumber(portValue(outputs, 'confidence'));
  const probabilities = parseProbabilities(portValue(outputs, 'probabilities'));
  if (answer === null || pass === null || probability === null || confidence === null || !probabilities) return null;
  return {
    kind: 'decide', answer, pass, probability, confidence, probabilities,
    report: parseJevReport(portValue(outputs, 'report')),
  };
}

function parsePickBest(outputs: Record<string, unknown>): JevPickBestResult | null {
  const winner = text(outputs, 'winner');
  const rawIndex = portValue(outputs, 'index');
  const index = typeof rawIndex === 'string' && /^(?:0|[1-9]\d*)$/.test(rawIndex) ? Number(rawIndex) : null;
  const confidence = parseJevNumber(portValue(outputs, 'confidence'));
  const probabilities = parseProbabilities(portValue(outputs, 'probabilities'));
  if (winner === null || index === null || confidence === null || !probabilities) return null;
  const keys = Object.keys(probabilities);
  if (keys.some((key, position) => key !== String(position)) || index >= keys.length) return null;
  return {
    kind: 'pick-best', winner, index, probabilities, confidence,
    report: parseJevReport(portValue(outputs, 'report')),
  };
}

function parseBoxResult(outputs: Record<string, unknown>): JevBoxResult | null {
  const found = parseVerdict(portValue(outputs, 'found'));
  if (found === null) return null;
  const box = parseJevBox(portValue(outputs, 'box'));
  if (box === undefined) return null;
  // A box only comes with a confident "found"; anything else is malformed.
  if ((found === 'true') !== (box !== null)) return null;
  const confirmed = found === 'true';
  return {
    kind: 'box', found, box,
    crop: confirmed ? text(outputs, 'crop') : null,
    mask: confirmed ? text(outputs, 'mask') : null,
    annotated: confirmed ? text(outputs, 'annotated') : null,
    report: parseJevReport(portValue(outputs, 'report')),
  };
}

/**
 * A Jev node's outputs as a typed result, or null when the node isn't a Jev
 * node or a required value is missing or malformed. Accepts the node's
 * `outputs` record (port id -> PortValue) or port id -> bare string.
 */
export function parseJevOutputs(definitionId: unknown, outputs: unknown): JevResult | null {
  if (!isJevNode(definitionId) || !outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
  const record = outputs as Record<string, unknown>;
  try {
    if (definitionId === JEV_DECIDE) return parseDecide(record);
    if (definitionId === JEV_PICK_BEST) return parsePickBest(record);
    return parseBoxResult(record);
  } catch {
    return null;
  }
}
