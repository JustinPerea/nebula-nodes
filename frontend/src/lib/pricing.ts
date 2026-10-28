import type { ModelNodeDefinition } from '../types';
import { allParamDefinitions, hasRoutes, routeBlock, routeById, routesOf, withWiredBlockers } from './directRoute';
import {
  CEILING_USD, OVER_CEILING_SPENT_USD, OVER_CEILING_USD, OVER_TITLE, PRICED_PART, UNPRICED_SUFFIX,
} from './unpricedCopy';

/** One curated price entry from backend/data/model_pricing.json. The format
 * and its rules live in backend/services/model_pricing.py; this file mirrors
 * that estimate, and both are tested against the same shared cases. */
export type PriceValue = number | [number, number];

export interface PriceRow {
  match?: Record<string, unknown>;
  price: PriceValue;
  /** Only this row's price isn't stated exactly (model_pricing.route_price_unconfirmed). */
  unconfirmed?: boolean;
}

export interface PriceEntry {
  currency: string;
  per: 'image' | 'video' | 'second' | 'request' | 'megapixel-second' | 'megapixel' | 'megapixel-frame';
  rows: PriceRow[];
  /** A node that can run on more than one provider prices each route on its
   * own: provider -> a single-route entry (model_pricing.py). The run prices
   * the route it bills (lib/directRoute.ts selectRoute). */
  routes?: Record<string, PriceEntry>;
  generatedBy?: string;
  extras?: PriceRow[];
  multiplyBy?: string[];
  defaults?: Record<string, unknown>;
  /** Params the handler strips: a value of only whitespace sends nothing, so
   * it prices as unset (model_pricing.py `whitespaceUnset`). */
  whitespaceUnset?: string[];
  provider?: string;
  plus?: string;
  /** The provider's page doesn't state this price exactly (a higher page
   * price kept until the exact one is published); the switcher marks it "*". */
  unconfirmed?: boolean;
  notes?: string;
  sources?: Array<{ url: string; quote: string }>;
  checked?: string;
  /** Quantities measured from the input on `port` (model_pricing.py sizing). */
  sizing?: { port: string; output?: 'upscale'; megapixel?: number; roundUp?: string[]; say: string };
}

/** A run's measured input file (services/input_sizes.py). */
export interface InputSize { width?: number; height?: number; seconds?: number; frames?: number }

export interface PricingTable {
  currencies: Record<string, unknown>;
  nodes: Record<string, PriceEntry>;
}

export interface NodeEstimate {
  currency: string;
  low: number;
  high: number;
  /** A real cost on top that the vendor doesn't publish, e.g. "input images". */
  plus?: string;
}

function bounds(price: unknown): [number, number] | null {
  if (typeof price === 'number') return Number.isFinite(price) && price >= 0 ? [price, price] : null;
  if (Array.isArray(price) && price.length === 2 && price.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const [low, high] = price as [number, number];
    return low >= 0 && low <= high ? [low, high] : null;
  }
  return null;
}

function asMatchValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function definitionParams(definition: Partial<ModelNodeDefinition>): Array<{ key?: string; default?: unknown }> {
  return allParamDefinitions(definition as ModelNodeDefinition);
}

