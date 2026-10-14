import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';
import { paramDefinitionsForRun } from './directRoute';
import { withNewKreaMode, type KreaConnectionMode } from './kreaConnection';

/** The params Create shows for the route this run would take (lib/directRoute.ts):
 * the maker's own on a maker key, the fal or Krea copy's otherwise, and Krea's
 * when the recipe bills the Krea plan; plus a direct param the maker route
 * still needs when its key is set (seeded, so a new Ideogram Reframe on an
 * Ideogram key runs there). */
export function resolveCreateParamDefinitions(
  def: ModelNodeDefinition,
  apiKeys: Record<string, string> = {},
  params: Record<string, unknown> = {},
): ParamDefinition[] {
  return paramDefinitionsForRun(def, params, apiKeys);
}

export function matchesVisibleWhen(
  visibleWhen: Record<string, (string | number | boolean)[]> | undefined,
  params: Record<string, unknown>,
): boolean {
  if (!visibleWhen) return true;
  return Object.entries(visibleWhen).every(([key, allowed]) =>
    allowed.includes(params[key] as string | number | boolean),
  );
}

/** Params the composer should render as pills for the current values. */
export function deriveVisibleParams(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  apiKeys: Record<string, string> = {},
): ParamDefinition[] {
  const sources = resolveCreateParamDefinitions(def, apiKeys, params);
  const effectiveValues = Object.fromEntries(sources.map((p) => [p.key, params[p.key] ?? p.default]));
  return sources
    .filter((p) => !p.hidden)
    .filter((p) => matchesVisibleWhen(p.visibleWhen, { ...params, ...effectiveValues }))
    .map((p) => ({
      ...p,
      options: p.options?.filter((o: ParamOption) => matchesVisibleWhen(o.visibleWhen, { ...params, ...effectiveValues })),
    }));
}

export function buildDefaultParamsForUi(
  def: ModelNodeDefinition,
  apiKeys: Record<string, string> = {},
  kreaConnectionMode: KreaConnectionMode = 'api-token',
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const sources = resolveCreateParamDefinitions(def, apiKeys, withNewKreaMode(def, {}, kreaConnectionMode));
  for (const p of sources) {
    if (p.default !== undefined) defaults[p.key] = p.default;
  }
  return withNewKreaMode(def, defaults, kreaConnectionMode);
}
