import type { ModelNodeDefinition, ParamDefinition, ParamOption } from '../types';

export function resolveCreateParamDefinitions(
  def: ModelNodeDefinition,
  apiKeys: Record<string, string> = {},
): ParamDefinition[] {
  if (!def.sharedParams) return def.params;

  const useDirectRoute = Boolean(
    def.directKeyName && apiKeys[def.directKeyName],
  );
  const routeParams = useDirectRoute
    ? (def.directParams ?? [])
    : (def.falParams ?? []);

  // Route selection should already make keys unique. Keep this defensive
  // boundary so malformed catalog data can never create duplicate React
  // controls or ambiguous request values in Create.
  const byKey = new Map<string, ParamDefinition>();
  for (const param of [...def.sharedParams, ...routeParams]) {
    byKey.set(param.key, param);
  }
  return [...byKey.values()];
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
  const sources = resolveCreateParamDefinitions(def, apiKeys);
  return sources
    .filter((p) => !p.hidden)
    .filter((p) => matchesVisibleWhen(p.visibleWhen, params))
    .map((p) => ({
      ...p,
      options: p.options?.filter((o: ParamOption) => matchesVisibleWhen(o.visibleWhen, params)),
    }));
}

export function buildDefaultParamsForUi(
  def: ModelNodeDefinition,
  apiKeys: Record<string, string> = {},
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const sources = resolveCreateParamDefinitions(def, apiKeys);
  for (const p of sources) {
    if (p.default !== undefined) defaults[p.key] = p.default;
  }
  return defaults;
}