/** Node params over the definition's defaults over the entry's handler defaults. */
export function effectiveParams(
  entry: PriceEntry,
  definition: Partial<ModelNodeDefinition>,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(entry.defaults ?? {}) };
  for (const param of definitionParams(definition)) {
    if (param.key !== undefined && param.default !== undefined && param.default !== null && !(param.key in merged)) {
      merged[param.key] = param.default;
    }
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

function matches(values: Record<string, unknown>, match: Record<string, unknown> | undefined): boolean {
  return Object.entries(match ?? {}).every(([key, want]) => asMatchValue(values[key]) === asMatchValue(want));
}

/** A FLUX 3 Video run's mode, a price variable read from the wired ports, not
 * a saved param: v2v with start_video wired, i2v with start_image, keyframes
 * or end_image, else t2v (model_pricing.VIDEO_MODE, the rule the backend's
 * route clients pick BFL's `mode` by). */
export const VIDEO_MODE = '(mode)';
const IMAGE_PORTS = ['start_image', 'keyframes', 'end_image'];
/** Whether a run has reference images wired, a price variable read from the
 * wired ports: `some` with an edge into `images`, else `none`
 * (model_pricing.REFERENCES). Krea 3 prices a run without references at the
 * exact base price. */
export const REFERENCES = '(references)';
const REFERENCE_PORTS = ['images'];
/** `(wired PORT)`: `yes` when that input port has an edge in, else `no`
 * (model_pricing.WIRED_PREFIX). Krea 2 prices by billing tier, and a tier's
 * input can arrive by wire or be typed in the param of the same id. */
export const WIRED_PREFIX = '(wired ';

export function wiredKey(port: string): string {
  return `${WIRED_PREFIX}${port})`;
}

/** The port a `(wired PORT)` price variable reads, else null. */
export function wiredPort(key: string): string | null {
  return key.startsWith(WIRED_PREFIX) && key.endsWith(')') ? key.slice(WIRED_PREFIX.length, -1) : null;
}

/** Params the entry reads only alongside `(wired X)` for the port of the
 * same id (every row and extra matching X also matches `(wired X)`, and X
 * isn't a multiplier), so a wire into X is priced, not unknown
 * (model_pricing.wire_aware_keys). */
export function wireAwareKeys(entry: PriceEntry): Set<string> {
  const matched = [...(entry.rows ?? []), ...(entry.extras ?? [])].map((row) => row.match ?? {});
  const factors = new Set(entry.multiplyBy ?? []);
  const result = new Set<string>();
  for (const match of matched) {
    for (const key of Object.keys(match)) {
      const port = wiredPort(key);
      if (port === null || factors.has(port)) continue;
      if (matched.every((other) => !Object.hasOwn(other, port) || Object.hasOwn(other, wiredKey(port)))) {
        result.add(port);
      }
    }
  }
  return result;
}
/** Quantities measured from a run's input file (model_pricing.SIZED_VARIABLES),
 * and every run-time variable: `(output tier)` is never measured, so an entry
 * reading it stays unpriced (model_pricing.RUN_TIME_VARIABLES). */
export const SIZED_VARIABLES: readonly string[] = ['(input megapixels)', '(output megapixels)', '(larger megapixels)',
  '(source seconds)', '(source frames)'];
export const RUN_TIME_VARIABLES: readonly string[] = [...SIZED_VARIABLES, '(output tier)'];

/** Whether this single-route entry is priced from its input's size
 * (model_pricing.awaits_input). */
export function awaitsInput(entry: PriceEntry | undefined): boolean {
  if (!entry?.sizing) return false;
  const keys = [...pricedKeys(entry)];
  return keys.some((key) => SIZED_VARIABLES.includes(key)) && !keys.includes('(output tier)');
}

/** The input ports an entry (or any route of it) measures (model_pricing.sizing_ports). */
export function sizingPorts(entry: PriceEntry | undefined): string[] {
  return Object.values(entry?.routes ?? (entry ? { entry } : {})).flatMap((item) => (item.sizing ? [item.sizing.port] : []));
}

/** describe_node's line for an entry priced by its input (model_pricing.size_note). */
export function sizeNote(entry: PriceEntry | undefined, definition: Partial<ModelNodeDefinition>): string | null {
  if (!awaitsInput(entry)) return null;
  const port = definition.inputPorts?.find((candidate) => candidate.id === entry!.sizing!.port);
  return `${entry!.sizing!.say.trim()}; priced from your ${port?.dataType === 'Video' ? 'video' : 'image'}'s size when you run it`;
}

/** The SIZED_VARIABLES an entry reads, from its input's size, or null when
 * one can't be measured (model_pricing.sized_quantities). */
function sizedQuantities(entry: PriceEntry, values: Record<string, unknown>, size: InputSize | null | undefined): Record<string, number> | null {
  const sizing = entry.sizing;
  if (!sizing || !size) return null;
  const megapixel = sizing.megapixel ?? 1_000_000;
  const positive = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
  const out: Record<string, number> = {};
  const wanted = [...pricedKeys(entry)].filter((key) => SIZED_VARIABLES.includes(key));
  if (wanted.some((key) => key.endsWith('megapixels)'))) {
    const width = positive(size.width);
    const height = positive(size.height);
    if (width === null || height === null) return null;
    let pixels: number | null = width * height;
    if (sizing.output === 'upscale') {
      const mode = asMatchValue(values.upscale_mode || 'factor');
      const target = String(values.target_resolution ?? '').trim().toLowerCase();
      const side = target.endsWith('p') ? multiplier(target.slice(0, -1)) : null;
      const factor = multiplier(values.upscale_factor);
      const ratio = Math.max(width, height) / Math.min(width, height);
      // Which side a target sets isn't said: price both and take the larger.
      pixels = mode === 'factor' ? (factor === null ? null : pixels * factor * factor)
        : mode === 'target' && side !== null ? side * side * Math.max(ratio, 1 / ratio) : null;
    }
    if (pixels === null || !Number.isFinite(pixels) || pixels <= 0) return null;
    out['(input megapixels)'] = (width * height) / megapixel;
    out['(output megapixels)'] = pixels / megapixel;
    out['(larger megapixels)'] = Math.max(out['(input megapixels)'], out['(output megapixels)']);
  }
  for (const [key, field] of [['(source seconds)', 'seconds'], ['(source frames)', 'frames']] as const) {
    if (!wanted.includes(key)) continue;
    const amount = positive(size[field]);
    if (amount === null) return null;
    out[key] = amount;
  }
  for (const key of sizing.roundUp ?? []) if (key in out) out[key] = Math.ceil(out[key] - 1e-9);
  return Object.fromEntries(wanted.map((key) => [key, out[key]]));
}

/** A video run's mode from its wired ports (VIDEO_MODE); a source video wins. */
export function videoMode(wired: Iterable<string>): 't2v' | 'i2v' | 'v2v' {
  const ports = new Set(wired);
  if (ports.has('start_video')) return 'v2v';
  return IMAGE_PORTS.some((port) => ports.has(port)) ? 'i2v' : 't2v';
}

/** Whether a run has reference images wired (REFERENCES). */
export function references(wired: Iterable<string>): 'none' | 'some' {
  const ports = new Set(wired);
  return REFERENCE_PORTS.some((port) => ports.has(port)) ? 'some' : 'none';
}

/** Every setting an entry's price reads: row and extra matches, multiplyBy. */
export function pricedKeys(entry: PriceEntry): Set<string> {
  const keys = new Set<string>(entry.multiplyBy ?? []);
  for (const row of [...(entry.rows ?? []), ...(entry.extras ?? [])]) {
    for (const key of Object.keys(row.match ?? {})) keys.add(key);
  }
  return keys;
}

// A plain decimal, as both this file and backend/services/model_pricing.py
// read it, so "0x10", "1_000" or non-ASCII digits never price on one side only.
const DECIMAL = /^[ \t\n\r]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r]*$/;

