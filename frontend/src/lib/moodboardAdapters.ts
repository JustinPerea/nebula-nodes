import type { ModelNodeDefinition } from '../types';
import { effectiveValues, envKeyNames, hasRoutes, selectRoute, withWiredBlockers } from './directRoute';

/**
 * Moodboard adapters: how a node takes a wired Nebula moodboard (moodboard
 * canvas plan section 5.7; contract 07 section 1.16). The table lives in the
 * backend (data/moodboard_adapters.json plus the generated Krea part) and is
 * served unresolved by GET /api/moodboard/adapters; this resolves an entry
 * for a node's params and route the way services/moodboard_adapters.py
 * resolve_entry does, and says on the card what the board does there.
 */

export interface AdapterSlot {
  port: string;
  max: number;
  roles?: Record<string, number>;
  sharesLimitWith?: string[];
}

export interface AdapterEntry {
  channel: string;
  default?: 'images' | 'text' | 'never';
  handler?: string;
  slots?: AdapterSlot[];
  never?: string[];
  needsWired?: string[];
  reason?: string;
  byModel?: Record<string, Partial<AdapterEntry>>;
  byRoute?: Record<string, Partial<AdapterEntry>>;
  [field: string]: unknown;
}

export type AdapterTable = Record<string, AdapterEntry>;

// What a text-only entry has no use for (moodboard_adapters.py IMAGE_FIELDS).
const IMAGE_FIELDS = ['default', 'handler', 'slots', 'needsWired', 'exclusive', 'weight', 'order', 'syntax',
  'syntaxReason', 'limits', 'requires', 'collage', 'costPerRef'];

function matches(key: string, params: Record<string, unknown>): boolean {
  const at = key.indexOf('=');
  const param = at < 0 ? key : key.slice(0, at);
  const value = at < 0 ? '' : key.slice(at + 1);
  let have = params[param];
  if (typeof have === 'boolean') have = have ? 'true' : 'false';
  return have !== undefined && have !== null && String(have) === value;
}

/** `entry` for a run with these (effective) params on `route`: `byModel`
 * overrides whose `param=value` holds, then the `byRoute` override for the
 * route, each replacing the fields it names. A text-only result drops the
 * image fields, and its former slots become never. */
export function resolveAdapterEntry(
  entry: AdapterEntry,
  params: Record<string, unknown> | undefined,
  route: string | null | undefined,
): AdapterEntry {
  const values = params ?? {};
  const { byModel, byRoute, ...rest } = entry;
  const out: AdapterEntry = structuredClone(rest);
  for (const [key, override] of Object.entries(byModel ?? {})) {
    if (override && typeof override === 'object' && matches(key, values)) Object.assign(out, structuredClone(override));
  }
  if (route && byRoute?.[route] && typeof byRoute[route] === 'object') Object.assign(out, structuredClone(byRoute[route]));
  if (out.channel === 'text-only') {
    const never = [...(out.never ?? [])];
    for (const slot of out.slots ?? []) if (!never.includes(slot.port)) never.push(slot.port);
    for (const field of IMAGE_FIELDS) delete out[field];
    if (never.length) out.never = never;
  }
  return out;
}

type ApiKeys = Readonly<Record<string, string | undefined>>;

/** The route id a run of this node takes, for `byRoute`
 * (moodboard_adapters.py run_route): null for a node with one route or when
 * no route can run it. */
export function adapterRoute(
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  wiredPorts: readonly string[],
  apiKeys: ApiKeys,
): string | null {
  if (!hasRoutes(definition) && envKeyNames(definition).length < 2) return null;
  const route = selectRoute(definition, withWiredBlockers(definition, params ?? {}, [...wiredPorts]), apiKeys);
  if (route.kind === 'unset' || route.kind === 'local') return null;
  return route.routeId ?? route.provider;
}

/** The entry for this node as its next run would read it, or null. */
export function nodeAdapterEntry(
  table: AdapterTable,
  definition: ModelNodeDefinition,
  params: Record<string, unknown> | undefined,
  route: string | null,
): AdapterEntry | null {
  const entry = table[definition.id];
  return entry ? resolveAdapterEntry(entry, effectiveValues(definition, params), route) : null;
}

/** What the board does on this node, as the card says it (plan section
 * 5.7.8; PR14 adds the switch and its copy). */
export function adapterLine(entry: AdapterEntry | null, definition: ModelNodeDefinition): string {
  if (!entry || entry.channel === 'text-only') return 'This model takes the brief as text.';
  const slot = entry.slots?.[0];
  if (entry.default === 'images' && slot) {
    const label = definition.inputPorts.find((port) => port.id === slot.port)?.label ?? slot.port;
    return `Board images: on · up to ${slot.max} to ${label}`;
  }
  return 'Board images: off · the brief goes as text';
}
