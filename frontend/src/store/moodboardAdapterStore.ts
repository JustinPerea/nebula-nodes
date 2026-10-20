import { create } from 'zustand';
import { apiFetch } from '../lib/backend';
import type { AdapterTable } from '../lib/moodboardAdapters';

interface MoodboardAdapterState {
  /** Every node's moodboard adapter entry, unresolved, or null until loaded
   * (or when unavailable). */
  entries: AdapterTable | null;
  loading: boolean;
  /** The last load failed; the next load() tries again. */
  failed: boolean;
  load: () => Promise<void>;
}

function readEntries(value: unknown): AdapterTable {
  const entries = (value as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid adapter table');
  return entries as AdapterTable;
}

/** The table ships with the app and changes only on upgrade, like prices
 * (store/pricingStore.ts), so one fetch per session. A failed fetch leaves it
 * empty and the card line says nothing rather than guess; the next card that
 * mounts tries again. */
export const useMoodboardAdapterStore = create<MoodboardAdapterState>((set, get) => ({
  entries: null,
  loading: false,
  failed: false,
  load: async () => {
    if (get().entries || get().loading) return;
    set({ loading: true });
    try {
      const response = await apiFetch('/api/moodboard/adapters');
      if (!response.ok) throw new Error(`Moodboard adapters unavailable: ${response.status}`);
      set({ entries: readEntries(await response.json()), loading: false, failed: false });
    } catch {
      set({ loading: false, failed: true });
    }
  },
}));
