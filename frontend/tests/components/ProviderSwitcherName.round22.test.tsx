import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { usePricingStore } from '../../src/store/pricingStore';
import type { ModelNodeDefinition } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

// GM's open flag (PR #203 r20 item 3): the switcher's accessible description still named the node's
// type ("FLUX 3 Image") on a node the person renamed. Its stop line already named the node's own name.
const FLUX3 = NODE_DEFINITIONS['flux-3-image'] as ModelNodeDefinition;
beforeEach(() => usePricingStore.setState({ table: (pricingCases as unknown as { pricing: never }).pricing, loading: false }));
afterEach(cleanup);

const descriptionOf = () => {
  const trigger = screen.getByRole('button', { name: /Auto|fal|Replicate|BFL|FLUX|Black/i });
  return document.getElementById(trigger.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
};

describe('the provider switcher names the node by its own name', () => {
  it('a renamed node: its name, never its type', () => {
    render(<ProviderSwitcher definition={FLUX3} params={{}} variant="chip" label="Hero shot" onPick={() => {}} />);
    expect(descriptionOf()).toMatch(/^Provider for “Hero shot”: /);
    expect(descriptionOf()).not.toContain('FLUX 3 Image');
  });

  it('a node still on its type name, or with none, keeps the type name', () => {
    render(<ProviderSwitcher definition={FLUX3} params={{}} variant="chip" label={FLUX3.displayName} onPick={() => {}} />);
    expect(descriptionOf()).toMatch(/^Provider for “FLUX 3 Image”: /);
  });
});
