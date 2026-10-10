import type { ModelNodeDefinition } from '../types';

/** One curated price entry from backend/data/model_pricing.json. The format
 * and its rules live in backend/services/model_pricing.py; this file mirrors
 * that estimate, and both are tested against the same shared cases. */
export type PriceValue = number | [number, number];

export interface PriceRow { match?: Record<string, unknown>; price: PriceValue }

export interface PriceEntry {
  currency: string;
  per: 'image' | 'video' | 'second' | 'request';
  rows: PriceRow[];
  extras?: PriceRow[];
  multiplyBy?: string[];
  defaults?: Record<string, unknown>;
  provider?: string;
  plus?: string;
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

function definitionParams(definition: Partial<ModelNodeDefinition>) {
  const record = definition as Record<string, unknown>;
  return ['params', 'directParams', 'falParams'].flatMap((key) =>
    Array.isArray(record[key]) ? (record[key] as Array<{ key?: string; default?: unknown }>) : []);
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

/** One run of this node, or null when it's unpriced (no entry, no matching
 * row, or the run bills a different provider than the entry prices). */
export function estimateNode(
  entry: PriceEntry | undefined,
  definition: Partial<ModelNodeDefinition>,
  params: Record<string, unknown> | undefined,
  routeProvider?: string | null,
): NodeEstimate | null {
  if (!entry) return null;
  if (entry.provider && routeProvider && entry.provider !== routeProvider) return null;
  const values = effectiveParams(entry, definition, params);
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
    const amount = Number(values[key]);
    factor *= Number.isFinite(amount) && amount > 0 ? amount : 1;
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
