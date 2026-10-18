import { create } from 'zustand';

/** The one line a card shows after a person's provider switch moved a value
 * the new route doesn't take ("1.5k isn't on fal.ai: set to 2k";
 * lib/providerSwitch.ts snapForRoute). Per node, in memory only: it says
 * what a click just did, so it isn't saved with the graph. */
interface ProviderNoteState {
  notes: Record<string, string>;
  show: (nodeId: string, notes: string[]) => void;
  dismiss: (nodeId: string) => void;
}

export const useProviderNoteStore = create<ProviderNoteState>((set) => ({
  notes: {},
  show: (nodeId, notes) => set((state) => {
    const next = { ...state.notes };
    if (notes.length) next[nodeId] = notes.join('. ');
    else delete next[nodeId];
    return { notes: next };
  }),
  dismiss: (nodeId) => set((state) => {
    if (!(nodeId in state.notes)) return state;
    const next = { ...state.notes };
    delete next[nodeId];
    return { notes: next };
  }),
}));
