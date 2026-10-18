import { describe, expect, it } from 'vitest';
import { BILLING_PARAMS, BILLING_PARAM_LABELS, isRecipeParam, providerChoiceLabel } from '../../src/lib/billingParams';

describe('billing params', () => {
  it('are the backend list (node_route.BILLING_PARAMS), each with a label', () => {
    expect(BILLING_PARAMS).toEqual(['_provider', '_kreaAuth']);
    for (const key of BILLING_PARAMS) expect(BILLING_PARAM_LABELS[key]).toBeTruthy();
  });

  it('are the only underscore keys a recipe keeps', () => {
    expect(isRecipeParam('prompt')).toBe(true);
    expect(isRecipeParam('_provider')).toBe(true);
    expect(isRecipeParam('_kreaAuth')).toBe(true);
    expect(isRecipeParam('_variant')).toBe(false);
  });

  it('reads an unset provider choice as Auto', () => {
    for (const value of [undefined, null, '', 'auto']) expect(providerChoiceLabel(value)).toBe('Auto');
    expect(providerChoiceLabel('bfl')).toBe('bfl');
  });
});
