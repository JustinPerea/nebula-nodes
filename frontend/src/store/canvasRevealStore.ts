import { create } from 'zustand';

/**
 * Whether the canvas is still holding a whole graph back or waiting for its
 * fit (components/Canvas.tsx, lib/cardHold.ts). The zoom readout in the
 * toolbar hides its number meanwhile, so it never shows 100% for a graph
 * that is about to be fitted to another value.
 */
interface CanvasRevealState {
  covered: boolean;
  setCovered: (covered: boolean) => void;
}

export const useCanvasRevealStore = create<CanvasRevealState>((set) => ({
  covered: false,
  setCovered: (covered) => set((state) => (state.covered === covered ? state : { covered })),
}));
