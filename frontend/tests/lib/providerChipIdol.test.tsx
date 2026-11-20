import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { providerSwitchState, routeDisplayName } from '../../src/lib/providerSwitch';
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
const KREA = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-krea'];
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
    ['Auto, no token', {}, {}, 'Auto · free', 'Auto runs it free on Hugging Face. Change provider', 'Provider for “Idol”: Auto · free'],
    ['Auto, token', {}, { HF_TOKEN: TOKEN }, 'Auto · HF', 'Auto runs it on Hugging Face with your token. Change provider',
      'Provider for “Idol”: Auto · Hugging Face'],
    ['picked', { _provider: 'hf-space' }, {}, 'Hugging Face', 'Runs on Hugging Face. Change provider',
      'Provider for “Idol”: Hugging Face'],
  ])('%s', (_name, params, keys, text, title, described) => {
    expect(chipFor(params, keys)).toEqual({ text, title, described });
  });
});

describe('the chip title and the route names a person picks from (design)', () => {
  it('Auto on a route names the provider in full', () => {
    expect(providerSwitchState(BFL, {}, context({ BFL_API_KEY: TOKEN })).title)
      .toBe('Auto runs it on Black Forest Labs. Change provider');
  });
  it('Auto on Idol: free without a token, "with your token" with one', () => {
    expect(providerSwitchState(IDOL, {}, context({})).title).toBe('Auto runs it free on Hugging Face. Change provider');
    expect(providerSwitchState(IDOL, {}, context({ HF_TOKEN: TOKEN })).title)
      .toBe('Auto runs it on Hugging Face with your token. Change provider');
  });
  it('Auto on a Krea plan run', () => {
    const state = providerSwitchState(KREA, { _kreaAuth: 'mcp' }, { apiKeys: {}, kreaSignedIn: true });
    expect(state.title).toBe('Auto runs it on your Krea plan. Change provider');
  });
  it('a hand-picked route keeps "Runs on"', () => {
    expect(providerSwitchState(BFL, { _provider: 'bfl' }, context({ BFL_API_KEY: TOKEN })).title).toBe('Runs on Black Forest Labs. Change provider');
    expect(providerSwitchState(IDOL, { _provider: 'hf-space' }, context({})).title).toBe('Runs on Hugging Face. Change provider');
  });
  it('a blocked run keeps its message as the title', () => {
    const state = providerSwitchState(BFL, { resolution: '1.5k' }, context({}));
    expect(state.blocked).toBe(true);
    expect(state.title).toBe(state.message ?? undefined);
  });
  it('Idol\'s row is "Hugging Face" with its note; one helper names a route for rows and alternatives', () => {
    const state = providerSwitchState(IDOL, {}, context({}));
    expect(state.rows[1]).toMatchObject({ id: 'hf-space', label: 'Hugging Face', info: 'Free on Hugging Face.' });
    expect(providerSwitchState(IDOL, {}, context({ HF_TOKEN: TOKEN })).rows[1]).toMatchObject({ label: 'Hugging Face', info: 'Uses your Hugging Face allowance.' });
    expect(routeDisplayName(IDOL.routes?.find((r) => r.id === 'hf-space'))).toBe('Hugging Face');
    expect(routeDisplayName(BFL.routes?.find((r) => r.id === 'bfl'))).toBe('Black Forest Labs');
  });
});
