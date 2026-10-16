import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';
import { paramDefinitionsForRun, shownValues, visibleParams, visibleWhenHolds } from './directRoute';
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

/** Whether a `visibleWhen` holds for these values: directRoute.ts
 * visibleWhenHolds, the predicate the Inspector reads (a controller with no
 * value passes). */
export function matchesVisibleWhen(
  visibleWhen: Record<string, (string | number | boolean)[]> | undefined,
  params: Record<string, unknown>,
): boolean {
  return visibleWhenHolds(visibleWhen, params);
}

/** Params the composer should render as pills for the current values: the
 * same list the Inspector shows (directRoute.ts visibleParams). */
export function deriveVisibleParams(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  apiKeys: Record<string, string> = {},
): ParamDefinition[] {
  const sources = resolveCreateParamDefinitions(def, apiKeys, params);
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
