import { create } from 'zustand';
import { apiFetch } from '../lib/backend';
import type { PricingTable } from '../lib/pricing';

interface PricingState {
  /** The curated list prices, or null until loaded (or when unavailable). */
  table: PricingTable | null;
  loading: boolean;
  load: () => Promise<void>;
}

function readTable(value: unknown): PricingTable {
  const data = value as Partial<PricingTable> | null;
  if (!data || typeof data !== 'object' || !data.nodes || typeof data.nodes !== 'object' || Array.isArray(data.nodes)) {
    throw new Error('Invalid pricing table');
  }
  return { currencies: data.currencies ?? {}, nodes: data.nodes };
}

/** Prices ship with the app and only change on upgrade, so one fetch per
 * session is enough. A failed fetch leaves the table empty: Run then counts
 * paid nodes without a price rather than guessing one. */
export const usePricingStore = create<PricingState>((set, get) => ({
  table: null,
  loading: false,
  load: async () => {
    if (get().table || get().loading) return;
    set({ loading: true });
    try {
      const response = await apiFetch('/api/pricing');
      if (!response.ok) throw new Error(`Pricing unavailable: ${response.status}`);
      set({ table: readTable(await response.json()), loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
