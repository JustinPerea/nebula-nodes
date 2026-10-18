import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';
import { hasRoutes, paramDefinitionsForRun, shownValues, visibleParams, visibleWhenHolds } from './directRoute';
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

/** Create's pill rule for a node without a route table: every key of the
 * `visibleWhen` must hold, and a controller with no value hides it (so an
 * option that names a direct-only param stays hidden on the fal copy). */
export function matchesVisibleWhen(
  visibleWhen: Record<string, (string | number | boolean)[]> | undefined,
  params: Record<string, unknown>,
): boolean {
  if (!visibleWhen) return true;
  return Object.entries(visibleWhen).every(([key, allowed]) =>
    allowed.includes(params[key] as string | number | boolean),
  );
}

/** Params the composer should render as pills for the current values. A
 * route-table node shows the same list the Inspector does (directRoute.ts
 * visibleParams); any other node keeps Create's own rule (matchesVisibleWhen). */
export function deriveVisibleParams(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  apiKeys: Record<string, string> = {},
): ParamDefinition[] {
  const sources = resolveCreateParamDefinitions(def, apiKeys, params);
  if (!hasRoutes(def)) {
    const effectiveValues = Object.fromEntries(sources.map((p) => [p.key, params[p.key] ?? p.default]));
    return sources
      .filter((p) => !p.hidden)
      .filter((p) => matchesVisibleWhen(p.visibleWhen, { ...params, ...effectiveValues }))
      .map((p) => ({
        ...p,
        options: p.options?.filter((o: ParamOption) => matchesVisibleWhen(o.visibleWhen, { ...params, ...effectiveValues })),
      }));
  }
  const values = shownValues(def, params, sources);
  return visibleParams(def, params, sources).map((p) => ({
    ...p,
    options: p.options?.filter((o: ParamOption) => visibleWhenHolds(o.visibleWhen, values)),
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
