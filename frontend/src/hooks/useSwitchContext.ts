import { useEffect, useMemo } from 'react';
import type { SwitchContext } from '../lib/providerSwitch';
import { usePricingStore } from '../store/pricingStore';
import { useUIStore } from '../store/uiStore';

const NO_WIRES: ReadonlyMap<string, number> = new Map();

/** Keys, Krea sign-in and prices, as the provider switcher reads them
 * (components/nodes/ProviderSwitcher.tsx). Until Settings load, no key
 * counts as set (the Inspector's rule). */
export function useSwitchContext(wired: ReadonlyMap<string, number> = NO_WIRES): SwitchContext {
  const cache = useUIStore((state) => state.settingsCache);
  const pricing = usePricingStore((state) => state.table);
  useEffect(() => { void usePricingStore.getState().load(); }, []);
  return useMemo(() => ({
    apiKeys: cache.loaded ? cache.apiKeys : {},
    kreaSignedIn: cache.kreaConnection?.status === 'connected',
    pricing,
    wired,
  }), [cache.loaded, cache.apiKeys, cache.kreaConnection?.status, pricing, wired]);
}
