import { AUTO, BILLING_PARAMS, PROVIDER_PARAM } from './directRoute';

/** Who bills a run: a route-table node's provider choice (`_provider`) and a
 * Krea node's billing mode (`_kreaAuth`), backend node_route.BILLING_PARAMS.
 * They're recipe data, so results, presets and Create keep them, while every
 * other underscore key is private runtime state and is dropped. Only the
 * person changes them; an agent proposes the change
 * (backend main._refuse_agent_billing_change). */
export { BILLING_PARAMS };

export function isBillingParam(key: string): boolean {
  return BILLING_PARAMS.includes(key);
}

/** A param a recipe keeps: any public param, plus who bills the run. */
export function isRecipeParam(key: string): boolean {
  return !key.startsWith('_') || isBillingParam(key);
}

/** How the person reads each billing param's name. */
export const BILLING_PARAM_LABELS: Readonly<Record<string, string>> = {
  [PROVIDER_PARAM]: 'Provider',
  _kreaAuth: 'Krea access',
};

/** A provider choice as the person reads it: "Auto" or the route id. */
export function providerChoiceLabel(value: unknown): string {
  return value === undefined || value === null || value === '' || value === AUTO ? 'Auto' : String(value);
}
