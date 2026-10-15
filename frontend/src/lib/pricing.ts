import type { ModelNodeDefinition } from '../types';
import { allParamDefinitions, hasRoutes, routeBlock, routeById, routesOf, withWiredBlockers } from './directRoute';

/** One curated price entry from backend/data/model_pricing.json. The format
 * and its rules live in backend/services/model_pricing.py; this file mirrors
 * that estimate, and both are tested against the same shared cases. */
export type PriceValue = number | [number, number];

export interface PriceRow { match?: Record<string, unknown>; price: PriceValue }

export interface PriceEntry {
  currency: string;
  per: 'image' | 'video' | 'second' | 'request' | 'megapixel-second';
  rows: PriceRow[];
  /** A node that can run on more than one provider prices each route on its
   * own: provider -> a single-route entry (model_pricing.py). The run prices
   * the route it bills (lib/directRoute.ts selectRoute). */
  routes?: Record<string, PriceEntry>;
  generatedBy?: string;
  extras?: PriceRow[];
  multiplyBy?: string[];
  defaults?: Record<string, unknown>;
  provider?: string;
  plus?: string;
  /** The provider's page doesn't state this price exactly (a higher page
   * price kept until the exact one is published); the switcher marks it "*". */
  unconfirmed?: boolean;
  notes?: string;
  sources?: Array<{ url: string; quote: string }>;
  checked?: string;
}

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
/** Price variables known only once the run's source clip is (its length,
 * its output frame size): an entry that reads one is unpriced before the run
 * (model_pricing.RUN_TIME_VARIABLES). */
export const RUN_TIME_VARIABLES: readonly string[] = ['(source seconds)', '(output megapixels)', '(output tier)'];

/** A video run's mode from its wired ports (VIDEO_MODE); a source video wins. */
export function videoMode(wired: Iterable<string>): 't2v' | 'i2v' | 'v2v' {
  const ports = new Set(wired);
  if (ports.has('start_video')) return 'v2v';
  return IMAGE_PORTS.some((port) => ports.has(port)) ? 'i2v' : 't2v';
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

/** One run of this node, or null when it's unpriced (no entry, no matching
 * row, the run bills a different provider than the entry prices, a setting
 * the price reads arrives by wire, so it's only known at run time, or the
 * price reads a RUN_TIME_VARIABLES quantity). The wired ports also give the
 * VIDEO_MODE a row may match. A `routes` entry prices the route
 * `routeProvider` names. */
export function estimateNode(
  priceEntry: PriceEntry | undefined,
  definition: Partial<ModelNodeDefinition>,
  params: Record<string, unknown> | undefined,
  routeProvider?: string | null,
  wired: Iterable<string> = [],
): NodeEstimate | null {
  const entry = entryForRoute(priceEntry, routeProvider);
  if (!entry) return null;
  // A route's entry was picked by its key, which the pricing check ties to
  // the provider that bills it (a route-table node keys by route id).
  if (entry === priceEntry && entry.provider && routeProvider && entry.provider !== routeProvider) return null;
  const priced = pricedKeys(entry);
  const ports = [...wired];
  if (ports.some((port) => priced.has(port)) || RUN_TIME_VARIABLES.some((key) => priced.has(key))) return null;
  const values = effectiveParams(entry, definition, params);
  if (priced.has(VIDEO_MODE)) values[VIDEO_MODE] = videoMode(ports);
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

/** "$0.0047", "$0.04", "$0.10", "$1.20", "$12". Cents from a dime up,
 * two significant figures below it so sub-cent prices stay readable. */
export function formatUsd(amount: number): string {
  if (amount <= 0) return '$0';
  if (amount >= 10) return `$${Math.round(amount)}`;
  if (amount >= 0.1) return `$${amount.toFixed(2)}`;
  return `$${Number(amount.toPrecision(2))}`;
}

/** "$0.04" for an exact price, "$0.0047–0.43" for a range. */
export function formatUsdRange(low: number, high: number): string {
  if (formatUsd(low) === formatUsd(high)) return formatUsd(high);
  return `${formatUsd(low)}–${formatUsd(high).slice(1)}`;
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
 * entry's `unconfirmed`; model_pricing.route_price_unconfirmed). */
export function routePriceUnconfirmed(definition: ModelNodeDefinition, routeId: string, pricing?: PricingTable | null): boolean {
  const spec = routeById(definition, routeId);
  if (!spec) return false;
  return entryForRoute(pricing?.nodes[definition.id], spec.pricing ?? spec.id)?.unconfirmed === true;
}