/** A positive, finite count or duration; null for anything else. */
function multiplier(value: unknown): number | null {
  if (typeof value === 'string' && !DECIMAL.test(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** The single-route entry that prices a run billed to `provider`: a `routes`
 * entry gives that route's (undefined when the route has no price or isn't
 * known); a plain entry comes back as is (model_pricing.entry_for_route). */
export function entryForRoute(entry: PriceEntry | undefined, provider: string | null | undefined): PriceEntry | undefined {
  if (!entry) return undefined;
  if (entry.routes === undefined) return entry;
  if (!provider || typeof entry.routes !== 'object' || entry.routes === null) return undefined;
  const routed = Object.hasOwn(entry.routes, provider) ? entry.routes[provider] : undefined;
  return routed && typeof routed === 'object' ? routed : undefined;
}

/** Whitespace as Python's str.strip() sees it, since the handlers strip with
 * it (JS trim() also strips U+FEFF and keeps U+001C-001F and U+0085). Code
 * points rather than a regex, which can't hold the control characters lint-clean. */
const PYTHON_WHITESPACE = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isPythonBlank(value: string): boolean {
  for (const char of value) {
    if (!PYTHON_WHITESPACE.has(char.codePointAt(0) ?? -1)) return false;
  }
  return true;
}


/** The values an entry's rows are matched against: the effective params
 * plus the price variables read from the wired ports (model_pricing._price_values). */
function priceValues(
  entry: PriceEntry,
  definition: Partial<ModelNodeDefinition>,
  params: Record<string, unknown> | undefined,
  ports: string[],
): Record<string, unknown> {
  const priced = pricedKeys(entry);
  // A param the handler strips sends nothing when it's only whitespace.
  const cleaned: Record<string, unknown> = { ...(params ?? {}) };
  for (const key of entry.whitespaceUnset ?? []) {
    const value = cleaned[key];
    if (typeof value === 'string' && isPythonBlank(value)) cleaned[key] = '';
  }
  const values = effectiveParams(entry, definition, cleaned);
  if (priced.has(VIDEO_MODE)) values[VIDEO_MODE] = videoMode(ports);
  if (priced.has(REFERENCES)) values[REFERENCES] = references(ports);
  const wiredSet = new Set(ports);
  for (const key of priced) {
    const port = wiredPort(key);
    if (port !== null) values[key] = wiredSet.has(port) ? 'yes' : 'no';
  }
  return values;
}

/** One run of this node, or null when it's unpriced (no entry, no matching
 * row, the run bills a different provider than the entry prices, a setting
 * the price reads arrives by wire, so it's only known at run time, or the
 * price reads a RUN_TIME_VARIABLES quantity and `size`, the measured input of
 * its sizing port, doesn't give it). The wired ports also give the
 * VIDEO_MODE and REFERENCES a row may match. A `routes` entry prices the route
 * `routeProvider` names. */
export function estimateNode(
  priceEntry: PriceEntry | undefined,
  definition: Partial<ModelNodeDefinition>,
  params: Record<string, unknown> | undefined,
  routeProvider?: string | null,
  wired: Iterable<string> = [],
  size?: InputSize | null,
): NodeEstimate | null {
  const entry = entryForRoute(priceEntry, routeProvider);
  if (!entry) return null;
  // A route's entry was picked by its key, which the pricing check ties to
  // the provider that bills it (a route-table node keys by route id).
  if (entry === priceEntry && entry.provider && routeProvider && entry.provider !== routeProvider) return null;
  const priced = pricedKeys(entry);
  const ports = [...wired];
  const aware = wireAwareKeys(entry);
  if (ports.some((port) => priced.has(port) && !aware.has(port))) return null;
  const values = priceValues(entry, definition, params, ports);
  if (RUN_TIME_VARIABLES.some((key) => priced.has(key))) {
    const measured = awaitsInput(entry) ? sizedQuantities(entry, values, size) : null;
    if (!measured) return null;
    Object.assign(values, measured);
  }
  const row = (entry.rows ?? []).find((candidate) => matches(values, candidate.match));
  if (!row) return null;
  const base = bounds(row.price);
  if (!base) return null;
  let [low, high] = base;
  for (const extra of entry.extras ?? []) {
    const extraBounds = bounds(extra.price);
    if (extraBounds && matches(values, extra.match)) {
      low += extraBounds[0];
      high += extraBounds[1];
    }
  }
  let factor = 1;
  for (const key of entry.multiplyBy ?? []) {
    // Absent (no param, no default) counts once. A value that is there but
    // unreadable leaves the run unpriced, never one unit.
    if (values[key] === undefined) continue;
    const amount = multiplier(values[key]);
    if (amount === null) return null;
    factor *= amount;
  }
  const result: NodeEstimate = { currency: entry.currency, low: low * factor, high: high * factor };
  if (entry.plus) result.plus = String(entry.plus);
  return result;
}

/* Money, written the one way Nebula writes it (PR #198 review 2, L4). The
 * backend's services/money.py is the same code: both read the table in
 * contracts/fixtures/money/cases.json, so neither side can drift.
 * Rounding is spelled out (half up on the binary value) instead of left to
 * toFixed, so Python and JavaScript agree on every amount. Negative and
 * non-finite amounts are nothing: a cost or a spend is a sum of prices, and
 * the only way below zero is float noise from a subtraction (a limit minus
 * what was used), where "nothing left" is the true reading ("$-0.00" never
 * shows). Amounts above CEILING_USD read as more than it (PR #198 review 5,
 * N4: past it, a float's whole dollars are written as an exponent, and
 * money.py's cents overflow), on both sides. */

/** An amount that can be shown: a finite, positive number, else 0. */
function clampUsd(amount: unknown): number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
}

const halfUp = (value: number): number => Math.floor(value + 0.5);

const grouped = (whole: number): string => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function centsText(cents: number): string {
  return `$${grouped(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** An amount rounded the way formatUsd shows it: the rounded value and how
 * many decimals its text has (two significant figures under $0.10, cents
 * under $10, whole dollars from $10). */
interface RoundedUsd { value: number; decimals: number }

/** The smallest amount formatUsd writes in figures: below it, "<$0.000001"
 * (money.py TINY_USD; PR #198 review 3, L5: two significant figures of a
 * float denormal are 324 decimals, past what toFixed can write). */
const TINY_USD = 0.000001;
const UNDER_TINY = '<$0.000001';

function roundUsd(amount: number): RoundedUsd {
  const value = clampUsd(amount);
  if (value === 0) return { value: 0, decimals: 0 };
  if (value < 0.1) {
    const exponent = Math.floor(Math.log10(value));
    const decimals = 1 - exponent;
    const scale = 10 ** decimals;
    const rounded = halfUp(value * scale) / scale;
    if (rounded < 0.1) {
      // "0.040" is "0.04": a trailing zero is dropped, as money.py does.
      const text = rounded.toFixed(decimals).replace(/0+$/, '');
      return { value: rounded, decimals: text.split('.')[1]?.length ?? 0 };
    }
  }
  const cents = halfUp(value * 100);
  if (cents < 1000) return { value: cents / 100, decimals: 2 };
  return { value: halfUp(value), decimals: 0 };
}

function roundedText({ value, decimals }: RoundedUsd): string {
  if (value === 0) return '$0';
  if (decimals === 0) return `$${grouped(value)}`;
  if (value >= 0.1) return centsText(Math.round(value * 100));
  return `$${value.toFixed(decimals)}`;
}

/** "$0.0047", "$0.04", "$0.10", "$1.20", "$12", "$1,235": a price, a limit
 * or a cost in a line. Two significant figures under a dime, cents under
 * $10, whole dollars from $10, picked from the rounded value ($0.0995 is
 * "$0.10", $9.996 is "$10"). "$0" only for nothing (money.py usd_amount). */
export function formatUsd(amount: number): string {
  const value = clampUsd(amount);
  if (value > CEILING_USD) return OVER_CEILING_USD;
  if (value > 0 && value < TINY_USD) return UNDER_TINY;
  return roundedText(roundUsd(amount));
}

/** How many decimals two significant figures of `value` (under a dime) take. */
function twoFigureDecimals(value: number): number {
  return Math.max(0, 1 - Math.floor(Math.log10(value)));
}

/** Two rounded ends, the same number of decimals when both are under a dime
 * ("$0.010–0.015", never "$0.01–0.015"), but never more than two
 * significant figures on either ("$0.0099–0.010", never "$0.0099–0.0100";
 * review 3, N3); null when they read the same. An end under TINY_USD reads
 * as formatUsd writes it. */
function rangeEnds(low: number, high: number): [string, string] | null {
  if (clampUsd(low) > 0 && clampUsd(low) < TINY_USD) return clampUsd(high) < TINY_USD ? null : [UNDER_TINY, formatUsd(high)];
  const from = roundUsd(low);
  const to = roundUsd(high);
  if (from.value === to.value) return null;
  if (from.value > 0 && from.value < 0.1 && to.value < 0.1) {
    const decimals = Math.max(from.decimals, to.decimals);
    return [`$${from.value.toFixed(Math.min(decimals, twoFigureDecimals(from.value)))}`,
      `$${to.value.toFixed(Math.min(decimals, twoFigureDecimals(to.value)))}`];
  }
  return [roundedText(from), roundedText(to)];
}

/** A detail line's estimate (the Run button's title, the cost confirm, the
 * provider switcher's rows): "$0.04" for an exact price, "$0.0047–$0.43"
 * for a range, each end written in full with its exact figure (GM, PR #198
 * r6 item 3). Chips write their own form (chipEstimate). A high end that
 * isn't a number, or is under the low end, says nothing of its own: the low
 * end alone (PR #198 review 4, L2: never "$0.02–0.00" or "$0.05–0.02"). */
export function formatUsdRange(low: number, high: number): string {
  if (typeof high !== 'number' || !Number.isFinite(high) || clampUsd(high) < clampUsd(low)) return formatUsd(low);
  if (clampUsd(low) > CEILING_USD) return OVER_CEILING_USD;
  if (clampUsd(high) > CEILING_USD) return `${formatUsd(low)}–${OVER_CEILING_USD}`;
  const ends = rangeEnds(low, high);
  return ends ? `${ends[0]}–${ends[1]}` : formatUsd(high);
}

/** What was spent, to the cent ("$3.40", "$1,234.50", "$0.00" for nothing).
 * A non-zero amount that rounds to no cents is "<$0.01": "$0.00" only ever
 * means nothing (GM, PR #198 r1 item 6; money.py usd_spent). */
export function formatSpentUsd(amount: number): string {
  const value = clampUsd(amount);
  if (value > CEILING_USD) return OVER_CEILING_SPENT_USD;
  const cents = halfUp(value * 100);
  if (cents === 0) return value > 0 ? CHIP_UNDER_FLOOR : '$0.00';
  return centsText(cents);
}

/** A chip's smallest amount (GM, PR #198 r1 item 6): "$0" only ever means
 * free, so a non-zero amount under a cent reads "<$0.01" on a chip, and its
 * tooltip says "under $0.01" / "less than $0.01". Detail lines keep
 * formatUsd's figures. */
export const CHIP_FLOOR_USD = 0.01;
export const CHIP_UNDER_FLOOR = '<$0.01';

/** What a chip shows, worked out once for its label and its tooltip, which
 * say the same figures (PR #198 review 4, L2). GM, r4: "chips never show
 * sub-cent precision": every figure is to the cent under $10 and in whole
 * dollars from $10 (chipUsd), and a range has the same decimals on both
 * ends ("$9.50–12.00", never "$9.50–12").
 * - `free`: "~$0" ($0 known; "$0 + unpriced" when open);
 * - `under`: a non-zero amount under a cent, "<$0.01";
 * - `upTo`: a range whose low end is under a cent, $0 included, "Up to
 *   $0.43" (GM r4, and r6 item 2 for $0);
 * - `exact`: one figure, "~$0.04" ("$0.04 + unpriced" when open);
 * - `range`: two figures, "$0.05–0.43". A range whose ends read the same is
 *   one figure.
 * - `over`: a high end past CEILING_USD, ">$10,000,000,000,000" (review 5, N4).
 * `open`: part of the run has no known price (runScope's `unpriced`) or a
 * priced node's estimate leaves a cost out (`plus`), so the real total can
 * be higher: the label adds " + unpriced" (GM r6, UNPRICED_SUFFIX). */
export type ChipEstimate =
  | { kind: 'free' | 'under' | 'over'; open: boolean }
  | { kind: 'exact' | 'upTo'; amount: string; open: boolean }
  | { kind: 'range'; low: string; high: string; open: boolean };

/** A chip's figure (GM, PR #198 r4: never sub-cent): cents under $10,
 * whole dollars from $10, from the rounded value ($9.996 is "$10"); with
 * `cents`, cents at any size ("$12.00", for the other end of a range from
 * under $10). An amount under a cent is never written: callers say "<$0.01". */
function chipUsd(amount: number, cents = false): string {
  const value = clampUsd(amount);
  const rounded = halfUp(value * 100);
  if (rounded === 0) return '$0';
  return rounded < 1000 || cents ? centsText(rounded) : `$${grouped(halfUp(value))}`;
}

/** Whether a chip writes `amount` in cents (under $10 once rounded). */
const inCents = (amount: number) => halfUp(clampUsd(amount) * 100) < 1000;

export function chipEstimate(low: number, high: number, open: boolean): ChipEstimate {
  // A high end that isn't a number (NaN, Infinity) has no price: the chip
  // reads its low end with the rest unknown, never "~$0" (review 3, L5:
  // "$0" only ever means free).
  if (typeof high !== 'number' || !Number.isFinite(high)) {
    return chipEstimate(low, clampUsd(low), true);
  }
  const bottom = clampUsd(low);
  // A high end under the low end says nothing of its own: the low end alone,
  // as formatUsdRange reads it (review 5, N3: never "~$0" for 0.43 to -1).
  const top = Math.max(clampUsd(high), bottom);
  if (top > CEILING_USD) return { kind: 'over', open };
  if (top === 0) return { kind: 'free', open };
  if (top < CHIP_FLOOR_USD) return { kind: 'under', open };
  // GM, r4: a range whose low end is under a cent is "Up to $Y" (its low end
  // has no figure a chip can write), whatever $Y is; r6 item 2: from $0 too.
  if (bottom < CHIP_FLOOR_USD) return { kind: 'upTo', amount: chipUsd(top), open };
  const cents = inCents(bottom) || inCents(top);
  const from = chipUsd(bottom, cents);
  const to = chipUsd(top, cents);
  if (halfUp(bottom * 100) === halfUp(top * 100) || (!cents && halfUp(bottom) === halfUp(top))) {
    return { kind: 'exact', amount: chipUsd(top), open };
  }
  return { kind: 'range', low: from, high: to, open };
}

/** A chip's estimate: "~$0.04", "<$0.01", "Up to $0.43", "$0.04–0.05",
 * with " + unpriced" when part of it has no known price (`open`). Shared by
 * the Run chips (runScope) and the proposal card (canvasProposals). */
export function formatChipEstimate(low: number, high: number, open: boolean): string {
  return chipLabel(chipEstimate(low, high, open));
}

export function chipLabel(chip: ChipEstimate): string {
  const more = chip.open ? UNPRICED_SUFFIX : '';
  switch (chip.kind) {
    case 'free': return chip.open ? `$0${more}` : '~$0';
    case 'under': return `${CHIP_UNDER_FLOOR}${more}`;
    case 'over': return `${OVER_CEILING_USD}${more}`;
    case 'exact': return chip.open ? `${chip.amount}${more}` : `~${chip.amount}`;
    case 'upTo': return `Up to ${chip.amount}${more}`;
    case 'range': return `${chip.low}–${chip.high.replace(/^\$/, '')}${more}`;
  }
}

/** A chip's tooltip, from the same figures as its label.
 * Closed (GM - Design, r18 of PR #114, r1 to r4 of PR #198): "~$0" and "~$X"
 * read "Estimated cost"; "<$0.01" "Estimated cost under $0.01"; a range
 * "Between $X and $Y."; "Up to $Y" "Up to $Y.".
 * Open ("+ unpriced"): the priced part's sentence (GM r7 item 3,
 * unpricedCopy PRICED_PART), "The priced part of this run costs up to
 * $0.43."; the Run chips add a sentence per reason (runScope runChipTitle). */
export function chipTitle(chip: ChipEstimate): string {
  if (chip.open) {
    switch (chip.kind) {
      case 'free': return PRICED_PART.free;
      case 'under': return PRICED_PART.under;
      case 'over': return PRICED_PART.over;
      case 'exact': return PRICED_PART.exact(chip.amount);
      case 'upTo': return PRICED_PART.upTo(chip.amount);
      case 'range': return PRICED_PART.range(chip.low, chip.high);
    }
  }
  switch (chip.kind) {
    case 'free': return 'Estimated cost';
    case 'under': return 'Estimated cost under $0.01';
    case 'over': return OVER_TITLE;
    case 'exact': return 'Estimated cost';
    case 'upTo': return `Up to ${chip.amount}.`;
    case 'range': return `Between ${chip.low} and ${chip.high}.`;
  }
}

/** {route id: the estimate on that route, or null} for a route-table node:
 * what each row of the provider switcher shows at these params. Null when
 * the route can't take the run (routeBlock) or has no list price. Keys don't
 * matter here: a row shows its price whether or not its key is set
 * (model_pricing.estimate_routes). */
export function estimateRoutes(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  wired: Iterable<string> | ReadonlyMap<string, number> = [],
  pricing?: PricingTable | null,
): Record<string, NodeEstimate | null> {
  if (!hasRoutes(definition)) return {};
  const entry = pricing?.nodes[definition.id];
  const routed = withWiredBlockers(definition, params, wired);
  const ports = wired instanceof Map ? [...wired.keys()] : [...(wired as Iterable<string>)];
  const estimates: Record<string, NodeEstimate | null> = {};
  for (const route of routesOf(definition)) {
    estimates[route.id] = routeBlock(definition, route, routed)
      ? null
      : estimateNode(entry, definition, params, route.pricing ?? route.id, ports);
  }
  return estimates;
}

/** A route's price that its provider's page doesn't state exactly (its
 * entry's `unconfirmed`), or, at these params (the defaults when left out),
 * the row they price at says so (FLUX.2's Flash and Klein on fal);
 * model_pricing.route_price_unconfirmed. */
export function routePriceUnconfirmed(
  definition: ModelNodeDefinition,
  routeId: string,
  pricing?: PricingTable | null,
  params?: Record<string, unknown>,
  wired: Iterable<string> = [],
): boolean {
  const spec = routeById(definition, routeId);
  if (!spec) return false;
  const entry = entryForRoute(pricing?.nodes[definition.id], spec.pricing ?? spec.id);
  if (!entry) return false;
  if (entry.unconfirmed === true) return true;
  const values = priceValues(entry, definition, params, [...wired]);
  return (entry.rows ?? []).find((candidate) => matches(values, candidate.match))?.unconfirmed === true;
}
