import type { ModelNodeDefinition, ParamDefinition } from '../types';

/**
 * Per-value defaults (ParamDefinition.defaultBy). A param such as Max Tokens
 * can default differently for some models: `default: 64000` with
 * `defaultBy: { model: { 'claude-sonnet-4-6': 4096 } }`. `default` covers every
 * value not listed, including the model param's own default
 * (scripts/check-node-contracts.mjs), so code that fills `default` into a new
 * node stays right for the model it starts on.
 *
 * The canvas stores every default in node.params, so a default is a saved
 * value. When the controlling param changes, the dependent value moves to the
 * new default only while it still holds the old one; a value someone edited
 * stays. The backend handlers use the same table when the value is missing
 * (backend/services/param_defaults.py).
 */

function paramSources(def: ModelNodeDefinition): ParamDefinition[] {
  return def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
}

function controlling(param: ParamDefinition): [string, Record<string, unknown>] | null {
  const entries = Object.entries(param.defaultBy ?? {});
  return entries.length === 1 ? entries[0] : null;
}

function currentValue(sources: ParamDefinition[], params: Record<string, unknown>, key: string): unknown {
  const value = params[key];
  if (value !== undefined && value !== null && value !== '') return value;
  return sources.find((candidate) => candidate.key === key)?.default;
}

/** The default `param` has for the other values in `params`. */
export function paramDefaultFor(
  def: ModelNodeDefinition,
  param: ParamDefinition,
  params: Record<string, unknown>,
): unknown {
  const rule = controlling(param);
  if (!rule) return param.default;
  const [key, table] = rule;
  const value = currentValue(paramSources(def), params, key);
  const byValue = value === undefined ? undefined : table[String(value)];
  return byValue !== undefined ? byValue : param.default;
}

/** `params` for a new node, with each per-value default resolved for the
 * values it was created with. Keys in `given` were set on purpose and stay. */
export function withParamDefaults(
  def: ModelNodeDefinition,
  params: Record<string, unknown>,
  given: Record<string, unknown> = {},
): Record<string, unknown> {
  let next = params;
  for (const param of paramSources(def)) {
    if (!param.defaultBy || param.key in given) continue;
    const value = paramDefaultFor(def, param, params);
    if (value === undefined || next[param.key] === value) continue;
    if (next === params) next = { ...params };
    next[param.key] = value;
  }
  return next;
}

export interface DefaultSnapNote {
  /** The param whose value moved or stayed. */
  param: string;
  text: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || a === '') return b === undefined || b === null || b === '';
  return String(a) === String(b);
}

function formatValue(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
}

function optionName(sources: ParamDefinition[], key: string, value: unknown): string {
  const label = sources.find((candidate) => candidate.key === key)?.options
    ?.find((option) => String(option.value) === String(value))?.label;
  // "Claude Fable 5.1 (flagship)" -> "Claude Fable 5.1": the status suffix isn't the name.
  return (label ?? String(value)).replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * Apply a param edit from the Inspector or a Create pill. When the edit
 * changes a param another one defaults by (the model), that one moves to the
 * new default if it still equals the old default, and a note says what
 * happened either way. Pure.
 */
export function snapParamDefaults(
  def: ModelNodeDefinition,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { params: Record<string, unknown>; notes: DefaultSnapNote[] } {
  const sources = paramSources(def);
  const notes: DefaultSnapNote[] = [];
  let params = next;
  for (const param of sources) {
    const rule = controlling(param);
    if (!rule) continue;
    const [key] = rule;
    if (sameValue(currentValue(sources, previous, key), currentValue(sources, next, key))) continue;
    const before = paramDefaultFor(def, param, previous);
    const after = paramDefaultFor(def, param, next);
    if (sameValue(before, after)) continue;
    const name = optionName(sources, key, currentValue(sources, next, key));
    const held = previous[param.key];
    // Already at the new default (a saved value, or one set by hand): nothing moved, nothing to say.
    if (!(held === undefined || held === null || held === '') && sameValue(held, after)) continue;
    if (held === undefined || held === null || held === '' || sameValue(held, before)) {
      if (params === next) params = { ...next };
      params[param.key] = after;
      notes.push({ param: param.key, text: `${param.label} moved to ${formatValue(after)}, the ${name} default.` });
    } else {
      notes.push({
        param: param.key,
        text: `${param.label} stays at ${formatValue(held)}, the value you set. The ${name} default is ${formatValue(after)}.`,
      });
    }
  }
  return { params, notes };
}
