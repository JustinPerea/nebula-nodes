import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { useUIStore } from '../../src/store/uiStore';
import { usePricingStore } from '../../src/store/pricingStore';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import type { ModelNodeDefinition } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

/**
 * Design: the Idol card's provider chip names where the run happens, never the maker (an id cut
 * off by an ellipsis): "Auto · free" with no token, "Auto · Hugging Face" (short "Auto · HF" in
 * the chip, the full name in its title and accessible name) on the person's token, "Hugging Face"
 * when the route is picked. Other nodes' chips do not change.
 */
const IDOL = NODE_DEFINITIONS['speridlabs-idol'];
const BFL = (pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions.table;
const TOKEN = 'fixture-only';
const context = (apiKeys: Record<string, string>) => ({ apiKeys, kreaSignedIn: false });

let previousUi: ReturnType<typeof useUIStore.getState>;
beforeEach(() => {
  previousUi = useUIStore.getState(); useUIStore.setState({ skin: 'slava-restraint' });
  usePricingStore.setState({ table: (pricingCases as unknown as { pricing: never }).pricing, loading: false });
});
afterEach(() => { cleanup(); useUIStore.setState(previousUi, true); usePricingStore.setState({ table: null, loading: false }); });

describe('providerSwitchState, Idol chip', () => {
  it('Auto without a token: "Auto · free", in full', () => {
    const state = providerSwitchState(IDOL, {}, context({}));
    expect([state.chip, state.chipName]).toEqual(['Auto · free', 'Auto · free']);
  });
  it('Auto with a token: "Auto · HF" in the chip, "Auto · Hugging Face" in full', () => {
    const state = providerSwitchState(IDOL, {}, context({ HF_TOKEN: TOKEN }));
    expect([state.chip, state.chipName]).toEqual(['Auto · HF', 'Auto · Hugging Face']);
  });
  it('the route picked: "Hugging Face", with or without the token', () => {
    for (const keys of [{}, { HF_TOKEN: TOKEN }]) {
      const state = providerSwitchState(IDOL, { _provider: 'hf-space' }, context(keys));
      expect([state.chip, state.chipName]).toEqual(['Hugging Face', 'Hugging Face']);
    }
  });
  it('never names the maker', () => {
    for (const params of [{}, { _provider: 'hf-space' }]) for (const keys of [{}, { HF_TOKEN: TOKEN }]) {
      const state = providerSwitchState(IDOL, params, context(keys));
      expect(`${state.chip} ${state.chipName}`).not.toMatch(/sperid/i);
    }
  });
  it('another node is untouched: a maker route still reads "Auto · BFL" and picked "BFL"', () => {
    const auto = providerSwitchState(BFL, {}, context({ BFL_API_KEY: TOKEN }));
    expect([auto.chip, auto.chipName]).toEqual(['Auto · BFL', 'Auto · Black Forest Labs']);
    const picked = providerSwitchState(BFL, { _provider: 'bfl' }, context({ BFL_API_KEY: TOKEN }));
    expect([picked.chip, picked.chipName]).toEqual(['BFL', 'Black Forest Labs']);
  });
});

describe('the Idol chip as it renders: title and accessible name', () => {
  const chipFor = (params: Record<string, unknown>, apiKeys: Record<string, string>) => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys } });
    render(<ProviderSwitcher definition={IDOL} params={params} variant="chip" onPick={() => {}} />);
    const button = screen.getByRole('button');
    const hint = document.getElementById(button.getAttribute('aria-describedby')!)!;
    return { text: button.textContent, title: button.getAttribute('title'), described: hint.textContent };
  };
  it.each([
    ['Auto, no token', {}, {}, 'Auto · free', 'Runs on Auto · free. Change provider', 'Provider for “Idol”: Auto · free'],
    ['Auto, token', {}, { HF_TOKEN: TOKEN }, 'Auto · HF', 'Runs on Auto · Hugging Face. Change provider',
      'Provider for “Idol”: Auto · Hugging Face'],
    ['picked', { _provider: 'hf-space' }, {}, 'Hugging Face', 'Runs on Hugging Face. Change provider',
      'Provider for “Idol”: Hugging Face'],
  ])('%s', (_name, params, keys, text, title, described) => {
    expect(chipFor(params, keys)).toEqual({ text, title, described });
  });
});
