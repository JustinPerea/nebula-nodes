import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';

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
): ParamDefinition[] {
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  return sources
    .filter((p) => !p.hidden)
    .filter((p) => matchesVisibleWhen(p.visibleWhen, params))
    .map((p) => ({
      ...p,
      options: p.options?.filter((o: ParamOption) => matchesVisibleWhen(o.visibleWhen, params)),
    }));
}

export function buildDefaultParamsForUi(def: ModelNodeDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  for (const p of sources) {
    if (p.default !== undefined) defaults[p.key] = p.default;
  }
  return defaults;
}
